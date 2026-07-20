import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";
import {
  buildEvidenceRerankRunId,
  buildEvidenceSelectionId,
  evidenceArtifactPayloadSchema,
  evidenceRerankOutputSchema,
  evidenceSelectionSchema,
  type ArtifactReference,
  type DiscoverArtifact,
  type EvidenceArtifact,
  type PrepareArtifact,
  type ScopeArtifact,
} from "../../src/contract/lean-artifacts.js";
import {
  buildCanonicalDiscoverArtifact,
  runCanonicalDiscover,
  type CanonicalDiscoverAdapters,
  type CanonicalDiscoverOptions,
} from "../../src/pipeline/canonical-discover.js";
import {
  buildCanonicalScopeArtifact,
  runCanonicalScope,
  type CanonicalScopeAdapters,
} from "../../src/pipeline/canonical-scope.js";
import {
  buildCanonicalPrepareArtifact,
  runCanonicalPrepare,
  type CanonicalPrepareAdapters,
} from "../../src/pipeline/canonical-prepare.js";
import {
  buildCanonicalEvidenceArtifact,
  CanonicalEvidenceBoundaryError,
  CanonicalEvidenceFatalError,
  runCanonicalEvidence,
  type CanonicalEvidenceRerankerInput,
} from "../../src/pipeline/canonical-evidence.js";
import {
  loadCanonicalEvidenceArtifact,
  writeCanonicalEvidenceArtifact,
} from "../../src/pipeline/canonical-evidence-artifact.js";
import {
  buildScopedFamilyEvidenceQuery,
  chunkScopeSeedText,
  retrieveEvidenceByBm25,
} from "../../src/retrieval/canonical-evidence-retrieval.js";

type GroundingVariant =
  | "grounded"
  | "not_found"
  | "grounding_failed"
  | "seed_text_unavailable"
  | "acquisition_failed";
type RerankVariant =
  | "success"
  | "unknown_id"
  | "duplicate_id"
  | "empty"
  | "malformed"
  | "nonfatal_failure"
  | "fatal_failure";

const TRACKED_CLAIM =
  "Rab35 silencing causes loss of apical bulkheads and cyst formation.";
const SOURCE_BLOCKS = [
  {
    blockId: "scope-block-abstract",
    text: "The abstract describes epithelial lumen organization and general polarity controls.",
    sectionTitle: "Abstract",
    blockKind: "abstract" as const,
  },
  {
    blockId: "scope-block-results",
    text: "Silencing Rab35 caused loss of apical bulkheads and cyst formation in hepatocytes. The resulting lumens lost their normal anisotropy.",
    sectionTitle: "Results",
    blockKind: "body_paragraph" as const,
  },
  {
    blockId: "scope-block-methods",
    text: "Rab35 was silenced with a validated small interfering RNA protocol before confocal imaging.",
    sectionTitle: "Methods",
    blockKind: "body_paragraph" as const,
  },
];

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

function modelExecution(
  purpose: "discover" | "scope" | "rerank",
  key: string,
  model = `fixture-${purpose}-model`,
) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model,
    promptId: `canonical-${purpose}-prompt`,
    promptVersion: "v1",
    promptContentHash: canonicalSha256({ purpose, prompt: "fixture" }),
    requestHash: canonicalSha256({
      purpose,
      key,
      model,
      direction: "request",
    }),
    requestArtifact: artifactReference(
      "model-request",
      `${purpose}-${key}-${model}`,
    ),
    responseArtifact: artifactReference(
      "model-response",
      `${purpose}-${key}-${model}`,
    ),
  };
}

function discoverOptions(claim: string): CanonicalDiscoverOptions {
  return {
    seeds: [
      {
        doi: "10.1000/evidence-seed",
        provenanceArtifacts: [
          artifactReference("doi-input", "10.1000/evidence-seed"),
        ],
      },
    ],
    neighborhood: {
      provider: "fixture-citation-index",
      query: "works-citing-evidence-seed",
      limit: 10,
    },
    probeBudget: 10,
    scopeCandidateCap: 5,
    recordedAt: "2026-07-17T08:00:00.000Z",
    ...(claim === TRACKED_CLAIM ? {} : {}),
  };
}

