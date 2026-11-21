import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildClaimCandidateId,
  buildScopedFamilyId,
  createAppendOnlyDecision,
  createStageArtifact,
  discoverArtifactSchema,
  scopeArtifactPayloadSchema,
  type DiscoverArtifact,
} from "../../../src/contract/artifacts/index.js";
import {
  buildDiscoverArtifact,
  runDiscover,
  type DiscoverAdapters,
} from "../../../src/stages/discover/run.js";
import {
  buildScopeArtifact,
  scopeGroundingOutputSchema,
  ScopeBoundaryError,
  ScopeFatalError,
  runScope,
  type ScopeAdapters,
  type ScopeGroundingOutput,
  type ScopeResult,
} from "../../../src/stages/scope/run.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../../src/shared/stable-identity.js";
import {
  loadArtifact,
  writeArtifact,
} from "../../../src/contract/selectors.js";
import { expectRejected } from "../../rejection.fixture.js";
import { buildScopeCitationStatements } from "../../../src/stages/scope/statements.js";
import {
  artifactReference,
  discoverOptions,
  externalExecution,
} from "../chain.fixture.js";

type ScopeFixtureOptions = {
  maxFamilies?: number;
  groundingStatus?: "grounded" | "ambiguous" | "not_found";
  hallucinatedQuote?: boolean;
  allHallucinatedQuotes?: boolean;
  seedUnavailable?: boolean;
  acquisitionFailed?: boolean;
  fatalMaterialization?: boolean;
  fatalGrounding?: boolean;
  groundingFailureCode?: "timeout" | "transport";
  invalidGroundingOutput?: boolean;
  notFoundWithSupportSpans?: boolean;
  reverseSupportSpans?: boolean;
  unknownMaterializationFailureCode?: boolean;
  model?: string;
};

function discoverModelExecution(key: string) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model: "fixture-discover-model",
    promptId: "attributed-claim-extraction",
    promptVersion: "v1",
    promptContentHash: canonicalSha256("extract attributed claims"),
    requestHash: canonicalSha256({ key, direction: "request" }),
    requestArtifact: artifactReference("model-request", key),
    responseArtifact: artifactReference("model-response", key),
  };
}

function scopeModelExecution(key: string, model = "fixture-scope-model") {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model,
    promptId: "scope-grounding",
    promptVersion: "v1",
    promptContentHash: canonicalSha256("ground claim in immutable seed blocks"),
    requestHash: canonicalSha256({ key, model, direction: "request" }),
    requestArtifact: artifactReference(
      "model-request",
      `scope-${key}-${model}`,
    ),
    responseArtifact: artifactReference(
      "model-response",
      `scope-${key}-${model}`,
    ),
  };
}

const fixtureDiscoverOptions = (maxFamilies = 1) =>
  discoverOptions({
    dois: ["10.1000/seed-a", "10.1000/seed-b"],
    maxFamilies,
    recordedAt: "2026-07-16T12:00:00.000Z",
  });

function citingPaper(paperId: string) {
  return {
    providerRecordId: `provider-${paperId}`,
    paperId,
    title: `Citing ${paperId}`,
    doi: `10.2000/${paperId}`,
    authors: [`Author ${paperId}`],
    publicationYear: 2024,
    fullTextAvailability: "available" as const,
    provenanceArtifacts: [artifactReference("provider-paper", paperId)],
  };
}

function successfulHarvest(
  paperId: string,
  mentions: Array<{
    mentionIndex: number;
    context: string;
    bundled?: boolean;
  }>,
) {
  return {
    materialization: {
      status: "succeeded" as const,
      reason: "Fixture citing text materialized",
      provenanceArtifacts: [artifactReference("raw-citing-text", paperId)],
    },
    harvest: {
      status: "succeeded" as const,
      reason: "All fixture occurrences harvested",
      provenanceArtifacts: [artifactReference("mention-harvest", paperId)],
    },
    bibliographyMatch: { method: "doi" as const, refId: "seed-ref" },
    mentions: mentions.map((mention) => {
      const citationMarker = mention.bundled ? "[2–4]" : "[3]";
      const markerStart = mention.context.indexOf(citationMarker);
      return {
        mentionIndex: mention.mentionIndex,
        refId: "seed-ref",
        targetRefIds: ["seed-ref"],
        charOffsetStart: mention.mentionIndex * 100,
        charOffsetEnd: mention.mentionIndex * 100 + mention.context.length,
        citationMarker,
        locationQuality: "exact_dom" as const,
        markerSpan: {
          charOffsetStart: markerStart,
          charOffsetEnd: markerStart + citationMarker.length,
        },
        rawContext: mention.context,
        sectionTitle: "Discussion",
        seedRefLabel: "Seed et al., 2020",
        isBundledCitation: mention.bundled ?? false,
        bundleSize: mention.bundled ? 3 : 1,
        bundleRefIds: mention.bundled
          ? ["other-2", "seed-ref", "other-4"]
          : ["seed-ref"],
        bundlePattern: mention.bundled ? "numeric_range" : "single",
        sourceType: "jats_xml",
        parser: "fixture-jats-parser",
        parserVersion: "v1",
        sourceTextHash: canonicalSha256({ paperId }),
        provenanceArtifacts: [
          artifactReference(
            "citation-occurrence-source",
            `${paperId}-${String(mention.mentionIndex)}`,
          ),
        ],
      };
    }),
  };
}

