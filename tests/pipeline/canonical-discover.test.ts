import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptivePortfolioPolicySchema } from "../../src/contract/candidate-selection-policy.js";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";
import {
  discoverCitationOccurrenceSchema,
  type ArtifactReference,
  type DiscoverArtifact,
  type DiscoverCitationOccurrence,
} from "../../src/contract/lean-artifacts.js";
import {
  canonicalClaimExtractionResultSchema,
  canonicalMentionHarvestResultSchema,
  CanonicalDiscoverBoundaryError,
  CanonicalDiscoverFatalError,
  buildCanonicalDiscoverArtifact,
  runCanonicalDiscover,
  type CanonicalDiscoverAdapters,
  type CanonicalDiscoverOptions,
  type CanonicalDiscoverResult,
  type CanonicalClaimCanonicalizationInput,
} from "../../src/pipeline/canonical-discover.js";
import {
  loadCanonicalArtifact,
  writeCanonicalArtifact,
} from "../../src/contract/selectors.js";

type FixtureVariant = {
  parser?: string;
  model?: string;
  firstOccurrenceOffset?: number;
  firstClaimText?: string;
  reverseFirstClaims?: boolean;
  addDifferentFirstClaim?: boolean;
  duplicateFirstClaim?: boolean;
  maxFamilies?: number;
  recordedAt?: string;
};

function artifactReference(role: string, key: string): ArtifactReference {
  return {
    artifactId: buildStableId("fixture", { role, key }),
    contentHash: canonicalSha256({ role, key }),
    role,
    uri: `fixture://${role}/${key}`,
  };
}

function externalExecution(provider: string, key: string) {
  return {
    provider,
    requestHash: canonicalSha256({ provider, key, direction: "request" }),
    requestArtifact: artifactReference("external-request", key),
    responseArtifact: artifactReference("external-response", key),
  };
}

function modelExecution(key: string, model: string) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model,
    promptId: "canonical-attributed-claim-extraction",
    promptVersion: "v1",
    promptContentHash: canonicalSha256({
      prompt: "extract all citing-side attributed claims",
    }),
    requestHash: canonicalSha256({ key, model, direction: "request" }),
    requestArtifact: artifactReference("model-request", `${key}-${model}`),
    responseArtifact: artifactReference("model-response", `${key}-${model}`),
  };
}

function citingPaper(
  paperId: string,
  availability:
    | "available"
    | "abstract_only"
    | "unavailable"
    | "unknown" = "available",
  extra: { publicationYear?: number; paperType?: string } = {},
) {
  return {
    providerRecordId: `provider-${paperId}`,
    paperId,
    title: `Citing ${paperId}`,
    doi: `10.2000/${paperId}`,
    authors: [`Author ${paperId}`],
    publicationYear: extra.publicationYear ?? 2024,
    ...(extra.paperType ? { paperType: extra.paperType } : {}),
    fullTextAvailability: availability,
    provenanceArtifacts: [artifactReference("provider-paper-record", paperId)],
  };
}

function successfulHarvest(
  paperId: string,
  mentions: Array<{
    mentionIndex: number;
    offset: number;
    citationMarker: string;
    rawContext: string;
    isBundledCitation?: boolean;
    bundleSize?: number;
    bundleRefIds?: string[];
    bundlePattern?: string;
  }>,
  parser: string,
) {
  return {
    materialization: {
      status: "succeeded" as const,
      reason: "Fixture full text materialized",
      provenanceArtifacts: [
        artifactReference("raw-full-text", paperId),
        artifactReference("parsed-full-text", `${paperId}-${parser}`),
      ],
    },
    harvest: {
      status: "succeeded" as const,
      reason: "All seed citation occurrences harvested",
      provenanceArtifacts: [
        artifactReference("mention-harvest", `${paperId}-${parser}`),
      ],
    },
    mentions: mentions.map((mention) => ({
      mentionIndex: mention.mentionIndex,
      refId: "seed-ref",
      targetRefIds: ["seed-ref"],
      charOffsetStart: mention.offset,
      charOffsetEnd: mention.offset + mention.rawContext.length,
      citationGroupOrdinal: mention.mentionIndex,
      locationQuality: "exact_dom" as const,
      citationMarker: mention.citationMarker,
      rawContext: mention.rawContext,
      sectionTitle: "Discussion",
      seedRefLabel: "Seed et al., 2020",
      isBundledCitation: mention.isBundledCitation ?? false,
      bundleSize: mention.bundleSize ?? 1,
      bundleRefIds: mention.bundleRefIds ?? ["seed-ref"],
      bundlePattern: mention.bundlePattern ?? "single",
      sourceType: "jats_xml",
      parser,
      parserVersion: "fixture-version",
      provenanceArtifacts: [
        artifactReference(
          "source-citation-occurrence",
          `${paperId}-${String(mention.mentionIndex)}-${parser}`,
        ),
      ],
    })),
  };
}