function discoverAdapters(claim: string): CanonicalDiscoverAdapters {
  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: "seed-paper",
          providerRecordId: "provider-seed-paper",
          title: "Seed evidence paper",
          doi,
          authors: ["Seed Author"],
          publicationYear: 2020,
        },
        execution: externalExecution("fixture-resolver", "seed"),
      }),
    retrieveCitingNeighborhood: () =>
      Promise.resolve({
        status: "completed",
        providerReportedTotal: 1,
        coverage: "complete",
        papers: [
          {
            providerRecordId: "provider-citing-paper",
            paperId: "citing-paper",
            title: "Citing paper",
            doi: "10.2000/citing-paper",
            authors: ["Citing Author"],
            publicationYear: 2025,
            fullTextAvailability: "available",
            provenanceArtifacts: [
              artifactReference("provider-paper", "citing-paper"),
            ],
          },
        ],
        execution: externalExecution("fixture-citation-index", "neighborhood"),
      }),
    harvestMentions: () =>
      Promise.resolve({
        materialization: {
          status: "succeeded",
          reason: "Fixture citing text materialized.",
          provenanceArtifacts: [
            artifactReference("raw-citing-paper", "citing-paper"),
          ],
        },
        harvest: {
          status: "succeeded",
          reason: "Two distinct occurrences were harvested.",
          provenanceArtifacts: [
            artifactReference("mention-harvest", "citing-paper"),
          ],
        },
        mentions: [
          {
            mentionIndex: 0,
            refId: "seed-ref",
            charOffsetStart: 100,
            charOffsetEnd: 158,
            sourceLocator: {
              kind: "xml_path" as const,
              value: "/article/body/sec[1]/p[1]/xref[1]",
            },
            citationMarker: "[3]",
            rawContext: "The reported phenotype followed Rab35 depletion [3].",
            sectionTitle: "Results",
            seedRefLabel: "Seed Author, 2020",
            isBundledCitation: false,
            bundleSize: 1,
            bundleRefIds: ["seed-ref"],
            bundlePattern: "single" as const,
            sourceType: "jats_xml" as const,
            parser: "fixture-parser-a",
            parserVersion: "1.0.0",
            provenanceArtifacts: [
              artifactReference("occurrence-source", "occurrence-0"),
            ],
          },
          {
            mentionIndex: 1,
            refId: "seed-ref",
            charOffsetStart: 300,
            charOffsetEnd: 354,
            sourceLocator: {
              kind: "xml_path" as const,
              value: "/article/body/sec[2]/p[2]/xref[2]",
            },
            citationMarker: "[3–5]",
            rawContext:
              "Bulkhead defects are discussed with several references [3–5].",
            sectionTitle: "Discussion",
            seedRefLabel: "Seed Author, 2020",
            isBundledCitation: true,
            bundleSize: 3,
            bundleRefIds: ["seed-ref", "other-4", "other-5"],
            bundlePattern: "numeric_range" as const,
            sourceType: "jats_xml" as const,
            parser: "fixture-parser-b",
            parserVersion: "2.0.0",
            provenanceArtifacts: [
              artifactReference("occurrence-source", "occurrence-1"),
            ],
          },
        ],
      }),
    extractAttributedClaims: ({ mention }) =>
      Promise.resolve({
        status: "completed",
        reason: "Fixture attributed claim extracted.",
        claims: [
          {
            text:
              mention.mentionIndex === 0 ? claim : `  ${claim.toUpperCase()}  `,
            supportSpanText:
              mention.mentionIndex === 0
                ? "reported phenotype"
                : "Bulkhead defects",
            confidence: mention.mentionIndex === 0 ? "high" : "medium",
          },
        ],
        execution: modelExecution(
          "discover",
          `occurrence-${String(mention.mentionIndex)}`,
        ),
      }),
  };
}

function materializedBlocks(blocks = SOURCE_BLOCKS): Array<{
  blockId: string;
  text: string;
  sectionTitle: string;
  blockKind: "abstract" | "body_paragraph";
  charOffsetStart: number;
  charOffsetEnd: number;
}> {
  let offset = 0;
  return blocks.map((block) => {
    const charOffsetStart = offset;
    const charOffsetEnd = charOffsetStart + block.text.length;
    offset = charOffsetEnd + 2;
    return { ...block, charOffsetStart, charOffsetEnd };
  });
}

function scopeAdapters(
  grounding: GroundingVariant,
  blocks = SOURCE_BLOCKS,
): CanonicalScopeAdapters {
  return {
    materializeSeed: ({ seed }) => {
      const execution = {
        kind: "external" as const,
        ...externalExecution("fixture-full-text", seed.seedId),
      };
      if (
        grounding === "seed_text_unavailable" ||
        grounding === "acquisition_failed"
      ) {
        return Promise.resolve({
          seedId: seed.seedId,
          status: grounding,
          reasonCode:
            grounding === "seed_text_unavailable"
              ? ("unavailable" as const)
              : ("transport" as const),
          reason:
            grounding === "seed_text_unavailable"
              ? "No inspectable seed manuscript was available."
              : "Seed manuscript acquisition failed in transit.",
          provenanceArtifacts: [
            artifactReference("seed-acquisition-trace", grounding),
          ],
          execution,
        });
      }
      return Promise.resolve({
        seedId: seed.seedId,
        status: "materialized",
        reason: "Fixture seed manuscript materialized.",
        seedTextArtifact: artifactReference("parsed-seed-text", seed.seedId),
        sourceArtifacts: [
          artifactReference("raw-seed-manuscript", seed.seedId),
        ],
        parser: {
          kind: "fixture-structured-parser",
          version: "v1",
        },
        blocks: materializedBlocks(blocks),
        execution,
      });
    },
    groundFamily: ({ family }) => {
      const execution = {
        ...modelExecution("scope", family.familyId),
      };
      if (grounding === "grounding_failed") {
        return Promise.resolve({
          status: "failed",
          reasonCode: "timeout",
          reason: "Fixture Scope grounding timed out.",
          execution,
        });
      }
      return Promise.resolve({
        status: "completed",
        rawOutput:
          grounding === "not_found"
            ? {
                status: "not_found",
                detailReason: "No direct seed support was found.",
                supportSpans: [],
              }
            : {
                status: "grounded",
                detailReason: "The Results block directly reports the claim.",
                supportSpans: [
                  {
                    verbatimQuote:
                      "Silencing Rab35 caused loss of apical bulkheads and cyst formation in hepatocytes.",
                    blockId: "scope-block-results",
                  },
                ],
              },
        execution,
      });
    },
  };
}

