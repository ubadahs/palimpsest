import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptivePortfolioPolicySchema } from "../../src/contract/candidate-selection-policy.js";

import { describe, expect, it } from "vitest";

import {
  buildClaimCandidateId,
  buildScopedFamilyId,
  createAppendOnlyDecision,
  createLeanStageArtifact,
  discoverArtifactSchema,
  scopeArtifactPayloadSchema,
  type ArtifactReference,
  type DiscoverArtifact,
} from "../../src/contract/lean-artifacts.js";
import {
  buildCanonicalDiscoverArtifact,
  runCanonicalDiscover,
  type CanonicalDiscoverAdapters,
  type CanonicalDiscoverOptions,
} from "../../src/pipeline/canonical-discover.js";
import {
  buildCanonicalScopeArtifact,
  canonicalScopeGroundingOutputSchema,
  CanonicalScopeBoundaryError,
  CanonicalScopeFatalError,
  runCanonicalScope,
  type CanonicalScopeAdapters,
  type CanonicalScopeGroundingOutput,
  type CanonicalScopeResult,
} from "../../src/pipeline/canonical-scope.js";
import {
  loadCanonicalScopeArtifact,
  writeCanonicalScopeArtifact,
} from "../../src/pipeline/canonical-scope-artifact.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

type ScopeFixtureOptions = {
  maxFamilies?: number;
  groundingStatus?: "grounded" | "ambiguous" | "not_found";
  hallucinatedQuote?: boolean;
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

function discoverModelExecution(key: string) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model: "fixture-discover-model",
    promptId: "canonical-attributed-claim-extraction",
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
    promptId: "canonical-scope-grounding",
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
    mentions: mentions.map((mention) => ({
      mentionIndex: mention.mentionIndex,
      refId: "seed-ref",
      targetRefIds: ["seed-ref"],
      charOffsetStart: mention.mentionIndex * 100,
      charOffsetEnd: mention.mentionIndex * 100 + mention.context.length,
      citationMarker: mention.bundled ? "[2–4]" : "[3]",
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
      provenanceArtifacts: [
        artifactReference(
          "citation-occurrence-source",
          `${paperId}-${String(mention.mentionIndex)}`,
        ),
      ],
    })),
  };
}

function discoverOptions(maxFamilies = 1): CanonicalDiscoverOptions {
  return {
    seeds: ["10.1000/seed-a", "10.1000/seed-b"].map((doi) => ({
      doi,
      provenanceArtifacts: [artifactReference("doi-input", doi)],
    })),
    neighborhood: {
      provider: "fixture-citation-index",
      query: "works-citing-seed",
      limit: 10,
    },
    probeBudget: 10,
    candidateSelection: adaptivePortfolioPolicySchema.parse({
      mode: "adaptive_portfolio",
      minFamilies: 1,
      maxFamilies,
      maxPreparedRecords: 1000,
      minMarginalNovelty: 0,
    }),
    recordedAt: "2026-07-16T12:00:00.000Z",
  };
}

function discoverAdapters(): CanonicalDiscoverAdapters {
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

async function buildDiscoverArtifact(
  maxFamilies = 1,
): Promise<DiscoverArtifact> {
  const result = await runCanonicalDiscover(
    discoverOptions(maxFamilies),
    discoverAdapters(),
  );
  return buildCanonicalDiscoverArtifact({
    result,
    runId: "run-canonical-scope-fixture",
    createdAt: "2026-07-16T12:05:00.000Z",
    configuration: {
      contentHash: canonicalSha256(discoverOptions(maxFamilies)),
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
  const fixtureAnnotation =
    discover.payload.candidateDispositions[0]?.annotation ?? {
      policyVersion: "adaptive-portfolio-v1" as const,
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
      lexicalFingerprint: {
        wordShingleHash: canonicalSha256("word"),
        charShingleHash: canonicalSha256("char"),
        wordShingles: ["fixture claim text"],
      },
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
        identifier: "canonical-discover-candidate-ranking-v1",
      },
      evidenceArtifacts: candidate.provenanceArtifacts,
    });
  });
  const artifact = createLeanStageArtifact({
    schemaVersion: discover.schemaVersion,
    artifactVersion: discover.artifactVersion,
    runId: discover.runId,
    createdAt: discover.createdAt,
    canonicalStage: "discover",
    inputArtifacts: discover.inputArtifacts,
    provenance: discover.provenance,
    execution: discover.execution,
    decisions: [
      ...discover.decisions.filter(
        (decision) => decision.decisionType !== "discover_scope_disposition",
      ),
      ...scopeDecisions,
    ],
    exclusions: discover.exclusions,
    payload: {
      ...discover.payload,
      claimCandidates,
      candidateDispositions,
    },
  });
  return discoverArtifactSchema.parse(artifact);
}