function buildFixtureAdapters(
  variant: FixtureVariant = {},
): CanonicalDiscoverAdapters {
  const parser = variant.parser ?? "fixture-parser-a";
  const model = variant.model ?? "fixture-model-a";
  const firstOffset = variant.firstOccurrenceOffset ?? 100;
  const firstClaimText =
    variant.firstClaimText ?? "The seed paper showed a measurable effect.";

  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: doi.endsWith("seed-a") ? "seed-paper-a" : "seed-paper-b",
          providerRecordId: `provider-${doi}`,
          title: `Resolved ${doi}`,
          doi,
          authors: ["Seed Author"],
          publicationYear: 2020,
        },
        execution: externalExecution("resolver", `resolve-${doi}`),
      }),
    retrieveCitingNeighborhood: ({ seed }) => {
      const isSeedA = seed.paper.paperId === "seed-paper-a";
      const papers = isSeedA
        ? [
            citingPaper("paper-a1"),
            citingPaper("paper-a2"),
            citingPaper("paper-a3"),
            citingPaper("paper-a4"),
            citingPaper("paper-a5", "unavailable"),
            citingPaper("paper-a6", "unavailable"),
          ]
        : [citingPaper("paper-b1")];
      return Promise.resolve({
        status: "completed",
        providerReportedTotal: isSeedA ? 9 : 1,
        coverage: isSeedA ? "truncated" : "complete",
        papers,
        execution: externalExecution(
          "citation-index",
          `neighbors-${seed.paper.paperId}`,
        ),
      });
    },
    harvestMentions: ({ citingPaper: paper }) => {
      switch (paper.paperId) {
        case "paper-a1":
          return Promise.resolve(
            successfulHarvest(
              paper.paperId,
              [
                {
                  mentionIndex: 0,
                  offset: firstOffset,
                  citationMarker: "[4–6]",
                  rawContext:
                    "The seed paper showed an effect and changed another outcome and newly added distinct result [4–6].",
                  isBundledCitation: true,
                  bundleSize: 3,
                  bundleRefIds: ["ref-4", "seed-ref", "ref-6"],
                  bundlePattern: "numeric_range",
                },
                {
                  mentionIndex: 1,
                  offset: 300,
                  citationMarker: "[5]",
                  rawContext: "The measurable effect was replicated [5].",
                },
              ],
              parser,
            ),
          );
        case "paper-a2":
          return Promise.resolve({
            materialization: {
              status: "succeeded",
              reason: "Fixture full text materialized",
              provenanceArtifacts: [
                artifactReference("raw-full-text", paper.paperId),
              ],
            },
            harvest: {
              status: "failed",
              reasonCode: "invalid_response",
              reason: "Reference list parser failed",
              provenanceArtifacts: [
                artifactReference("harvest-failure", paper.paperId),
              ],
            },
            mentions: [],
          });
        case "paper-a3":
          return Promise.resolve(
            successfulHarvest(
              paper.paperId,
              [
                {
                  mentionIndex: 0,
                  offset: 500,
                  citationMarker: "(Seed et al., 2020)",
                  rawContext:
                    "The method followed prior work (Seed et al., 2020).",
                },
              ],
              parser,
            ),
          );
        case "paper-a4":
          return Promise.resolve(
            successfulHarvest(
              paper.paperId,
              [
                {
                  mentionIndex: 0,
                  offset: 700,
                  citationMarker: "[5]",
                  rawContext: "The seed result was discussed [5].",
                },
              ],
              parser,
            ),
          );
        case "paper-a5":
          return Promise.resolve({
            materialization: {
              status: "unavailable",
              reasonCode: "unavailable",
              reason: "No full text could be acquired",
              provenanceArtifacts: [
                artifactReference("acquisition-failure", paper.paperId),
              ],
            },
            harvest: {
              status: "not_attempted",
              reason: "Harvest requires materialized full text",
              provenanceArtifacts: [
                artifactReference("harvest-not-attempted", paper.paperId),
              ],
            },
            mentions: [],
          });
        case "paper-b1":
          return Promise.resolve(
            successfulHarvest(
              paper.paperId,
              [
                {
                  mentionIndex: 0,
                  offset: 900,
                  citationMarker: "[2]",
                  rawContext: "The second seed showed a measurable effect [2].",
                },
              ],
              parser,
            ),
          );
        default:
          throw new Error(`Unexpected harvest call for ${paper.paperId}`);
      }
    },
    extractAttributedClaims: ({ citingPaper: paper, mention }) => {
      const key = `${paper.paperId}-${String(mention.mentionIndex)}`;
      if (paper.paperId === "paper-a3") {
        return Promise.resolve({
          status: "completed",
          reason: "Mention contains no empirical attribution",
          claims: [],
          execution: modelExecution(key, model),
        });
      }
      if (paper.paperId === "paper-a4") {
        return Promise.resolve({
          status: "failed",
          reasonCode: "extraction_failed",
          reason: "Model response could not be parsed",
          execution: modelExecution(key, model),
        });
      }
      if (paper.paperId === "paper-a1" && mention.mentionIndex === 0) {
        const firstClaim = {
          text: firstClaimText,
          supportSpanText: "The seed paper showed an effect",
          confidence: "high" as const,
        };
        const claims = [
          firstClaim,
          {
            text: "The seed paper changed another outcome.",
            supportSpanText: "changed another outcome",
            confidence: "medium" as const,
          },
        ];
        if (variant.addDifferentFirstClaim) {
          claims.unshift({
            text: "The seed paper reported a newly added distinct result.",
            supportSpanText: "newly added distinct result",
            confidence: "high",
          });
        }
        if (variant.duplicateFirstClaim) {
          claims.push({ ...firstClaim });
        }
        if (variant.reverseFirstClaims) {
          claims.reverse();
        }
        return Promise.resolve({
          status: "completed",
          reason: "Attributed claims were extracted",
          claims,
          execution: modelExecution(key, model),
        });
      }
      return Promise.resolve({
        status: "completed",
        reason: "One attributed claim was extracted",
        claims: [
          {
            text:
              paper.paperId === "paper-b1"
                ? "THE SEED PAPER SHOWED A MEASURABLE EFFECT."
                : "  The seed paper showed a measurable effect.  ",
            supportSpanText:
              paper.paperId === "paper-b1"
                ? "showed a measurable effect"
                : "measurable effect",
            confidence: "high",
          },
        ],
        execution: modelExecution(key, model),
      });
    },
  };
}