// Local: two seeds with their own neighborhoods, not the shared single-seed chain.
function discoverAdapters(): DiscoverAdapters {
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
    retrieveCitingNeighborhood: ({ seed }) =>
      Promise.resolve({
        status: "completed",
        providerReportedTotal: seed.paper.paperId === "seed-paper-a" ? 2 : 1,
        coverage: "complete",
        papers:
          seed.paper.paperId === "seed-paper-a"
            ? [citingPaper("paper-a1"), citingPaper("paper-a2")]
            : [citingPaper("paper-b1")],
        execution: externalExecution(
          "fixture-citation-index",
          `neighbors-${seed.paper.paperId}`,
        ),
      }),
    harvestMentions: ({ citingPaper: paper }) => {
      if (paper.paperId === "paper-a1") {
        return Promise.resolve(
          successfulHarvest(paper.paperId, [
            {
              mentionIndex: 0,
              context: "The seed showed a measurable effect [2–4].",
              bundled: true,
            },
            {
              mentionIndex: 1,
              context: "The measurable effect was replicated [3].",
            },
            {
              mentionIndex: 2,
              context: "The seed also reported a distinct outcome [3].",
            },
          ]),
        );
      }
      if (paper.paperId === "paper-a2") {
        return Promise.resolve(
          successfulHarvest(paper.paperId, [
            {
              mentionIndex: 0,
              context: "The paper cited the seed for background only [3].",
            },
          ]),
        );
      }
      return Promise.resolve(
        successfulHarvest(paper.paperId, [
          {
            mentionIndex: 0,
            context: "This seed also showed a measurable effect [3].",
          },
        ]),
      );
    },
    extractAttributedClaims: ({ citingPaper: paper, mention }) => {
      const key = `${paper.paperId}-${String(mention.mentionIndex)}`;
      let claims: Array<{
        text: string;
        supportSpanText: string;
        confidence: "high";
      }> = [];
      if (paper.paperId === "paper-a1" && mention.mentionIndex < 2) {
        claims = [
          {
            text:
              mention.mentionIndex === 0
                ? "The seed showed a measurable effect."
                : "  THE SEED SHOWED A MEASURABLE EFFECT. ",
            supportSpanText: "measurable effect",
            confidence: "high",
          },
        ];
      } else if (paper.paperId === "paper-a1") {
        claims = [
          {
            text: "The seed reported a distinct outcome.",
            supportSpanText: "distinct outcome",
            confidence: "high",
          },
        ];
      } else if (paper.paperId === "paper-b1") {
        claims = [
          {
            text: "The seed showed a measurable effect.",
            supportSpanText: "measurable effect",
            confidence: "high",
          },
        ];
      }
      return Promise.resolve({
        status: "completed",
        reason:
          claims.length > 0
            ? "Fixture attributed claims extracted"
            : "No claim attributed to the seed",
        claims,
        execution: discoverModelExecution(key),
      });
    },
  };
}

async function discoverFixture(maxFamilies = 1): Promise<DiscoverArtifact> {
  const result = await runDiscover(
    fixtureDiscoverOptions(maxFamilies),
    discoverAdapters(),
  );
  return buildDiscoverArtifact({
    result,
    runId: "run-scope-fixture",
    createdAt: "2026-07-16T12:05:00.000Z",
    configuration: {
      contentHash: canonicalSha256(fixtureDiscoverOptions(maxFamilies)),
    },
    code: {
      revision: "64890ed",
      dirty: false,
    },
  });
}