function scopeAdapters(
  options: ScopeFixtureOptions,
  materializationCalls: Map<string, number>,
): CanonicalScopeAdapters {
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
      const supportSpans = [
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
      const output: CanonicalScopeGroundingOutput =
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
                  ? "The seed manuscript directly supports the tracked claim."
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
  result: CanonicalScopeResult;
  calls: Map<string, number>;
}> {
  const discover = await buildDiscoverArtifact(options.maxFamilies ?? 1);
  const calls = new Map<string, number>();
  const result = await runCanonicalScope(
    discover,
    scopeAdapters(options, calls),
    {
      recordedAt: "2026-07-16T12:10:00.000Z",
      discoverArtifactUri: "fixture://canonical-discover/discover.json",
    },
  );
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

describe("canonical Scope", () => {
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
    const originalDiscover = await buildDiscoverArtifact();
    const discover = splitEquivalentCandidate(originalDiscover);
    const calls = new Map<string, number>();
    const result = await runCanonicalScope(discover, scopeAdapters({}, calls), {
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

  it("rejects a hallucinated quote instead of accepting grounding evidence", async () => {
    const { result } = await runScopeFixture({ hallucinatedQuote: true });
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

  it("rejects not_found output with proposed evidence at both boundaries", async () => {
    const contradictoryOutput = {
      status: "not_found",
      detailReason: "Contradictory model output.",
      supportSpans: [
        {
          verbatimQuote: "reports a measurable effect",
          blockId: "body-1",
        },
      ],
    };
    expect(
      canonicalScopeGroundingOutputSchema.safeParse(contradictoryOutput)
        .success,
    ).toBe(false);

    const { result } = await runScopeFixture({
      groundingStatus: "not_found",
      notFoundWithSupportSpans: true,
    });
    expect(
      result.payload.families.every(
        (family) =>
          family.grounding.status === "invalid_grounding_output" &&
          family.grounding.evidenceSpans.length === 0,
      ),
    ).toBe(true);

    const grounded = await runScopeFixture();
    const invalidArtifactPayload = structuredClone(grounded.result.payload);
    invalidArtifactPayload.families[0]!.grounding.status = "not_found";
    expect(
      scopeArtifactPayloadSchema.safeParse(invalidArtifactPayload).success,
    ).toBe(false);
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

  it("fails the stage on fatal provider failures", async () => {
    const discover = await buildDiscoverArtifact();
    await expect(
      runCanonicalScope(
        discover,
        scopeAdapters({ fatalGrounding: true }, new Map()),
        { recordedAt: "2026-07-16T12:10:00.000Z" },
      ),
    ).rejects.toBeInstanceOf(CanonicalScopeFatalError);

    await expect(
      runCanonicalScope(
        discover,
        scopeAdapters(
          { acquisitionFailed: true, fatalMaterialization: true },
          new Map(),
        ),
        { recordedAt: "2026-07-16T12:10:00.000Z" },
      ),
    ).rejects.toBeInstanceOf(CanonicalScopeFatalError);
  });

  it("rejects unknown materialization failure codes at the boundary", async () => {
    const discover = await buildDiscoverArtifact();
    const run = runCanonicalScope(
      discover,
      scopeAdapters({ unknownMaterializationFailureCode: true }, new Map()),
      { recordedAt: "2026-07-16T12:10:00.000Z" },
    );
    await expect(run).rejects.toBeInstanceOf(CanonicalScopeBoundaryError);
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

  it("rejects dangling, cross-seed, duplicate, and incomplete references", async () => {
    const { result } = await runScopeFixture();
    const family = result.payload.families[0]!;
    const otherSeed = result.payload.families.find(
      (entry) => entry.seedId !== family.seedId,
    )!.seedId;
    const fakeId = buildStableId("candidate", { missing: true });

    const dangling = structuredClone(result.payload);
    dangling.families[0]!.candidateIds = [fakeId];
    expect(scopeArtifactPayloadSchema.safeParse(dangling).success).toBe(false);

    const crossSeed = structuredClone(result.payload);
    const scopedDecision = crossSeed.candidateDecisions.find(
      (decision) =>
        decision.disposition === "scoped" &&
        decision.familyId === family.familyId,
    )!;
    scopedDecision.seedId = otherSeed;
    expect(scopeArtifactPayloadSchema.safeParse(crossSeed).success).toBe(false);

    const duplicate = structuredClone(result.payload);
    duplicate.families[0]!.includedCitationOccurrenceIds.push(
      duplicate.families[0]!.includedCitationOccurrenceIds[0]!,
    );
    expect(scopeArtifactPayloadSchema.safeParse(duplicate).success).toBe(false);

    const incomplete = structuredClone(result.payload);
    incomplete.families[0]!.includedCitationOccurrenceIds = [];
    expect(scopeArtifactPayloadSchema.safeParse(incomplete).success).toBe(
      false,
    );
  });

  it("round-trips only current Scope and detects tampering", async () => {
    const { discover, result } = await runScopeFixture();
    const artifact = buildCanonicalScopeArtifact({
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
      writeCanonicalScopeArtifact(artifactPath, artifact);
      expect(loadCanonicalScopeArtifact(artifactPath)).toEqual(artifact);

      const tampered = structuredClone(artifact);
      tampered.payload.families[0]!.trackedClaim = "Tampered claim";
      writeFileSync(artifactPath, JSON.stringify(tampered), "utf8");
      expect(() => loadCanonicalScopeArtifact(artifactPath)).toThrow(
        /contentHash|artifactId/,
      );

      expect(() =>
        writeCanonicalScopeArtifact(artifactPath, {
          ...artifact,
          artifactVersion: 2,
        } as unknown as typeof artifact),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds a lossless Discover-to-Scope artifact with exact lineage", async () => {
    const { discover, result } = await runScopeFixture();
    const artifact = buildCanonicalScopeArtifact({
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
      canonicalStage: "discover",
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
    expect(artifact.exclusions).toEqual([]);
  });

  it("rejects a tampered Discover artifact before adapter execution", async () => {
    const discover = await buildDiscoverArtifact();
    const tampered = structuredClone(discover);
    tampered.payload.citationMentions[0]!.rawContext = "Tampered context";
    const calls = new Map<string, number>();
    await expect(
      runCanonicalScope(tampered, scopeAdapters({}, calls), {
        recordedAt: "2026-07-16T12:10:00.000Z",
      }),
    ).rejects.toBeInstanceOf(CanonicalScopeBoundaryError);
    expect(calls.size).toBe(0);
  });
});