function fixtureOptions(
  variant: FixtureVariant = {},
): CanonicalDiscoverOptions {
  return {
    seeds: ["10.1000/seed-a", "10.1000/seed-b"].map((doi) => ({
      doi,
      provenanceArtifacts: [artifactReference("doi-input", doi)],
    })),
    neighborhood: {
      provider: "citation-index",
      query: "works-citing-seed",
      limit: 10,
      yearRange: { from: 2000, to: 2026 },
    },
    probeBudget: 5,
    candidateSelection: adaptivePortfolioPolicySchema.parse({
      mode: "adaptive_portfolio",
      minFamilies: 1,
      maxFamilies: variant.maxFamilies ?? 1,
      maxPreparedRecords: 1000,
      minMarginalNovelty: 0,
    }),
    recordedAt: variant.recordedAt ?? "2026-07-16T12:00:00.000Z",
  };
}

async function runFixture(
  variant: FixtureVariant = {},
): Promise<CanonicalDiscoverResult> {
  return runCanonicalDiscover(
    fixtureOptions(variant),
    buildFixtureAdapters(variant),
  );
}

function occurrence(
  result: CanonicalDiscoverResult,
  citingPaperId: string,
  mentionIndex: number,
): DiscoverCitationOccurrence {
  const found = result.payload.citationMentions.find(
    (mention) =>
      mention.citingPaperId === citingPaperId &&
      mention.mentionIndex === mentionIndex,
  );
  if (!found) throw new Error("Fixture occurrence not found");
  return found;
}