function splitEquivalentCandidate(
  discover: DiscoverArtifact,
): DiscoverArtifact {
  const original = selectedSeedACandidate(discover);
  const splitCandidates = original.sourceClaimRecordIds.map(
    (sourceClaimRecordId) => {
      const claimRecord = discover.payload.attributedClaimRecords.find(
        (record) => record.claimRecordId === sourceClaimRecordId,
      )!;
      const sourceClaimRecordIds = [sourceClaimRecordId];
      return {
        ...original,
        candidateId: buildClaimCandidateId({
          seedId: original.seedId,
          normalizedClaim: original.normalizedClaim,
          sourceClaimRecordIds,
        }),
        memberMentionIds: [claimRecord.mentionId],
        sourceClaimRecordIds,
      };
    },
  );
  const otherCandidates = discover.payload.claimCandidates.filter(
    (candidate) => candidate.candidateId !== original.candidateId,
  );
  const seedAOtherCandidates = otherCandidates
    .filter((candidate) => candidate.seedId === original.seedId)
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const seedBDispositions = discover.payload.candidateDispositions.filter(
    (disposition) => {
      const candidate = otherCandidates.find(
        (entry) => entry.candidateId === disposition.candidateId,
      );
      return candidate != null && candidate.seedId !== original.seedId;
    },
  );
  const fixtureAnnotation = discover.payload.candidateDispositions[0]
    ?.annotation ?? {
    policyVersion: "adaptive-portfolio-v3" as const,
    uniqueCitingPaperCount: 1,
    uniqueCitationGroupCount: 1,
    sourceRecordCount: 1,
    mentionCount: 1,
    confidenceAggregate: 0.5,
    specificityScore: 0.5,
    informativeTokenCount: 4,
    namedOrAlphanumericTermCount: 1,
    quantityCount: 0,
    comparisonCount: 0,
    conditionCount: 0,
    genericLanguagePenalty: 0,
    claimShape: "atomic" as const,
  };
  const candidateDispositions = [
    ...splitCandidates.map((candidate, index) => ({
      candidateId: candidate.candidateId,
      selectedForScope: true,
      rank: index + 1,
      reason: `Selected split equivalent candidate at rank ${String(index + 1)}`,
      annotation: fixtureAnnotation,
    })),
    ...seedAOtherCandidates.map((candidate, index) => ({
      candidateId: candidate.candidateId,
      selectedForScope: false,
      rank: splitCandidates.length + index + 1,
      reason: "Deferred split-fixture candidate beyond the Scope cap",
      annotation: fixtureAnnotation,
    })),
    ...seedBDispositions,
  ];
  const claimCandidates = [...otherCandidates, ...splitCandidates].sort(
    (left, right) => left.candidateId.localeCompare(right.candidateId),
  );
  const scopeDecisions = candidateDispositions.map((disposition) => {
    const candidate = claimCandidates.find(
      (entry) => entry.candidateId === disposition.candidateId,
    )!;
    return createAppendOnlyDecision({
      recordId: candidate.candidateId,
      decisionType: "discover_scope_disposition",
      outcome: disposition.selectedForScope
        ? "selected_for_scope"
        : "deferred_by_cap",
      reason: disposition.reason,
      recordedAt: "2026-07-16T12:00:00.000Z",
      actor: {
        kind: "deterministic",
        identifier: "discover-candidate-ranking-v1",
      },
      evidenceArtifacts: candidate.provenanceArtifacts,
    });
  });
  const artifact = createStageArtifact({
    schemaVersion: discover.schemaVersion,
    artifactVersion: discover.artifactVersion,
    runId: discover.runId,
    createdAt: discover.createdAt,
    stage: "discover",
    inputArtifacts: discover.inputArtifacts,
    provenance: discover.provenance,
    execution: discover.execution,
    decisions: [
      ...discover.decisions.filter(
        (decision) => decision.decisionType !== "discover_scope_disposition",
      ),
      ...scopeDecisions,
    ],
    payload: {
      ...discover.payload,
      claimCandidates,
      candidateDispositions,
    },
  });
  return discoverArtifactSchema.parse(artifact);
}

// Local: fault-injection options and call recording, unlike the shared grounding variants.
function scopeAdapters(
  options: ScopeFixtureOptions,
  materializationCalls: Map<string, number>,
): ScopeAdapters {
  return {
    materializeSeed: ({ seed }) => {
      materializationCalls.set(
        seed.seedId,
        (materializationCalls.get(seed.seedId) ?? 0) + 1,
      );
      const execution = {
        kind: "external" as const,
        ...externalExecution("fixture-full-text", `materialize-${seed.seedId}`),
      };
      if (options.unknownMaterializationFailureCode) {
        return Promise.resolve({
          seedId: seed.seedId,
          status: "acquisition_failed",
          reasonCode: "timeuot",
          reason: "Fixture emitted a misspelled failure code.",
          provenanceArtifacts: [
            artifactReference("acquisition-trace", seed.seedId),
          ],
          execution,
        });
      }
      if (options.seedUnavailable) {
        return Promise.resolve({
          seedId: seed.seedId,
          status: "seed_text_unavailable",
          reasonCode: "unavailable",
          reason: "No inspectable seed manuscript was available.",
          provenanceArtifacts: [
            artifactReference("acquisition-trace", seed.seedId),
          ],
          execution,
        });
      }
      if (options.acquisitionFailed) {
        return Promise.resolve({
          seedId: seed.seedId,
          status: "acquisition_failed",
          reasonCode: options.fatalMaterialization
            ? "authorization"
            : "transport",
          reason: options.fatalMaterialization
            ? "Full-text provider denied access."
            : "Seed manuscript acquisition failed in transit.",
          provenanceArtifacts: [
            artifactReference("acquisition-trace", seed.seedId),
          ],
          execution,
        });
      }
      const text =
        "The manuscript reports a measurable effect in the primary outcome.";
      return Promise.resolve({
        seedId: seed.seedId,
        status: "materialized",
        reason: "Fixture seed manuscript materialized once.",
        seedTextArtifact: artifactReference("parsed-seed-text", seed.seedId),
        sourceArtifacts: [artifactReference("raw-seed-text", seed.seedId)],
        parser: {
          kind: "fixture-structured-parser",
          version: "v1",
        },
        blocks: [
          {
            blockId: "body-1",
            text,
            sectionTitle: "Results",
            blockKind: "body_paragraph",
            charOffsetStart: 0,
            charOffsetEnd: text.length,
          },
        ],
        execution,
      });
    },
    groundFamily: ({ family }) => {
      const execution = scopeModelExecution(family.familyId, options.model);
      if (options.fatalGrounding) {
        return Promise.resolve({
          status: "failed",
          reasonCode: "authentication",
          reason: "Fixture provider rejected credentials.",
          execution,
        });
      }
      if (options.groundingFailureCode) {
        return Promise.resolve({
          status: "failed",
          reasonCode: options.groundingFailureCode,
          reason: `Fixture ${options.groundingFailureCode} during grounding.`,
          execution,
        });
      }
      if (options.invalidGroundingOutput) {
        return Promise.resolve({
          status: "completed",
          rawOutput: "not a structured grounding object",
          execution,
        });
      }
      const status = options.groundingStatus ?? "grounded";
      const supportSpans = options.allHallucinatedQuotes
        ? [
            {
              verbatimQuote: "a model-invented passage",
              blockId: "body-1",
            },
            {
              verbatimQuote: "another invented passage",
              blockId: "body-1",
            },
          ]
        : [
            {
              verbatimQuote: options.hallucinatedQuote
                ? "a model-invented passage"
                : "reports a measurable effect",
              blockId: "body-1",
            },
            {
              verbatimQuote: "primary outcome",
              blockId: "body-1",
            },
          ];
      if (options.reverseSupportSpans) {
        supportSpans.reverse();
      }
      if (status === "not_found" && options.notFoundWithSupportSpans) {
        return Promise.resolve({
          status: "completed",
          rawOutput: {
            status: "not_found",
            detailReason:
              "Contradictory fixture proposed evidence for not_found.",
            supportSpans,
          },
          execution,
        });
      }
      const output: ScopeGroundingOutput =
        status === "not_found"
          ? {
              status,
              detailReason:
                "The attributed claim was not found in the seed manuscript.",
              supportSpans: [],
            }
          : {
              status,
              detailReason:
                status === "grounded"
                  ? "The seed manuscript directly supports the family claim."
                  : "Several seed passages could plausibly support the claim.",
              supportSpans,
            };
      return Promise.resolve({
        status: "completed",
        rawOutput: output,
        execution,
      });
    },
  };
}