function prepareAdapters(
  classificationFailure = false,
): CanonicalPrepareAdapters {
  return {
    classifyCitation: ({ citationOccurrence }) =>
      Promise.resolve(
        citationOccurrence.mentionIndex === 0
          ? {
              status: "classified",
              citationRole: "substantive_attribution",
              evaluationMode: "fidelity_specific_claim",
              modifiers: {
                isBundled: false,
                isReviewMediated: false,
                bundleSize: 1,
              },
              signals: ["fixture:direct-attribution"],
              rationale: "The first occurrence makes a direct attribution.",
              confidence: "high",
              execution: {
                kind: "deterministic",
                implementation: "fixture-classifier-v1",
              },
            }
          : classificationFailure
            ? {
                status: "failed",
                reasonCode: "timeout",
                reason: "Fixture classification timed out.",
                execution: {
                  kind: "external",
                  ...externalExecution("fixture-classifier", "occurrence-1"),
                },
              }
            : {
                status: "classified",
                citationRole: "background_context",
                evaluationMode: "fidelity_bundled_use",
                modifiers: {
                  isBundled: true,
                  isReviewMediated: false,
                  bundleSize: 3,
                },
                signals: ["fixture:bundled-background"],
                rationale: "The second occurrence is bundled background.",
                confidence: "medium",
                execution: {
                  kind: "deterministic",
                  implementation: "fixture-classifier-v1",
                },
              },
      ),
  };
}

async function buildPrepareAncestors(
  options: {
    grounding?: GroundingVariant;
    claim?: string;
    blocks?: typeof SOURCE_BLOCKS;
    runId?: string;
    classificationFailure?: boolean;
  } = {},
): Promise<{
  discover: DiscoverArtifact;
  scope: ScopeArtifact;
  prepare: PrepareArtifact;
}> {
  const claim = options.claim ?? TRACKED_CLAIM;
  const discoverResult = await runCanonicalDiscover(
    discoverOptions(claim),
    discoverAdapters(claim),
  );
  const discover = buildCanonicalDiscoverArtifact({
    result: discoverResult,
    runId: options.runId ?? "run-canonical-evidence-fixture",
    createdAt: "2026-07-17T08:05:00.000Z",
  });
  const scopeResult = await runCanonicalScope(
    discover,
    scopeAdapters(options.grounding ?? "grounded", options.blocks),
    {
      recordedAt: "2026-07-17T08:10:00.000Z",
      discoverArtifactUri: "fixture://canonical-discover/discover.json",
    },
  );
  const scope = buildCanonicalScopeArtifact({
    result: scopeResult,
    runId: discover.runId,
    createdAt: "2026-07-17T08:15:00.000Z",
  });
  const prepareResult = await runCanonicalPrepare(
    scope,
    discover,
    prepareAdapters(options.classificationFailure),
    {
      recordedAt: "2026-07-17T08:20:00.000Z",
      scopeArtifactUri: "fixture://canonical-scope/scope.json",
    },
  );
  const prepare = buildCanonicalPrepareArtifact({
    result: prepareResult,
    runId: discover.runId,
    createdAt: "2026-07-17T08:25:00.000Z",
  });
  return { discover, scope, prepare };
}

function rerankerAdapter(
  variant: RerankVariant,
  calls: CanonicalEvidenceRerankerInput[],
  model: string,
) {
  return (input: CanonicalEvidenceRerankerInput) => {
    calls.push(input);
    const execution = {
      ...modelExecution("rerank", input.bm25RunId, model),
    };
    if (variant === "nonfatal_failure" || variant === "fatal_failure") {
      return Promise.resolve({
        status: "failed",
        reasonCode:
          variant === "fatal_failure" ? "quota" : ("timeout" as const),
        reason:
          variant === "fatal_failure"
            ? "Fixture reranker quota exhausted."
            : "Fixture reranker timed out.",
        execution,
      });
    }
    if (variant === "malformed") {
      return Promise.resolve({
        status: "completed",
        rawOutput: { results: "not-an-array" },
        execution,
      });
    }
    const firstId = input.candidates[0]!.chunkId;
    const resultId =
      variant === "unknown_id"
        ? buildStableId("evidence-chunk", { missing: true })
        : firstId;
    const results =
      variant === "empty"
        ? []
        : variant === "duplicate_id"
          ? [
              {
                chunkId: firstId,
                relevanceScore: 99,
                rank: 1,
                rationale: "Most relevant candidate.",
              },
              {
                chunkId: firstId,
                relevanceScore: 90,
                rank: 2,
                rationale: "Illegally duplicated candidate.",
              },
            ]
          : [
              {
                chunkId: resultId,
                relevanceScore: 99,
                rank: 1,
                rationale:
                  "This passage is most relevant to the declared family claim.",
              },
            ];
    return Promise.resolve({
      status: "completed",
      rawOutput: { results },
      execution,
    });
  };
}