describe("canonical Discover", () => {
  let result: CanonicalDiscoverResult;
  let artifact: DiscoverArtifact;

  beforeAll(async () => {
    result = await runFixture();
    artifact = buildCanonicalDiscoverArtifact({
      result,
      runId: "run-canonical-discover-fixture",
      createdAt: "2026-07-16T12:05:00.000Z",
      configuration: {
        contentHash: canonicalSha256(fixtureOptions()),
      },
      code: {
        revision: "7dfa9af",
        dirty: false,
      },
    });
  });

  it("preserves two citation occurrences in one citing paper", () => {
    const paperMentions = result.payload.citationMentions.filter(
      (mention) => mention.citingPaperId === "paper-a1",
    );
    expect(paperMentions).toHaveLength(2);
    expect(
      new Set(paperMentions.map((mention) => mention.mentionId)).size,
    ).toBe(2);
  });

  it("preserves multiple attributed claims from one occurrence", () => {
    const mention = occurrence(result, "paper-a1", 0);
    const observation = result.payload.claimExtractionObservations.find(
      (entry) => entry.mentionId === mention.mentionId,
    );
    expect(observation?.status).toBe("claims_extracted");
    expect(observation?.claimRecordIds).toHaveLength(2);
    expect(
      result.payload.attributedClaimRecords.filter(
        (record) => record.mentionId === mention.mentionId,
      ),
    ).toHaveLength(2);
  });

  it("accounts for no-claim and failed extraction outcomes", () => {
    const noClaimMention = occurrence(result, "paper-a3", 0);
    const failedMention = occurrence(result, "paper-a4", 0);
    expect(
      result.payload.claimExtractionObservations.find(
        (entry) => entry.mentionId === noClaimMention.mentionId,
      ),
    ).toMatchObject({
      status: "no_claims",
      claimRecordIds: [],
    });
    expect(
      result.payload.claimExtractionObservations.find(
        (entry) => entry.mentionId === failedMention.mentionId,
      ),
    ).toMatchObject({
      status: "failed",
      claimRecordIds: [],
      reason: "Model response could not be parsed",
    });
  });

  it("groups equivalent claims without losing source records or mentions", () => {
    const seedA = result.payload.seeds.find(
      (seed) => seed.doi === "10.1000/seed-a",
    )!;
    const candidate = result.payload.claimCandidates.find(
      (entry) =>
        entry.seedId === seedA.seedId &&
        entry.normalizedClaim === "the seed paper showed a measurable effect.",
    )!;
    expect(candidate.sourceClaimRecordIds).toHaveLength(2);
    expect(candidate.memberMentionIds).toHaveLength(2);
    const originalTexts = candidate.sourceClaimRecordIds.map(
      (recordId) =>
        result.payload.attributedClaimRecords.find(
          (record) => record.claimRecordId === recordId,
        )!.extractedClaimText,
    );
    expect(originalTexts).toEqual(
      expect.arrayContaining([
        "The seed paper showed a measurable effect.",
        "  The seed paper showed a measurable effect.  ",
      ]),
    );
  });

  it("never merges the same normalized text across seeds", () => {
    const equivalentCandidates = result.payload.claimCandidates.filter(
      (candidate) =>
        candidate.normalizedClaim ===
        "the seed paper showed a measurable effect.",
    );
    expect(equivalentCandidates).toHaveLength(2);
    expect(
      new Set(equivalentCandidates.map((candidate) => candidate.seedId)).size,
    ).toBe(2);
    expect(
      new Set(equivalentCandidates.map((candidate) => candidate.candidateId))
        .size,
    ).toBe(2);
  });

  it("preserves bundled-citation metadata exactly", () => {
    expect(occurrence(result, "paper-a1", 0)).toMatchObject({
      citationMarker: "[4–6]",
      refId: "seed-ref",
      seedRefLabel: "Seed et al., 2020",
      isBundledCitation: true,
      bundleSize: 3,
      bundleRefIds: ["ref-4", "seed-ref", "ref-6"],
      bundlePattern: "numeric_range",
      sectionTitle: "Discussion",
    });
  });

  it("retains unprobed, unavailable, and failed papers with reasons", () => {
    const byPaperId = new Map(
      result.payload.citingPapers.map((paper) => [paper.paper.paperId, paper]),
    );
    expect(byPaperId.get("paper-a6")).toMatchObject({
      probe: { status: "not_selected" },
      materialization: { status: "not_attempted" },
      harvest: { status: "not_attempted", observedMentionCount: 0 },
    });
    expect(byPaperId.get("paper-a5")).toMatchObject({
      probe: { status: "selected" },
      materialization: {
        status: "unavailable",
        reason: "No full text could be acquired",
      },
      harvest: { status: "not_attempted", observedMentionCount: 0 },
    });
    expect(byPaperId.get("paper-a2")).toMatchObject({
      materialization: { status: "succeeded" },
      harvest: {
        status: "failed",
        reason: "Reference list parser failed",
        observedMentionCount: 0,
      },
    });
  });

  it("uses the adaptive portfolio only as a candidate disposition", async () => {
    const wider = await runFixture({ maxFamilies: 2 });
    expect(wider.payload.claimCandidates).toHaveLength(
      result.payload.claimCandidates.length,
    );
    expect(wider.payload.attributedClaimRecords).toHaveLength(
      result.payload.attributedClaimRecords.length,
    );
    expect(wider.payload.citationMentions).toHaveLength(
      result.payload.citationMentions.length,
    );
    expect(
      wider.payload.candidateDispositions.filter(
        (entry) => entry.selectedForScope,
      ).length,
    ).toBeGreaterThan(
      result.payload.candidateDispositions.filter(
        (entry) => entry.selectedForScope,
      ).length,
    );
  });

  it("does not accept grounding as candidate survival or ranking input", () => {
    expect(result.payload.claimCandidates).toHaveLength(3);
    expect(
      result.payload.claimCandidates.every(
        (candidate) =>
          !("grounding" in candidate) && !("seedGrounding" in candidate),
      ),
    ).toBe(true);
    expect(
      canonicalClaimExtractionResultSchema.safeParse({
        status: "completed",
        reason: "Malformed fixture with Discover-time grounding",
        claims: [
          {
            text: "A claim absent from the seed",
            groundingStatus: "not_found",
          },
        ],
        execution: modelExecution("grounding-malformed", "fixture-model"),
      }).success,
    ).toBe(false);
  });

  it("keeps identities stable across parser, model, portfolio, and timestamps", async () => {
    const provenanceChanged = await runFixture({
      parser: "fixture-parser-b",
      model: "fixture-model-b",
      maxFamilies: 2,
      recordedAt: "2026-07-17T12:00:00.000Z",
    });
    expect(
      provenanceChanged.payload.citationMentions.map(
        (mention) => mention.mentionId,
      ),
    ).toEqual(
      result.payload.citationMentions.map((mention) => mention.mentionId),
    );
    expect(
      provenanceChanged.payload.attributedClaimRecords.map(
        (record) => record.claimRecordId,
      ),
    ).toEqual(
      result.payload.attributedClaimRecords.map(
        (record) => record.claimRecordId,
      ),
    );
    expect(
      provenanceChanged.payload.claimCandidates.map(
        (candidate) => candidate.candidateId,
      ),
    ).toEqual(
      result.payload.claimCandidates.map((candidate) => candidate.candidateId),
    );

    const movedOccurrence = await runFixture({ firstOccurrenceOffset: 101 });
    expect(occurrence(movedOccurrence, "paper-a1", 0).mentionId).not.toBe(
      occurrence(result, "paper-a1", 0).mentionId,
    );

    const changedClaim = await runFixture({
      firstClaimText: "The seed paper showed a different measurable effect.",
    });
    const baseFirstClaim = result.payload.attributedClaimRecords.find(
      (record) =>
        record.mentionId === occurrence(result, "paper-a1", 0).mentionId,
    )!;
    const changedFirstClaim = changedClaim.payload.attributedClaimRecords.find(
      (record) =>
        record.mentionId ===
          occurrence(changedClaim, "paper-a1", 0).mentionId &&
        record.sourceClaimIndex === 0,
    )!;
    expect(changedFirstClaim.claimRecordId).not.toBe(
      baseFirstClaim.claimRecordId,
    );
  });

  it("keeps claim-record and candidate IDs stable when model order reverses", async () => {
    const reversed = await runFixture({ reverseFirstClaims: true });
    expect(
      reversed.payload.attributedClaimRecords
        .map((record) => record.claimRecordId)
        .sort(),
    ).toEqual(
      result.payload.attributedClaimRecords
        .map((record) => record.claimRecordId)
        .sort(),
    );
    expect(
      reversed.payload.claimCandidates
        .map((candidate) => candidate.candidateId)
        .sort(),
    ).toEqual(
      result.payload.claimCandidates
        .map((candidate) => candidate.candidateId)
        .sort(),
    );

    const originalClaim = result.payload.attributedClaimRecords.find(
      (record) =>
        record.extractedClaimText ===
        "The seed paper showed a measurable effect.",
    )!;
    const reorderedClaim = reversed.payload.attributedClaimRecords.find(
      (record) =>
        record.extractedClaimText ===
        "The seed paper showed a measurable effect.",
    )!;
    expect(originalClaim.sourceClaimIndex).toBe(0);
    expect(reorderedClaim.sourceClaimIndex).toBe(1);
    expect(reorderedClaim.claimRecordId).toBe(originalClaim.claimRecordId);
  });

  it("does not change existing claim IDs when a different claim is added", async () => {
    const expanded = await runFixture({ addDifferentFirstClaim: true });
    const originalIds = result.payload.attributedClaimRecords.map(
      (record) => record.claimRecordId,
    );
    const expandedIds = new Set(
      expanded.payload.attributedClaimRecords.map(
        (record) => record.claimRecordId,
      ),
    );
    expect(
      originalIds.every((claimRecordId) => expandedIds.has(claimRecordId)),
    ).toBe(true);

    const originalCandidateIds = result.payload.claimCandidates.map(
      (candidate) => candidate.candidateId,
    );
    const expandedCandidateIds = new Set(
      expanded.payload.claimCandidates.map(
        (candidate) => candidate.candidateId,
      ),
    );
    expect(
      originalCandidateIds.every((candidateId) =>
        expandedCandidateIds.has(candidateId),
      ),
    ).toBe(true);
  });

  it("preserves exact duplicate claims with distinct order-stable IDs", async () => {
    const duplicated = await runFixture({
      duplicateFirstClaim: true,
      addDifferentFirstClaim: true,
    });
    const duplicatedReversed = await runFixture({
      duplicateFirstClaim: true,
      addDifferentFirstClaim: true,
      reverseFirstClaims: true,
    });
    const sourceMention = occurrence(duplicated, "paper-a1", 0);
    const duplicateRecords = duplicated.payload.attributedClaimRecords.filter(
      (record) =>
        record.mentionId === sourceMention.mentionId &&
        record.extractedClaimText ===
          "The seed paper showed a measurable effect.",
    );
    expect(duplicateRecords).toHaveLength(2);
    expect(
      new Set(duplicateRecords.map((record) => record.claimRecordId)).size,
    ).toBe(2);
    expect(
      duplicateRecords
        .map((record) => record.duplicateOrdinal)
        .sort((left, right) => left - right),
    ).toEqual([0, 1]);
    expect(
      duplicatedReversed.payload.attributedClaimRecords
        .map((record) => record.claimRecordId)
        .sort(),
    ).toEqual(
      duplicated.payload.attributedClaimRecords
        .map((record) => record.claimRecordId)
        .sort(),
    );
    expect(
      duplicatedReversed.payload.claimCandidates
        .map((candidate) => candidate.candidateId)
        .sort(),
    ).toEqual(
      duplicated.payload.claimCandidates
        .map((candidate) => candidate.candidateId)
        .sort(),
    );
  });

  it("accepts a no-mentions harvest only with its reason code", () => {
    const harvest = (extra: Record<string, unknown>) => ({
      materialization: {
        status: "succeeded",
        reason: "Full text materialized",
        provenanceArtifacts: [artifactReference("materialization", "p1")],
      },
      harvest: {
        status: "no_mentions",
        reason: "Seed bibliography entry found but no in-text mentions.",
        provenanceArtifacts: [artifactReference("mention-harvest", "p1")],
        ...extra,
      },
      mentions: [],
    });

    expect(
      canonicalMentionHarvestResultSchema.safeParse(
        harvest({ reasonCode: "no_in_text_mentions" }),
      ).success,
    ).toBe(true);
    expect(
      canonicalMentionHarvestResultSchema.safeParse(
        harvest({ reasonCode: "not_found" }),
      ).success,
    ).toBe(true);
    // Without a code the Report could not say why the paper was lost.
    expect(
      canonicalMentionHarvestResultSchema.safeParse(harvest({})).success,
    ).toBe(false);
  });

  it("rejects half-present and non-increasing citation offsets", () => {
    const harvest = successfulHarvest(
      "offset-fixture",
      [
        {
          mentionIndex: 0,
          offset: 100,
          citationMarker: "[1]",
          rawContext: "Offset fixture [1].",
        },
      ],
      "fixture-parser",
    );
    const adapterMention = harvest.mentions[0]!;
    for (const invalidMention of [
      { ...adapterMention, charOffsetEnd: undefined },
      {
        ...adapterMention,
        charOffsetEnd: adapterMention.charOffsetStart,
      },
    ]) {
      const parsed = canonicalMentionHarvestResultSchema.safeParse({
        ...harvest,
        mentions: [invalidMention],
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) =>
            issue.message.includes("Citation source offset"),
          ),
        ).toBe(true);
      }
    }

    const canonicalMention = occurrence(result, "paper-a1", 0);
    for (const invalidMention of [
      { ...canonicalMention, charOffsetEnd: undefined },
      {
        ...canonicalMention,
        charOffsetEnd: canonicalMention.charOffsetStart,
      },
    ]) {
      const parsed = discoverCitationOccurrenceSchema.safeParse(invalidMention);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) =>
            issue.message.includes("Citation source offset"),
          ),
        ).toBe(true);
      }
    }
  });

  it("rejects malformed external and model adapter outputs at Zod boundaries", async () => {
    const malformedResolution: CanonicalDiscoverAdapters = {
      ...buildFixtureAdapters(),
      resolveSeed: () =>
        Promise.resolve({
          status: "resolved",
          paper: { paperId: "" },
          execution: externalExecution("resolver", "malformed"),
        }),
    };
    await expect(
      runCanonicalDiscover(fixtureOptions(), malformedResolution),
    ).rejects.toBeInstanceOf(CanonicalDiscoverBoundaryError);

    const malformedExtraction: CanonicalDiscoverAdapters = {
      ...buildFixtureAdapters(),
      extractAttributedClaims: () =>
        Promise.resolve({
          status: "completed",
          reason: "Malformed claim output",
          claims: [{ text: "" }],
          execution: modelExecution("malformed", "fixture-model"),
        }),
    };
    await expect(
      runCanonicalDiscover(fixtureOptions(), malformedExtraction),
    ).rejects.toBeInstanceOf(CanonicalDiscoverBoundaryError);
  });

  it("fails the stage on fatal provider failures", async () => {
    const fatalAdapters: CanonicalDiscoverAdapters = {
      ...buildFixtureAdapters(),
      resolveSeed: ({ doi }) =>
        Promise.resolve({
          status: "failed",
          reasonCode: "authentication",
          reason: "Provider credentials were rejected",
          execution: externalExecution("resolver", `fatal-${doi}`),
        }),
    };
    await expect(
      runCanonicalDiscover(fixtureOptions(), fatalAdapters),
    ).rejects.toBeInstanceOf(CanonicalDiscoverFatalError);

    const fatalNeighborhoodAdapters: CanonicalDiscoverAdapters = {
      ...buildFixtureAdapters(),
      retrieveCitingNeighborhood: () =>
        Promise.resolve({
          status: "failed",
          reasonCode: "authorization",
          reason: "Citation-index provider denied access",
          execution: externalExecution("openalex", "fatal-neighborhood"),
        }),
    };
    await expect(
      runCanonicalDiscover(fixtureOptions(), fatalNeighborhoodAdapters),
    ).rejects.toBeInstanceOf(CanonicalDiscoverFatalError);
  });

  it("records publisher full-text access denials without failing the stage", async () => {
    const paywalledAdapters: CanonicalDiscoverAdapters = {
      ...buildFixtureAdapters(),
      harvestMentions: ({ citingPaper: paper }) =>
        Promise.resolve({
          materialization: {
            status: "unavailable",
            reasonCode: "unavailable",
            reason: "HTTP 403 from http://www.cell.com/article/example/pdf",
            provenanceArtifacts: [
              artifactReference("acquisition-failure", paper.paperId),
            ],
          },
          harvest: {
            status: "not_attempted",
            reason: "Harvest not attempted after materialization failure.",
            provenanceArtifacts: [
              artifactReference("harvest-not-attempted", paper.paperId),
            ],
          },
          mentions: [],
        }),
    };
    const result = await runCanonicalDiscover(
      fixtureOptions(),
      paywalledAdapters,
    );
    const probed = result.payload.citingPapers.filter(
      (paper) => paper.probe.status === "selected",
    );
    expect(probed.length).toBeGreaterThan(0);
    expect(
      probed.every((paper) => paper.materialization.status === "unavailable"),
    ).toBe(true);
  });

  it("round-trips only the current Discover artifact and detects tampering", () => {
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-discover-"));
    const artifactPath = join(directory, "discover.json");
    try {
      writeCanonicalArtifact("discover", artifactPath, artifact);
      expect(loadCanonicalArtifact("discover", artifactPath)).toEqual(artifact);

      const tampered = structuredClone(artifact);
      tampered.payload.citationMentions[0]!.rawContext =
        "Tampered scientific context";
      writeFileSync(artifactPath, JSON.stringify(tampered), "utf8");
      expect(() => loadCanonicalArtifact("discover", artifactPath)).toThrow(
        /mentionId|contentHash|supportSpan/,
      );

      expect(() =>
        writeCanonicalArtifact("discover", artifactPath, {
          ...artifact,
          artifactVersion: 2,
        } as unknown as DiscoverArtifact),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds a zero-loss canonical artifact from raw observation fixtures", () => {
    expect(artifact.canonicalStage).toBe("discover");
    expect(artifact.execution.replayableFromInputs).toBe(false);
    expect(artifact.payload.neighborhoodQueries).toHaveLength(2);
    expect(artifact.payload.citingPapers).toHaveLength(7);
    expect(artifact.payload.citationMentions).toHaveLength(5);
    expect(artifact.payload.claimExtractionObservations).toHaveLength(5);
    expect(artifact.payload.attributedClaimRecords).toHaveLength(4);
    expect(
      artifact.payload.claimCandidates
        .flatMap((candidate) => candidate.sourceClaimRecordIds)
        .sort(),
    ).toEqual(
      artifact.payload.attributedClaimRecords
        .map((record) => record.claimRecordId)
        .sort(),
    );
    expect(artifact.provenance.models).toHaveLength(5);
    expect(
      artifact.provenance.models.every(
        (model) =>
          model.requestArtifact.role === "model-request" &&
          model.responseArtifact.role === "model-response",
      ),
    ).toBe(true);
  });
});