async function runScopeFixture(options: ScopeFixtureOptions = {}): Promise<{
  discover: DiscoverArtifact;
  result: ScopeResult;
  calls: Map<string, number>;
}> {
  const discover = await discoverFixture(options.maxFamilies ?? 1);
  const calls = new Map<string, number>();
  const result = await runScope(discover, scopeAdapters(options, calls), {
    recordedAt: "2026-07-16T12:10:00.000Z",
    discoverArtifactUri: "fixture://discover/discover.json",
  });
  return { discover, result, calls };
}

function selectedSeedACandidate(discover: DiscoverArtifact) {
  const seed = discover.payload.seeds.find(
    (entry) => entry.doi === "10.1000/seed-a",
  )!;
  return discover.payload.claimCandidates.find(
    (candidate) =>
      candidate.seedId === seed.seedId &&
      candidate.normalizedClaim === "the seed showed a measurable effect.",
  )!;
}

describe("Scope", () => {
  it("freezes both same-paper occurrences without neighborhood expansion", async () => {
    const { discover, result } = await runScopeFixture();
    const candidate = selectedSeedACandidate(discover);
    const family = result.payload.families.find(
      (entry) => entry.seedId === candidate.seedId,
    )!;
    expect(candidate.memberMentionIds).toHaveLength(2);
    expect(family.includedCitationOccurrenceIds).toEqual(
      [...candidate.memberMentionIds].sort(),
    );
    const memberPapers = candidate.memberMentionIds.map(
      (mentionId) =>
        discover.payload.citationMentions.find(
          (mention) => mention.mentionId === mentionId,
        )!.citingPaperId,
    );
    expect(memberPapers).toEqual(["paper-a1", "paper-a1"]);
    const unrelatedMention = discover.payload.citationMentions.find(
      (mention) => mention.citingPaperId === "paper-a2",
    )!;
    expect(family.includedCitationOccurrenceIds).not.toContain(
      unrelatedMention.mentionId,
    );
  });

  it("retains bundled occurrences unchanged by immutable reference", async () => {
    const { discover, result } = await runScopeFixture();
    const bundled = discover.payload.citationMentions.find(
      (mention) => mention.isBundledCitation,
    )!;
    const family = result.payload.families.find((entry) =>
      entry.includedCitationOccurrenceIds.includes(bundled.mentionId),
    )!;
    expect(family.includedCitationOccurrenceIds).toContain(bundled.mentionId);
    expect(
      discover.payload.citationMentions.find(
        (mention) => mention.mentionId === bundled.mentionId,
      ),
    ).toMatchObject({
      citationMarker: "[2–4]",
      bundleSize: 3,
      bundleRefIds: ["other-2", "seed-ref", "other-4"],
      bundlePattern: "numeric_range",
    });
  });

  it("preserves exact-equivalent source attribution without cross-seed merging", async () => {
    const { discover, result } = await runScopeFixture();
    const candidate = selectedSeedACandidate(discover);
    const seedAFamily = result.payload.families.find(
      (family) => family.seedId === candidate.seedId,
    )!;
    expect(candidate.sourceClaimRecordIds).toHaveLength(2);
    expect(seedAFamily.sourceClaimRecordIds).toEqual(
      [...candidate.sourceClaimRecordIds].sort(),
    );
    expect(seedAFamily.candidateIds).toEqual([candidate.candidateId]);

    const equivalentFamilies = result.payload.families.filter(
      (family) =>
        family.normalizedClaim === "the seed showed a measurable effect.",
    );
    expect(equivalentFamilies).toHaveLength(2);
    expect(
      new Set(equivalentFamilies.map((family) => family.seedId)).size,
    ).toBe(2);
    expect(
      new Set(equivalentFamilies.map((family) => family.familyId)).size,
    ).toBe(2);
  });

  it("merges same-seed equivalent candidates without losing any source membership", async () => {
    const originalDiscover = await discoverFixture();
    const discover = splitEquivalentCandidate(originalDiscover);
    const calls = new Map<string, number>();
    const result = await runScope(discover, scopeAdapters({}, calls), {
      recordedAt: "2026-07-16T12:10:00.000Z",
    });
    const seedA = discover.payload.seeds.find(
      (seed) => seed.doi === "10.1000/seed-a",
    )!;
    const equivalentCandidates = discover.payload.claimCandidates.filter(
      (candidate) =>
        candidate.seedId === seedA.seedId &&
        candidate.normalizedClaim === "the seed showed a measurable effect.",
    );
    const family = result.payload.families.find(
      (entry) => entry.seedId === seedA.seedId,
    )!;
    expect(equivalentCandidates).toHaveLength(2);
    expect(family.candidateIds).toEqual(
      equivalentCandidates.map((candidate) => candidate.candidateId).sort(),
    );
    expect(family.sourceClaimRecordIds).toEqual(
      equivalentCandidates
        .flatMap((candidate) => candidate.sourceClaimRecordIds)
        .sort(),
    );
    expect(family.includedCitationOccurrenceIds).toEqual(
      equivalentCandidates
        .flatMap((candidate) => candidate.memberMentionIds)
        .sort(),
    );
    expect(calls.get(seedA.seedId)).toBe(1);
  });

  it.each(["grounded", "ambiguous", "not_found"] as const)(
    "keeps unchanged membership for %s grounding",
    async (groundingStatus) => {
      const { discover, result } = await runScopeFixture({ groundingStatus });
      const candidate = selectedSeedACandidate(discover);
      const family = result.payload.families.find(
        (entry) => entry.seedId === candidate.seedId,
      )!;
      expect(family.grounding.status).toBe(groundingStatus);
      expect(family.includedCitationOccurrenceIds).toEqual(
        [...candidate.memberMentionIds].sort(),
      );
    },
  );

  it.each([
    ["seed_text_unavailable", { seedUnavailable: true }],
    ["acquisition_failed", { acquisitionFailed: true }],
  ] as const)(
    "keeps operational %s distinct from scientific not_found",
    async (expectedStatus, options) => {
      const { discover, result } = await runScopeFixture(options);
      const candidate = selectedSeedACandidate(discover);
      const family = result.payload.families.find(
        (entry) => entry.seedId === candidate.seedId,
      )!;
      expect(family.grounding.status).toBe(expectedStatus);
      expect(family.grounding.status).not.toBe("not_found");
      expect(family.includedCitationOccurrenceIds).toEqual(
        [...candidate.memberMentionIds].sort(),
      );
    },
  );

  it.each(["timeout", "transport"] as const)(
    "preserves nonfatal grounding %s as grounding_failed",
    async (groundingFailureCode) => {
      const { discover, result } = await runScopeFixture({
        groundingFailureCode,
      });
      const candidate = selectedSeedACandidate(discover);
      const family = result.payload.families.find(
        (entry) => entry.seedId === candidate.seedId,
      )!;
      expect(family.grounding).toMatchObject({
        status: "grounding_failed",
        evidenceSpans: [],
        quoteVerification: {
          status: "not_applicable",
          failures: [],
        },
        failure: {
          code: groundingFailureCode,
          reason: `Fixture ${groundingFailureCode} during grounding.`,
        },
      });
      expect(family.grounding.modelExecution).toBeDefined();
      expect(family.includedCitationOccurrenceIds).toEqual(
        [...candidate.memberMentionIds].sort(),
      );
    },
  );

  it("keeps verified spans when some proposed quotes fail exact match", async () => {
    const { result } = await runScopeFixture({ hallucinatedQuote: true });
    expect(
      result.payload.families.every(
        (family) =>
          family.grounding.status === "grounded" &&
          family.grounding.evidenceSpans.length === 1 &&
          family.grounding.evidenceSpans[0]?.text === "primary outcome" &&
          family.grounding.quoteVerification.status === "verified_exact" &&
          family.grounding.detailReason.includes("Dropped 1"),
      ),
    ).toBe(true);
  });

  it("rejects grounding when every proposed quote fails exact match", async () => {
    const { result } = await runScopeFixture({ allHallucinatedQuotes: true });
    expect(
      result.payload.families.every(
        (family) =>
          family.grounding.status === "invalid_grounding_output" &&
          family.grounding.evidenceSpans.length === 0 &&
          family.grounding.quoteVerification.status === "failed",
      ),
    ).toBe(true);
  });

  it("preserves malformed model output as invalid grounding", async () => {
    const { discover, result } = await runScopeFixture({
      invalidGroundingOutput: true,
    });
    const candidate = selectedSeedACandidate(discover);
    const family = result.payload.families.find(
      (entry) => entry.seedId === candidate.seedId,
    )!;
    expect(family.grounding).toMatchObject({
      status: "invalid_grounding_output",
      evidenceSpans: [],
      quoteVerification: { status: "not_applicable" },
    });
    expect(family.includedCitationOccurrenceIds).toEqual(
      [...candidate.memberMentionIds].sort(),
    );
  });

  it("ignores proposed spans on not_found", async () => {
    const contradictoryOutput = {
      status: "not_found" as const,
      detailReason: "Contradictory model output.",
      supportSpans: [
        {
          verbatimQuote: "reports a measurable effect",
          blockId: "body-1",
        },
      ],
    };
    expect(
      scopeGroundingOutputSchema.safeParse(contradictoryOutput).success,
    ).toBe(true);

    const { result } = await runScopeFixture({
      groundingStatus: "not_found",
      notFoundWithSupportSpans: true,
    });
    expect(
      result.payload.families.every(
        (family) =>
          family.grounding.status === "not_found" &&
          family.grounding.evidenceSpans.length === 0 &&
          family.grounding.quoteVerification.status === "not_applicable",
      ),
    ).toBe(true);
  });

  it("orders verified spans independently of model response ordering", async () => {
    const first = await runScopeFixture();
    const reversed = await runScopeFixture({ reverseSupportSpans: true });
    expect(
      first.result.payload.families.map(
        (family) => family.grounding.evidenceSpans,
      ),
    ).toEqual(
      reversed.result.payload.families.map(
        (family) => family.grounding.evidenceSpans,
      ),
    );
  });

  it("materializes seed text once for multiple selected same-seed families", async () => {
    const { discover, result, calls } = await runScopeFixture({
      maxFamilies: 2,
    });
    const seedA = discover.payload.seeds.find(
      (seed) => seed.doi === "10.1000/seed-a",
    )!;
    expect(
      result.payload.families.filter(
        (family) => family.seedId === seedA.seedId,
      ),
    ).toHaveLength(2);
    expect(calls.get(seedA.seedId)).toBe(1);
  });

  it("accounts explicitly for deferred candidates without creating families", async () => {
    const { discover, result } = await runScopeFixture();
    const deferredDiscover = discover.payload.candidateDispositions.filter(
      (disposition) => !disposition.selectedForScope,
    );
    const deferredScope = result.payload.candidateDecisions.filter(
      (decision) => decision.disposition === "deferred_upstream",
    );
    expect(deferredScope.map((decision) => decision.candidateId)).toEqual(
      deferredDiscover.map((disposition) => disposition.candidateId).sort(),
    );
    expect(
      result.payload.families.flatMap((family) => family.candidateIds),
    ).not.toContain(deferredScope[0]!.candidateId);
  });

  it("inventories seeds independently and assesses deferred claims using exact wording", async () => {
    const discover = await discoverFixture();
    const adapters = scopeAdapters({}, new Map());
    const inventoried: string[] = [];
    const matched: string[] = [];
    adapters.inventorySeed = ({ seed }) => {
      inventoried.push(seed.seedId);
      return Promise.resolve({
        status: "completed",
        rawOutput: seed.doi.endsWith("seed-a")
          ? {
              reason: "The paper establishes an effect in its own results.",
              findings: [
                {
                  statement:
                    "The experiment demonstrated a measurable effect on the primary outcome.",
                  ownershipReason:
                    "The Results section reports the authors' outcome.",
                  supportSpans: [
                    {
                      blockId: "body-1",
                      verbatimQuote:
                        "a measurable effect in the primary outcome.",
                    },
                  ],
                },
                {
                  statement: "A result with an unsupported detail.",
                  ownershipReason: "The quoted figures supply the detail.",
                  supportSpans: [
                    {
                      blockId: "body-1",
                      verbatimQuote: "a fabricated numeric result",
                    },
                    { blockId: "body-1", verbatimQuote: "primary outcome" },
                  ],
                },
              ],
            }
          : { reason: "This editorial only cites other work.", findings: [] },
        execution: {
          ...scopeModelExecution(seed.seedId),
          promptId: "scope-seed-inventory",
        },
      });
    };
    adapters.matchStatements = ({ findings, statements }) => {
      matched.push(...statements.map(({ statementId }) => statementId));
      const assessments = statements.flatMap(
        ({ statementId, credit, textSpan }) => {
          if (credit === "shared_reference_group") {
            return [
              {
                statementId,
                relationship: "partial",
                findingIds: [findings[0]!.findingId],
                retained: ["measurable effect"],
                changes: ["omits primary outcome"],
                reason:
                  "The effect is mentioned without naming the measured outcome.",
              },
            ];
          }
          if (textSpan?.text === "distinct outcome") {
            return [
              {
                statementId,
                relationship: "distinct",
                findingIds: [],
                retained: [],
                changes: [],
                reason: "The citing proposition concerns another outcome.",
              },
            ];
          }
          return [];
        },
      );
      return Promise.resolve({
        status: "completed",
        rawOutput: { assessments },
        execution: {
          ...scopeModelExecution("match"),
          promptId: "scope-statement-matching",
        },
      });
    };

    const { payload, provenanceInputs } = await runScope(discover, adapters, {
      recordedAt: "2026-07-16T12:10:00.000Z",
    });
    expect(inventoried).toEqual(
      discover.payload.seeds.map(({ seedId }) => seedId).sort(),
    );
    expect(payload.seedInventories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          rejectedFindingCount: 1,
          findings: [
            expect.objectContaining({
              evidenceSpans: [
                expect.objectContaining({
                  text: "a measurable effect in the primary outcome.",
                  verificationStatus: "verified_exact",
                }),
              ],
            }),
          ],
        }),
        expect.objectContaining({
          status: "no_grounded_findings",
          findings: [],
        }),
      ]),
    );
    expect(payload.citationStatements).toHaveLength(
      discover.payload.attributedClaimRecords.length,
    );
    expect(matched).toHaveLength(3);
    expect(payload.statementAssessments).toHaveLength(1);
    const bundled = payload.citationStatements.find(
      ({ credit }) => credit === "shared_reference_group",
    );
    expect(bundled).toMatchObject({
      sourceVersion: {
        sourceTextHash: canonicalSha256({ paperId: "paper-a1" }),
      },
      textSpan: { text: "measurable effect" },
      assessment: {
        status: "assessed",
        relationship: "partial",
        retained: ["measurable effect"],
      },
    });
    expect(
      payload.citationStatements.find(
        ({ textSpan }) => textSpan?.text === "distinct outcome",
      )?.assessment.relationship,
    ).toBe("distinct");
    for (const status of ["invalid_output", "no_grounded_findings"]) {
      expect(
        payload.citationStatements.find(
          ({ assessment }) => assessment.status === status,
        )?.assessment.relationship,
      ).toBe("unassessed");
    }
    expect(provenanceInputs.prompts.map(({ promptId }) => promptId)).toEqual(
      expect.arrayContaining([
        "scope-seed-inventory",
        "scope-statement-matching",
      ]),
    );
  });

  it("ties credit to the claimed clause and exact reference group", async () => {
    const discover = await discoverFixture();
    const { citationMentions, citingPapers, attributedClaimRecords } =
      discover.payload;
    const claim = attributedClaimRecords[0]!;
    const mention = citationMentions.find(
      ({ mentionId }) => mentionId === claim.mentionId,
    )!;
    const paper = citingPapers.find(
      ({ citingPaperRecordId }) =>
        citingPaperRecordId === mention.citingPaperRecordId,
    )!;
    const rawContext =
      "Neurons are GABAergic (Sabbagh, 2020) and receive direct retinal inputs (Hattar, 2003).";
    const offsets = (text: string) => ({
      charOffsetStart: rawContext.indexOf(text),
      charOffsetEnd: rawContext.indexOf(text) + text.length,
    });
    const citationMarker = "(Sabbagh, 2020)";
    const local = {
      ...mention,
      rawContext,
      citationMarker,
      markerSpan: offsets(citationMarker),
      nearbyCitations: [
        {
          citationMarker: "(Hattar, 2003)",
          markerSpan: offsets("(Hattar, 2003)"),
        },
      ],
      isBundledCitation: false,
      bundleSize: 1,
      bundleRefIds: [],
    };
    const checkCredit = (
      text: string,
      sourceMention = local,
      sourcePaper = paper,
    ) =>
      buildScopeCitationStatements({
        attributedClaimRecords: [
          {
            ...claim,
            supportSpan: {
              text,
              ...offsets(text),
              verificationStatus: "verified_exact",
            },
          },
        ],
        citationMentions: [sourceMention],
        citingPapers: [sourcePaper],
      })[0]?.credit;
    expect(checkCredit("Neurons are GABAergic")).toBe("single_reference");
    expect(checkCredit("receive direct retinal inputs")).toBe("unverified");
    expect(checkCredit(citationMarker)).toBe("unverified");
    expect(
      checkCredit("Neurons are GABAergic", {
        ...local,
        citationMarker: "(Other, 2020)",
      }),
    ).toBe("unverified");
    expect(
      checkCredit("Neurons are GABAergic", local, {
        ...paper,
        bibliographyMatch: {
          method: "author_year_title_overlap",
          refId: "seed-ref",
        },
      }),
    ).toBe("unverified");
  });

  it("fails the stage on fatal provider failures", async () => {
    const discover = await discoverFixture();
    await expect(
      runScope(discover, scopeAdapters({ fatalGrounding: true }, new Map()), {
        recordedAt: "2026-07-16T12:10:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ScopeFatalError);

    await expect(
      runScope(
        discover,
        scopeAdapters(
          { acquisitionFailed: true, fatalMaterialization: true },
          new Map(),
        ),
        { recordedAt: "2026-07-16T12:10:00.000Z" },
      ),
    ).rejects.toBeInstanceOf(ScopeFatalError);
  });

  it("rejects unknown materialization failure codes at the boundary", async () => {
    const discover = await discoverFixture();
    const run = runScope(
      discover,
      scopeAdapters({ unknownMaterializationFailureCode: true }, new Map()),
      { recordedAt: "2026-07-16T12:10:00.000Z" },
    );
    await expect(run).rejects.toBeInstanceOf(ScopeBoundaryError);
    await expect(run).rejects.toThrow(/reasonCode/);
  });

  it("keeps family identity independent of execution and membership content", async () => {
    const first = await runScopeFixture({
      groundingStatus: "grounded",
      model: "fixture-model-a",
    });
    const second = await runScopeFixture({
      groundingStatus: "not_found",
      model: "fixture-model-b",
    });
    expect(
      first.result.payload.families.map((family) => family.familyId),
    ).toEqual(second.result.payload.families.map((family) => family.familyId));

    const family = first.result.payload.families[0]!;
    const identityOnly = {
      seedId: family.seedId,
      normalizedClaim: family.normalizedClaim,
    };
    expect(buildScopedFamilyId(identityOnly)).toBe(family.familyId);
    expect(
      buildScopedFamilyId({
        ...identityOnly,
        seedId: buildStableId("seed", { different: true }),
      }),
    ).not.toBe(family.familyId);
    expect(
      buildScopedFamilyId({
        ...identityOnly,
        normalizedClaim: "a scientifically different claim",
      }),
    ).not.toBe(family.familyId);
  });

  it("rejects dangling, duplicate, and incomplete references", async () => {
    const { result } = await runScopeFixture();
    const fakeId = buildStableId("candidate", { missing: true });

    const dangling = structuredClone(result.payload);
    dangling.families[0]!.candidateIds = [fakeId];
    expectRejected(
      scopeArtifactPayloadSchema,
      dangling,
      /Family candidate references are incomplete or dangling/,
    );

    const duplicate = structuredClone(result.payload);
    duplicate.families[0]!.includedCitationOccurrenceIds.push(
      duplicate.families[0]!.includedCitationOccurrenceIds[0]!,
    );
    expectRejected(
      scopeArtifactPayloadSchema,
      duplicate,
      /Family occurrence membership must exactly equal its Discover candidate membership/,
    );

    const incomplete = structuredClone(result.payload);
    incomplete.families[0]!.includedCitationOccurrenceIds = [];
    expectRejected(
      scopeArtifactPayloadSchema,
      incomplete,
      /Family occurrence membership must exactly equal its Discover candidate membership/,
    );
  });

  it("round-trips only current Scope and detects tampering", async () => {
    const { discover, result } = await runScopeFixture();
    const artifact = buildScopeArtifact({
      result,
      runId: discover.runId,
      createdAt: "2026-07-16T12:15:00.000Z",
      configuration: {
        contentHash: canonicalSha256({ stage: "scope", version: 1 }),
      },
      code: {
        revision: "64890ed",
        dirty: false,
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-scope-"));
    const artifactPath = join(directory, "scope.json");
    try {
      writeArtifact("scope", artifactPath, artifact);
      expect(loadArtifact("scope", artifactPath)).toEqual(artifact);

      const tampered = structuredClone(artifact);
      tampered.payload.families[0]!.claim = "Tampered claim";
      writeFileSync(artifactPath, JSON.stringify(tampered), "utf8");
      expect(() => loadArtifact("scope", artifactPath)).toThrow(
        /contentHash|artifactId/,
      );

      expect(() =>
        writeArtifact("scope", artifactPath, {
          ...artifact,
          artifactVersion: 2,
        } as unknown as typeof artifact),
      ).toThrow(/"path": \[\s*"artifactVersion"/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds a lossless Discover-to-Scope artifact with exact lineage", async () => {
    const { discover, result } = await runScopeFixture();
    const artifact = buildScopeArtifact({
      result,
      runId: discover.runId,
      createdAt: "2026-07-16T12:15:00.000Z",
    });
    expect(artifact.inputArtifacts).toEqual([
      artifact.payload.discoverArtifact,
    ]);
    expect(artifact.payload.discoverArtifact).toMatchObject({
      artifactId: discover.artifactId,
      contentHash: discover.contentHash,
      stage: "discover",
    });
    for (const scoped of artifact.payload.candidateDecisions.filter(
      (decision) => decision.disposition === "scoped",
    )) {
      const candidate = discover.payload.claimCandidates.find(
        (entry) => entry.candidateId === scoped.candidateId,
      )!;
      expect(scoped.sourceClaimRecordIds).toEqual(
        [...candidate.sourceClaimRecordIds].sort(),
      );
      expect(scoped.memberMentionIds).toEqual(
        [...candidate.memberMentionIds].sort(),
      );
    }
    expect(artifact.execution.replayableFromInputs).toBe(false);
  });

  it("rejects a tampered Discover artifact before adapter execution", async () => {
    const discover = await discoverFixture();
    const tampered = structuredClone(discover);
    tampered.payload.citationMentions[0]!.rawContext = "Tampered context";
    const calls = new Map<string, number>();
    await expect(
      runScope(tampered, scopeAdapters({}, calls), {
        recordedAt: "2026-07-16T12:10:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ScopeBoundaryError);
    expect(calls.size).toBe(0);
  });
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("scope grounding concurrency", () => {
  it("primes each seed's cached prefix with one call before fanning out", async () => {
    const discover = await discoverFixture(4);
    const base = scopeAdapters({}, new Map());
    const events: Array<{ seedId: string; phase: "start" | "end" }> = [];
    const result = await runScope(
      discover,
      {
        ...base,
        groundFamily: async (input) => {
          events.push({ seedId: input.seed.seedId, phase: "start" });
          await tick(5);
          const output = await base.groundFamily(input);
          events.push({ seedId: input.seed.seedId, phase: "end" });
          return output;
        },
      },
      { recordedAt: "2026-07-16T12:10:00.000Z", concurrency: 4 },
    );

    const seedIds = new Set(events.map((event) => event.seedId));
    expect(seedIds.size).toBeGreaterThan(0);
    for (const seedId of seedIds) {
      const phases = events
        .filter((event) => event.seedId === seedId)
        .map((event) => event.phase);
      // The first call for a seed completes alone; only then do others start.
      expect(phases.slice(0, 2)).toEqual(
        phases.length === 1 ? ["start", "end"] : ["start", "end"],
      );
      if (phases.length >= 6) {
        // With three or more families the remainder overlap.
        expect(phases.slice(2, 4)).toEqual(["start", "start"]);
      }
    }
    expect(result.payload.families.length).toBe(events.length / 2);
  });

  it("produces the same artifact at any concurrency", async () => {
    const discover = await discoverFixture(4);
    const run = (concurrency: number) =>
      runScope(discover, scopeAdapters({}, new Map()), {
        recordedAt: "2026-07-16T12:10:00.000Z",
        concurrency,
      });
    const sequential = await run(1);
    const parallel = await run(3);
    expect(parallel.payload).toEqual(sequential.payload);
    expect(parallel.provenanceInputs).toEqual(sequential.provenanceInputs);
  });
});