async function runEvidenceFixture(
  options: {
    grounding?: GroundingVariant;
    claim?: string;
    blocks?: typeof SOURCE_BLOCKS;
    rerankEnabled?: boolean;
    rerankVariant?: RerankVariant;
    model?: string;
    classificationFailure?: boolean;
  } = {},
) {
  const ancestors = await buildPrepareAncestors(options);
  const calls: CanonicalEvidenceRerankerInput[] = [];
  const rerankEnabled = options.rerankEnabled ?? false;
  const result = await runCanonicalEvidence(
    ancestors.prepare,
    ancestors.scope,
    rerankEnabled
      ? {
          rerank: rerankerAdapter(
            options.rerankVariant ?? "success",
            calls,
            options.model ?? "fixture-reranker-a",
          ),
        }
      : {},
    {
      recordedAt: "2026-07-17T08:30:00.000Z",
      prepareArtifactUri: "fixture://canonical-prepare/prepare.json",
      scopeArtifactUri: "fixture://canonical-scope/scope.json",
      reranking: rerankEnabled
        ? { enabled: true, topN: 3 }
        : { enabled: false },
    },
  );
  return { ...ancestors, result, calls };
}

function materializationFrom(scope: ScopeArtifact) {
  const materialization = scope.payload.seedMaterializations[0];
  if (!materialization || materialization.status !== "materialized") {
    throw new Error("Expected a materialized fixture seed manuscript");
  }
  return materialization;
}