describe("canonical Discover claim canonicalization", () => {
  type ExtractionOutput = {
    status: "completed";
    reason: string;
    claims: Array<{
      text: string;
      supportSpanText?: string;
      confidence?: string;
    }>;
    execution: ReturnType<typeof modelExecution>;
  };

  /** Give every citing paper its own paraphrase so exact grouping cannot merge. */
  function paraphrasingAdapters(): CanonicalDiscoverAdapters {
    const base = buildFixtureAdapters();
    return {
      ...base,
      extractAttributedClaims: async (input) => {
        const output = (await base.extractAttributedClaims(input)) as
          | ExtractionOutput
          | { status: "failed" };
        if (output.status !== "completed") return output;
        return {
          ...output,
          claims: output.claims.map((claim) => ({
            ...claim,
            text: `${claim.text} As restated by ${input.citingPaper.paperId}.`,
          })),
        };
      },
    };
  }

  it("groups by exact normalized text when no canonicalization adapter is supplied", async () => {
    const result = await runCanonicalDiscover(
      fixtureOptions(),
      paraphrasingAdapters(),
    );
    for (const candidate of result.payload.claimCandidates) {
      expect(candidate.equivalence).toEqual({
        method: "exact_normalized_text",
      });
      expect(candidate.memberMentionIds.length).toBeLessThanOrEqual(2);
    }
  });

  it("merges paraphrases across citing papers into one family per seed finding", async () => {
    const adapters = paraphrasingAdapters();
    const canonicalizeClaims = vi.fn(
      ({ seed, claims }: CanonicalClaimCanonicalizationInput) =>
        Promise.resolve({
          status: "completed",
          clusters: [
            {
              canonicalClaim: "The seed paper reported a measurable effect.",
              claimRecordIds: claims.map((claim) => claim.claimRecordId),
            },
          ],
          execution: {
            ...modelExecution(`canon-${seed.paper.paperId}`, "fixture-canon"),
            promptId: "canonical-claim-canonicalization",
          },
        }),
    );
    const result = await runCanonicalDiscover(fixtureOptions(), {
      ...adapters,
      canonicalizeClaims,
    });

    expect(canonicalizeClaims).toHaveBeenCalled();
    // Without the adapter every paraphrase is its own candidate.
    const exact = await runCanonicalDiscover(fixtureOptions(), adapters);
    let anyFamilyMerged = false;
    for (const seed of result.payload.seeds) {
      const records = result.payload.attributedClaimRecords.filter(
        (record) => record.seedId === seed.seedId,
      );
      if (records.length < 2) continue;
      const candidates = result.payload.claimCandidates.filter(
        (candidate) => candidate.seedId === seed.seedId,
      );
      const exactCandidates = exact.payload.claimCandidates.filter(
        (candidate) => candidate.seedId === seed.seedId,
      );
      expect(candidates).toHaveLength(1);
      expect(exactCandidates.length).toBeGreaterThan(1);
      const [family] = candidates;
      expect(family!.canonicalClaim).toBe(
        "The seed paper reported a measurable effect.",
      );
      expect(family!.sourceClaimRecordIds).toHaveLength(records.length);
      expect(family!.memberMentionIds.length).toBeGreaterThan(1);
      expect(family!.equivalence?.method).toBe("model");
      anyFamilyMerged = true;
    }
    expect(anyFamilyMerged).toBe(true);
    expect(
      result.provenanceInputs.models.some((model) =>
        model.model.startsWith("fixture-canon"),
      ),
    ).toBe(true);
    // The artifact schema accepts the model-equivalence provenance.
    buildCanonicalDiscoverArtifact({
      result,
      runId: "run-canonicalization-fixture",
      createdAt: "2026-09-02T12:05:00.000Z",
    });
  });

  it("repairs a model partition that omits claims instead of discarding it", async () => {
    const adapters = paraphrasingAdapters();
    const result = await runCanonicalDiscover(fixtureOptions(), {
      ...adapters,
      canonicalizeClaims: ({ seed, claims }) =>
        Promise.resolve({
          status: "completed",
          clusters: [
            {
              canonicalClaim: "Partial cluster",
              claimRecordIds: [
                ...claims.slice(0, 1).map((c) => c.claimRecordId),
                "claim-record_" + "0".repeat(64),
              ],
            },
          ],
          execution: modelExecution(
            `canon-${seed.paper.paperId}`,
            "fixture-canon",
          ),
        }),
    });
    const modelGroups = result.payload.claimCandidates.filter(
      (candidate) => candidate.equivalence?.method === "model",
    );
    expect(modelGroups.length).toBeGreaterThan(1);
    const repaired = modelGroups.filter(
      (candidate) =>
        candidate.equivalence?.method === "model" &&
        candidate.equivalence.repairNote != null,
    );
    expect(repaired.length).toBe(modelGroups.length);
    expect(repaired[0]!.equivalence).toMatchObject({
      method: "model",
      repairNote: expect.stringMatching(/unknown.*dropped.*omitted/i) as string,
    });
    // Every record is still accounted for exactly once.
    const memberIds = result.payload.claimCandidates.flatMap(
      (candidate) => candidate.sourceClaimRecordIds,
    );
    expect(new Set(memberIds).size).toBe(memberIds.length);
    expect(memberIds).toHaveLength(
      result.payload.attributedClaimRecords.length,
    );
  });
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("discover extraction concurrency", () => {
  it("produces the same artifact whether extraction runs one at a time or side by side", async () => {
    const run = async (concurrency: number) => {
      const base = buildFixtureAdapters();
      let inFlight = 0;
      let peak = 0;
      const result = await runCanonicalDiscover(
        { ...fixtureOptions(), concurrency },
        {
          ...base,
          extractAttributedClaims: async (input) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await tick(input.mention.mentionIndex === 0 ? 6 : 1);
            inFlight -= 1;
            return base.extractAttributedClaims(input);
          },
        },
      );
      return { result, peak };
    };
    const sequential = await run(1);
    const parallel = await run(3);
    expect(sequential.peak).toBe(1);
    expect(parallel.peak).toBeGreaterThan(1);
    expect(parallel.result.payload).toEqual(sequential.result.payload);
    expect(parallel.result.provenanceInputs).toEqual(
      sequential.result.provenanceInputs,
    );
  });
});