describe("canonical Evidence", () => {
  it("chunks Scope blocks deterministically with stable exact spans", async () => {
    const { scope } = await buildPrepareAncestors();
    const materialization = materializationFrom(scope);
    const configuration = {
      version: "canonical-evidence-chunking-v1" as const,
      strategy: "scope-block-character-windows" as const,
      boundaryRule: "fixed-character" as const,
      maxCharacters: 50,
      overlapCharacters: 10,
      sourceOrdering: "scope-block-offset-then-chunk-offset" as const,
    };
    const first = chunkScopeSeedText(materialization, configuration);
    const second = chunkScopeSeedText(materialization, configuration);

    expect(second).toEqual(first);
    expect(first.chunks.length).toBeGreaterThan(SOURCE_BLOCKS.length);
    expect(first.chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      first.chunks.map((_, index) => index),
    );
    for (const chunk of first.chunks) {
      const block = materialization.blocks.find(
        (entry) => entry.blockId === chunk.sourceBlockId,
      )!;
      expect(chunk.text).toBe(
        block.text.slice(
          chunk.charOffsetStart - block.charOffsetStart,
          chunk.charOffsetEnd - block.charOffsetStart,
        ),
      );
      expect(chunk.text).not.toContain("...");
      expect(chunk.contentHash).toBe(canonicalSha256(chunk.text));
    }
  });

  it("retains deterministic BM25 raw scores, ranks, and tie-breaking", async () => {
    const { scope } = await buildPrepareAncestors();
    const family = scope.payload.families[0]!;
    const query = buildScopedFamilyEvidenceQuery(family);
    const corpus = chunkScopeSeedText(materializationFrom(scope));
    const first = retrieveEvidenceByBm25({
      familyId: family.familyId,
      query,
      corpus,
      candidateLimit: 20,
    });
    const second = retrieveEvidenceByBm25({
      familyId: family.familyId,
      query,
      corpus,
      candidateLimit: 20,
    });

    expect(second).toEqual(first);
    expect(first.status).toBe("matched");
    expect(first.candidates[0]!.rank).toBe(1);
    expect(first.candidates[0]!.rawScore).toBeGreaterThan(0);
    expect(
      corpus.chunks.find(
        (chunk) => chunk.chunkId === first.candidates[0]!.chunkId,
      )!.sourceBlockId,
    ).toBe("scope-block-results");
    for (let index = 1; index < first.candidates.length; index++) {
      const previous = first.candidates[index - 1]!;
      const current = first.candidates[index]!;
      expect(current.rank).toBe(index + 1);
      if (current.rawScore === previous.rawScore) {
        expect(previous.chunkId < current.chunkId).toBe(true);
      }
    }
  });

  it("reuses one family query, corpus, and BM25 run across unlike occurrences", async () => {
    const { prepare, result } = await runEvidenceFixture();
    expect(prepare.payload.records).toHaveLength(2);
    expect(
      new Set(
        prepare.payload.records.map((record) =>
          canonicalSerialize({
            context: record.context.verbatim.text,
            localClaims: record.occurrenceSourceClaimRecords,
            classification: record.classification,
          }),
        ),
      ).size,
    ).toBe(2);
    expect(result.payload.records).toHaveLength(2);
    expect(
      new Set(result.payload.records.map((record) => record.queryId)).size,
    ).toBe(1);
    expect(
      new Set(result.payload.records.map((record) => record.corpusId)).size,
    ).toBe(1);
    expect(
      new Set(result.payload.records.map((record) => record.bm25RunId)).size,
    ).toBe(1);
    expect(result.payload.queries[0]!.text).toBe(
      prepare.payload.scopedFamilies[0]!.trackedClaim,
    );
    expect(result.payload.bm25Runs).toHaveLength(1);
  });

  it("keeps grounded and not_found BM25 identical while labeling query provenance", async () => {
    const grounded = await runEvidenceFixture({ grounding: "grounded" });
    const notFound = await runEvidenceFixture({ grounding: "not_found" });

    expect(notFound.result.payload.corpora).toEqual(
      grounded.result.payload.corpora,
    );
    expect(notFound.result.payload.bm25Runs).toEqual(
      grounded.result.payload.bm25Runs,
    );
    expect(notFound.result.payload.queries[0]).toMatchObject({
      queryId: grounded.result.payload.queries[0]!.queryId,
      text: grounded.result.payload.queries[0]!.text,
      groundingStatus: "not_found",
      verificationStatus: "unverified_attributed_claim",
    });
    expect(grounded.result.payload.queries[0]!.verificationStatus).toBe(
      "scope_grounded",
    );
  });

  it("accounts for every Prepare record without sampling or collapse", async () => {
    const { prepare, result } = await runEvidenceFixture();
    expect(result.payload.preparedRecords).toEqual(
      prepare.payload.records.map((record) => ({
        recordId: record.recordId,
        familyId: record.familyId,
        citationOccurrenceId: record.citationOccurrenceId,
        seedId: record.seed.seedId,
      })),
    );
    expect(result.payload.records.map((record) => record.recordId)).toEqual(
      prepare.payload.records.map((record) => record.recordId),
    );
    expect(result.decisions).toHaveLength(prepare.payload.records.length * 3);
    expect(result.exclusions).toEqual([]);
  });

  it("retrieves for preserved grounding and classification failures", async () => {
    const { prepare, result } = await runEvidenceFixture({
      grounding: "grounding_failed",
      classificationFailure: true,
    });
    expect(prepare.payload.records).toHaveLength(2);
    expect(
      prepare.payload.records.every(
        (record) => record.family.grounding.status === "grounding_failed",
      ),
    ).toBe(true);
    expect(
      prepare.payload.records.some(
        (record) => record.classification.status === "failed",
      ),
    ).toBe(true);
    expect(result.payload.records).toHaveLength(prepare.payload.records.length);
    expect(
      result.payload.records.every(
        (record) => record.retrievalStatus === "retrieved",
      ),
    ).toBe(true);
    expect(result.payload.queries[0]).toMatchObject({
      groundingStatus: "grounding_failed",
      verificationStatus: "unverified_attributed_claim",
    });
  });

  it("distinguishes unavailable text, acquisition failure, and zero matches", async () => {
    const unavailable = await runEvidenceFixture({
      grounding: "seed_text_unavailable",
    });
    const acquisition = await runEvidenceFixture({
      grounding: "acquisition_failed",
    });
    const noMatches = await runEvidenceFixture({
      claim: "Quasar neutrinos reverse tungsten precession.",
    });
    const noMatchesWithReranking = await runEvidenceFixture({
      claim: "Quasar neutrinos reverse tungsten precession.",
      rerankEnabled: true,
    });

    expect(
      unavailable.result.payload.records.map(
        (record) => record.retrievalStatus,
      ),
    ).toEqual(["seed_text_unavailable", "seed_text_unavailable"]);
    expect(
      acquisition.result.payload.records.map(
        (record) => record.retrievalStatus,
      ),
    ).toEqual(["seed_acquisition_failed", "seed_acquisition_failed"]);
    expect(
      noMatches.result.payload.records.map((record) => record.retrievalStatus),
    ).toEqual(["no_lexical_matches", "no_lexical_matches"]);
    expect(noMatches.result.payload.bm25Runs[0]).toMatchObject({
      status: "no_lexical_matches",
      candidates: [],
    });
    expect(noMatches.result.payload.selections).toEqual([]);
    expect(
      noMatches.result.payload.records.every(
        (record) => record.finalSelectionId == null,
      ),
    ).toBe(true);
    const noMatchSelectionDecisions = noMatches.result.decisions.filter(
      (decision) => decision.decisionType === "evidence_final_selection",
    );
    expect(
      noMatchSelectionDecisions.map((decision) => decision.outcome),
    ).toEqual(["not_available", "not_available"]);
    expect(
      noMatchSelectionDecisions.every((decision) =>
        decision.reason.includes("no lexical candidates"),
      ),
    ).toBe(true);
    expect(noMatchesWithReranking.calls).toEqual([]);
    expect(noMatchesWithReranking.result.payload.selections).toEqual([]);
    expect(
      noMatchesWithReranking.result.payload.records.map(
        (record) => record.rerankStatus,
      ),
    ).toEqual(["not_attempted_no_candidates", "not_attempted_no_candidates"]);
    expect(unavailable.result.payload.bm25Runs).toEqual([]);
    expect(acquisition.result.payload.bm25Runs).toEqual([]);
    expect(unavailable.result.payload.selections).toEqual([]);
    expect(acquisition.result.payload.selections).toEqual([]);
  });

  it("requires nonempty selections only for retrieved outcomes", async () => {
    const matched = await runEvidenceFixture();
    const noMatches = await runEvidenceFixture({
      claim: "Quasar neutrinos reverse tungsten precession.",
    });
    const emptySelection = structuredClone(
      matched.result.payload.selections[0]!,
    );
    emptySelection.selectedChunkIds = [];
    emptySelection.selectionContentHash = canonicalSha256([]);
    emptySelection.selectionId = buildEvidenceSelectionId(emptySelection);
    expect(evidenceSelectionSchema.safeParse(emptySelection).success).toBe(
      false,
    );

    const retrievedWithoutSelection = structuredClone(matched.result.payload);
    retrievedWithoutSelection.selections = [];
    for (const record of retrievedWithoutSelection.records) {
      delete record.finalSelectionId;
    }
    expect(
      evidenceArtifactPayloadSchema.safeParse(retrievedWithoutSelection)
        .success,
    ).toBe(false);

    const noMatchWithSelection = structuredClone(noMatches.result.payload);
    noMatchWithSelection.records[0]!.finalSelectionId = buildStableId(
      "evidence-selection",
      { invalid: "empty-bm25" },
    );
    expect(
      evidenceArtifactPayloadSchema.safeParse(noMatchWithSelection).success,
    ).toBe(false);

    const typedRetrievalFailure = structuredClone(matched.result.payload);
    typedRetrievalFailure.bm25Runs = [];
    typedRetrievalFailure.selections = [];
    for (const record of typedRetrievalFailure.records) {
      record.retrievalStatus = "retrieval_failed";
      delete record.bm25RunId;
      delete record.finalSelectionId;
      record.failure = {
        code: "bm25_failed",
        reason: "Fixture deterministic retrieval failure.",
      };
    }
    expect(
      evidenceArtifactPayloadSchema.safeParse(typedRetrievalFailure).success,
    ).toBe(true);
  });

  it("makes no adapter calls and emits no model provenance when reranking is disabled", async () => {
    const { result, calls } = await runEvidenceFixture({
      rerankEnabled: false,
    });
    expect(calls).toEqual([]);
    expect(
      result.payload.records.every(
        (record) => record.rerankStatus === "disabled",
      ),
    ).toBe(true);
    expect(result.payload.rerankRuns).toEqual([]);
    expect(result.provenanceInputs).toEqual({
      prompts: [],
      models: [],
      responseArtifacts: [],
    });
    const artifact = buildCanonicalEvidenceArtifact({
      result,
      runId: result.payload.lineage.runId,
      createdAt: "2026-07-17T08:35:00.000Z",
    });
    expect(artifact.execution).toMatchObject({
      kind: "deterministic",
      replayableFromInputs: true,
    });
  });

  it("adds an immutable reranked version without mutating BM25", async () => {
    const disabled = await runEvidenceFixture();
    const enabled = await runEvidenceFixture({ rerankEnabled: true });
    const bm25Before = canonicalSerialize(disabled.result.payload.bm25Runs);

    expect(enabled.calls).toHaveLength(1);
    expect(canonicalSerialize(enabled.result.payload.bm25Runs)).toBe(
      bm25Before,
    );
    expect(enabled.result.payload.rerankRuns).toHaveLength(1);
    expect(enabled.result.payload.rerankRuns[0]).toMatchObject({
      bm25RunId: enabled.result.payload.bm25Runs[0]!.bm25RunId,
      status: "completed",
      candidateChunkIds: enabled.result.payload.bm25Runs[0]!.candidates.map(
        (candidate) => candidate.chunkId,
      ),
    });
    expect(enabled.calls[0]).toMatchObject({
      purpose: "relevance_only",
      query: {
        source: "scope-family-tracked-claim",
        text: enabled.prepare.payload.scopedFamilies[0]!.trackedClaim,
      },
    });
    expect(enabled.calls[0]).not.toHaveProperty("citingContext");
    expect(enabled.calls[0]).not.toHaveProperty("classification");
    expect(enabled.calls[0]!.query).not.toHaveProperty("groundingStatus");
    expect(enabled.calls[0]!.query).not.toHaveProperty("evidenceSpans");
  });

  it.each(["unknown_id", "duplicate_id", "empty", "malformed"] as const)(
    "types %s reranker output as an auditable nonfatal failure",
    async (rerankVariant) => {
      const { result } = await runEvidenceFixture({
        rerankEnabled: true,
        rerankVariant,
      });
      expect(result.payload.rerankRuns[0]).toMatchObject({
        status: "failed",
        failure: { code: "invalid_response" },
        results: [],
      });
      expect(
        result.payload.records.every(
          (record) => record.rerankStatus === "failed",
        ),
      ).toBe(true);
      const selection = result.payload.selections[0]!;
      expect(selection.rankingSource).toBe("bm25");
      expect(selection.rerankRunId).toBeUndefined();
      expect(selection.selectedChunkIds.length).toBeGreaterThan(0);
      if (rerankVariant === "empty") {
        expect(
          evidenceRerankOutputSchema.safeParse({ results: [] }).success,
        ).toBe(false);
      }
    },
  );

  it("preserves BM25 on nonfatal rerank failure and fails on fatal provider errors", async () => {
    const nonfatal = await runEvidenceFixture({
      rerankEnabled: true,
      rerankVariant: "nonfatal_failure",
    });
    expect(nonfatal.result.payload.rerankRuns[0]).toMatchObject({
      status: "failed",
      failure: {
        code: "timeout",
        reason: "Fixture reranker timed out.",
      },
    });
    expect(nonfatal.result.payload.selections[0]!.rankingSource).toBe("bm25");
    expect(
      nonfatal.result.payload.bm25Runs[0]!.candidates.length,
    ).toBeGreaterThan(0);

    const ancestors = await buildPrepareAncestors();
    const calls: CanonicalEvidenceRerankerInput[] = [];
    await expect(
      runCanonicalEvidence(
        ancestors.prepare,
        ancestors.scope,
        {
          rerank: rerankerAdapter("fatal_failure", calls, "fixture-reranker-a"),
        },
        {
          recordedAt: "2026-07-17T08:30:00.000Z",
          reranking: { enabled: true, topN: 3 },
        },
      ),
    ).rejects.toBeInstanceOf(CanonicalEvidenceFatalError);
    expect(calls).toHaveLength(1);
  });

  it("keeps chunk and BM25 identity stable across reranker model changes", async () => {
    const first = await runEvidenceFixture({
      rerankEnabled: true,
      model: "fixture-reranker-a",
    });
    const second = await runEvidenceFixture({
      rerankEnabled: true,
      model: "fixture-reranker-b",
    });
    expect(second.result.payload.corpora).toEqual(first.result.payload.corpora);
    expect(second.result.payload.bm25Runs).toEqual(
      first.result.payload.bm25Runs,
    );
    expect(second.result.payload.rerankRuns[0]!.rerankRunId).not.toBe(
      first.result.payload.rerankRuns[0]!.rerankRunId,
    );
    const firstArtifact = buildCanonicalEvidenceArtifact({
      result: first.result,
      runId: first.prepare.runId,
      createdAt: "2026-07-17T08:35:00.000Z",
    });
    const secondArtifact = buildCanonicalEvidenceArtifact({
      result: second.result,
      runId: second.prepare.runId,
      createdAt: "2026-07-17T08:35:00.000Z",
    });
    expect(secondArtifact.contentHash).not.toBe(firstArtifact.contentHash);
    expect(secondArtifact.artifactId).not.toBe(firstArtifact.artifactId);
  });

  it("binds rerank identity to response content, not artifact location metadata", async () => {
    const { result } = await runEvidenceFixture({ rerankEnabled: true });
    const run = result.payload.rerankRuns[0]!;
    const identityInput = {
      bm25RunId: run.bm25RunId,
      candidateChunkIds: run.candidateChunkIds,
      topN: run.topN,
      execution: run.execution,
      outcomeContentHash: run.rankingContentHash,
    };
    const originalId = buildEvidenceRerankRunId(identityInput);
    expect(originalId).toBe(run.rerankRunId);

    expect(
      buildEvidenceRerankRunId({
        ...identityInput,
        execution: {
          ...run.execution,
          responseArtifact: {
            ...run.execution.responseArtifact,
            uri: "fixture://relocated/model-response.json",
          },
        },
      }),
    ).toBe(originalId);
    expect(
      buildEvidenceRerankRunId({
        ...identityInput,
        execution: {
          ...run.execution,
          responseArtifact: {
            ...run.execution.responseArtifact,
            role: "relocated-model-response",
          },
        },
      }),
    ).toBe(originalId);
    expect(
      buildEvidenceRerankRunId({
        ...identityInput,
        execution: {
          ...run.execution,
          responseArtifact: {
            ...run.execution.responseArtifact,
            contentHash: canonicalSha256("different response content"),
          },
        },
      }),
    ).not.toBe(originalId);
    expect(
      buildEvidenceRerankRunId({
        ...identityInput,
        execution: {
          ...run.execution,
          model: "different-reranker-model",
        },
      }),
    ).not.toBe(originalId);
    expect(
      buildEvidenceRerankRunId({
        ...identityInput,
        outcomeContentHash: canonicalSha256("different ranking outcome"),
      }),
    ).not.toBe(originalId);
  });

  it("selects exact chunks and declares the ranking version used", async () => {
    const bm25 = await runEvidenceFixture();
    const reranked = await runEvidenceFixture({ rerankEnabled: true });
    const assertSelection = (
      fixture: Awaited<ReturnType<typeof runEvidenceFixture>>,
      source: "bm25" | "reranked",
    ) => {
      const selection = fixture.result.payload.selections[0]!;
      const chunks = fixture.result.payload.corpora[0]!.chunks;
      expect(selection.rankingSource).toBe(source);
      expect(selection.selectedChunkIds.length).toBeGreaterThan(0);
      for (const chunkId of selection.selectedChunkIds) {
        expect(chunks.some((chunk) => chunk.chunkId === chunkId)).toBe(true);
      }
      for (const outcome of fixture.result.payload.records) {
        expect(outcome.finalSelectionId).toBe(selection.selectionId);
      }
    };
    assertSelection(bm25, "bm25");
    assertSelection(reranked, "reranked");
  });

  it("rejects missing, duplicate, dangling, mutated, and inconsistent payload data", async () => {
    const { result } = await runEvidenceFixture({ rerankEnabled: true });
    const isInvalid = (payload: typeof result.payload) =>
      !evidenceArtifactPayloadSchema.safeParse(payload).success;

    const missing = structuredClone(result.payload);
    missing.records.pop();
    expect(isInvalid(missing)).toBe(true);

    const duplicate = structuredClone(result.payload);
    duplicate.records.push(structuredClone(duplicate.records[0]!));
    expect(isInvalid(duplicate)).toBe(true);

    const danglingChunk = structuredClone(result.payload);
    danglingChunk.selections[0]!.selectedChunkIds[0] = buildStableId(
      "evidence-chunk",
      { missing: true },
    );
    expect(isInvalid(danglingChunk)).toBe(true);

    const danglingRun = structuredClone(result.payload);
    danglingRun.records[0]!.bm25RunId = buildStableId("bm25-run", {
      missing: true,
    });
    expect(isInvalid(danglingRun)).toBe(true);

    const mutatedScore = structuredClone(result.payload);
    mutatedScore.bm25Runs[0]!.candidates[0]!.rawScore += 1;
    expect(isInvalid(mutatedScore)).toBe(true);

    const mutatedRank = structuredClone(result.payload);
    mutatedRank.bm25Runs[0]!.candidates[0]!.rank = 2;
    expect(isInvalid(mutatedRank)).toBe(true);

    const mutatedRerankScore = structuredClone(result.payload);
    if (mutatedRerankScore.rerankRuns[0]!.status === "completed") {
      mutatedRerankScore.rerankRuns[0]!.results[0]!.relevanceScore -= 1;
    }
    expect(isInvalid(mutatedRerankScore)).toBe(true);

    const mutatedRerankRank = structuredClone(result.payload);
    if (mutatedRerankRank.rerankRuns[0]!.status === "completed") {
      mutatedRerankRank.rerankRuns[0]!.results[0]!.rank = 2;
    }
    expect(isInvalid(mutatedRerankRank)).toBe(true);

    const mutatedChunk = structuredClone(result.payload);
    mutatedChunk.corpora[0]!.chunks[0]!.text += " truncated";
    expect(isInvalid(mutatedChunk)).toBe(true);

    const inconsistentIdentity = structuredClone(result.payload);
    inconsistentIdentity.records[0]!.familyId = buildStableId("family", {
      different: true,
    });
    expect(isInvalid(inconsistentIdentity)).toBe(true);
  });

  it("verifies exact Prepare and Scope lineage before reranker execution", async () => {
    const first = await buildPrepareAncestors();
    const second = await buildPrepareAncestors({
      runId: "run-other-evidence-fixture",
    });
    const calls: CanonicalEvidenceRerankerInput[] = [];
    await expect(
      runCanonicalEvidence(
        first.prepare,
        second.scope,
        {
          rerank: rerankerAdapter("success", calls, "fixture-reranker-a"),
        },
        {
          recordedAt: "2026-07-17T08:30:00.000Z",
          reranking: { enabled: true, topN: 3 },
        },
      ),
    ).rejects.toBeInstanceOf(CanonicalEvidenceBoundaryError);
    expect(calls).toEqual([]);

    const tampered = structuredClone(first.prepare);
    tampered.payload.records[0]!.context.verbatim.text = "Tampered context";
    await expect(
      runCanonicalEvidence(
        tampered,
        first.scope,
        {
          rerank: rerankerAdapter("success", calls, "fixture-reranker-a"),
        },
        {
          recordedAt: "2026-07-17T08:30:00.000Z",
          reranking: { enabled: true, topN: 3 },
        },
      ),
    ).rejects.toBeInstanceOf(CanonicalEvidenceBoundaryError);
    expect(calls).toEqual([]);
  });

  it("round-trips only current Evidence and detects lineage/content tampering", async () => {
    const { prepare, result } = await runEvidenceFixture({
      rerankEnabled: true,
    });
    const artifact = buildCanonicalEvidenceArtifact({
      result,
      runId: prepare.runId,
      createdAt: "2026-07-17T08:35:00.000Z",
      configuration: {
        contentHash: canonicalSha256({ stage: "evidence", version: 1 }),
      },
      code: {
        revision: "de004d2",
        dirty: false,
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-evidence-"));
    const artifactPath = join(directory, "evidence.json");
    try {
      writeCanonicalEvidenceArtifact(artifactPath, artifact);
      expect(loadCanonicalEvidenceArtifact(artifactPath)).toEqual(artifact);

      const tampered = structuredClone(artifact);
      tampered.payload.bm25Runs[0]!.candidates[0]!.rawScore += 2;
      writeFileSync(artifactPath, JSON.stringify(tampered), "utf8");
      expect(() => loadCanonicalEvidenceArtifact(artifactPath)).toThrow(
        /rankingContentHash|contentHash|artifactId/,
      );

      const wrongLineage = structuredClone(artifact);
      wrongLineage.payload.lineage.runId = "different-run";
      expect(
        evidenceArtifactPayloadSchema.safeParse(wrongLineage.payload).success,
      ).toBe(true);
      writeFileSync(artifactPath, JSON.stringify(wrongLineage), "utf8");
      expect(() => loadCanonicalEvidenceArtifact(artifactPath)).toThrow(
        /lineage|contentHash|artifactId/,
      );

      expect(() =>
        writeCanonicalEvidenceArtifact(artifactPath, {
          ...artifact,
          artifactVersion: 2,
        } as unknown as EvidenceArtifact),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("proves Discover → Scope → Prepare → Evidence complete accounting with both rankings", async () => {
    const { discover, scope, prepare, result } = await runEvidenceFixture({
      rerankEnabled: true,
    });
    expect(result.payload.lineage).toMatchObject({
      runId: discover.runId,
      prepareArtifact: {
        artifactId: prepare.artifactId,
        contentHash: prepare.contentHash,
        canonicalStage: "prepare",
      },
      scopeArtifact: {
        artifactId: scope.artifactId,
        contentHash: scope.contentHash,
        canonicalStage: "scope",
      },
    });
    expect(result.payload.records).toHaveLength(prepare.payload.records.length);
    expect(result.payload.bm25Runs).toHaveLength(1);
    expect(result.payload.rerankRuns).toHaveLength(1);
    expect(result.payload.rerankRuns[0]!.bm25RunId).toBe(
      result.payload.bm25Runs[0]!.bm25RunId,
    );
    expect(
      result.payload.records.every(
        (record) =>
          record.rerankStatus === "completed" &&
          record.finalSelectionId === result.payload.selections[0]!.selectionId,
      ),
    ).toBe(true);
  });
});
