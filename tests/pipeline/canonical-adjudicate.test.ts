import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptivePortfolioPolicySchema } from "../../src/contract/candidate-selection-policy.js";

import { describe, expect, it } from "vitest";

import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";
import {
  buildCanonicalAdjudicatePacket,
  buildCanonicalAdjudicatePrompt,
} from "../../src/adjudication/canonical-adjudicate-packet.js";
import {
  adjudicateRecordOutcomeSchema,
  buildAdjudicationResultId,
  buildDecisionId,
  computeLeanArtifactContentHash,
  computeLeanArtifactId,
  evidenceArtifactSchema,
  hashCanonicalAdjudicateRequest,
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
  runCanonicalEvidence,
} from "../../src/pipeline/canonical-evidence.js";
import {
  buildCanonicalAdjudicateArtifact,
  CanonicalAdjudicateBoundaryError,
  CanonicalAdjudicateFatalError,
  runCanonicalAdjudicate,
  type CanonicalAdjudicateAdapterInput,
} from "../../src/pipeline/canonical-adjudicate.js";
import {
  loadCanonicalArtifact,
  writeCanonicalArtifact,
} from "../../src/contract/selectors.js";

type GroundingVariant =
  | "grounded"
  | "not_found"
  | "grounding_failed"
  | "seed_text_unavailable"
  | "acquisition_failed";

type ClassifierVariant =
  | "default"
  | "classification_failed"
  | "skip_low_information"
  | "ambiguous"
  | "manual_review_role_ambiguous"
  | "manual_review_extraction_limited";

type AdjudicateVariant =
  | "F"
  | "D"
  | "E"
  | "U"
  | "unknown_chunk"
  | "duplicate_chunk"
  | "all_references"
  | "reordered_references"
  | "malformed"
  | "nonfatal_failure"
  | "fatal_failure"
  | "wrong_prompt_id"
  | "wrong_prompt_version"
  | "wrong_prompt_hash"
  | "wrong_request_hash"
  | "failed_wrong_request_hash"
  | "high_confidence_still_one_call";

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
  purpose: "discover" | "scope" | "adjudicate",
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
        doi: "10.1000/adjudicate-seed",
        provenanceArtifacts: [
          artifactReference("doi-input", "10.1000/adjudicate-seed"),
        ],
      },
    ],
    neighborhood: {
      provider: "fixture-citation-index",
      query: "works-citing-adjudicate-seed",
      limit: 10,
    },
    probeBudget: 10,
    candidateSelection: adaptivePortfolioPolicySchema.parse({
      mode: "adaptive_portfolio",
      minFamilies: 1,
      maxFamilies: 5,
      maxPreparedRecords: 1000,
      minMarginalNovelty: 0,
    }),
    recordedAt: "2026-07-17T09:00:00.000Z",
    ...(claim === TRACKED_CLAIM ? {} : {}),
  };
}

function discoverAdapters(
  claim: string,
  multipleClaims = false,
  contextText?: string,
): CanonicalDiscoverAdapters {
  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: "seed-paper",
          providerRecordId: "provider-seed-paper",
          title: "Seed adjudicate paper",
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
            rawContext:
              contextText ??
              "The reported phenotype followed Rab35 depletion [3].",
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
              contextText ??
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
    extractAttributedClaims: ({ mention }) => {
      const mentionClaim =
        mention.mentionIndex === 0 ? claim : `  ${claim.toUpperCase()}  `;
      return Promise.resolve({
        status: "completed",
        reason: "Fixture attributed claim extracted.",
        claims: [
          {
            text: mentionClaim,
            supportSpanText:
              mention.mentionIndex === 0
                ? "reported phenotype"
                : "Bulkhead defects",
            confidence: mention.mentionIndex === 0 ? "high" : "medium",
          },
          ...(multipleClaims
            ? [
                {
                  text: ` ${mentionClaim} `,
                  supportSpanText:
                    mention.mentionIndex === 0
                      ? "Rab35 depletion"
                      : "several references",
                  confidence: "medium" as const,
                },
              ]
            : []),
        ],
        execution: modelExecution(
          "discover",
          `occurrence-${String(mention.mentionIndex)}`,
        ),
      });
    },
  };
}

function materializedBlocks(blocks: typeof SOURCE_BLOCKS) {
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
  blocks: typeof SOURCE_BLOCKS = SOURCE_BLOCKS,
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
  classifier: ClassifierVariant = "default",
): CanonicalPrepareAdapters {
  return {
    classifyCitation: ({ citationOccurrence }) => {
      if (classifier === "classification_failed") {
        return Promise.resolve({
          status: "failed",
          reasonCode: "timeout",
          reason: "Fixture classification timed out.",
          execution: {
            kind: "external",
            ...externalExecution(
              "fixture-classifier",
              citationOccurrence.mentionId,
            ),
          },
        });
      }
      if (classifier === "skip_low_information") {
        return Promise.resolve({
          status: "classified",
          citationRole: "acknowledgment_or_low_information",
          evaluationMode: "skip_low_information",
          modifiers: {
            isBundled: citationOccurrence.isBundledCitation,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:low-info"],
          rationale: "Acknowledgment-only citation.",
          confidence: "high",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-v1",
          },
        });
      }
      if (
        classifier === "ambiguous" ||
        classifier === "manual_review_role_ambiguous"
      ) {
        return Promise.resolve({
          status: "ambiguous",
          citationRole: "unclear",
          evaluationMode: "manual_review_role_ambiguous",
          modifiers: {
            isBundled: citationOccurrence.isBundledCitation,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:ambiguous"],
          rationale: "The citation role is genuinely ambiguous.",
          confidence: "medium",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-v1",
          },
        });
      }
      if (classifier === "manual_review_extraction_limited") {
        return Promise.resolve({
          status: "ambiguous",
          citationRole: "unclear",
          evaluationMode: "manual_review_extraction_limited",
          modifiers: {
            isBundled: citationOccurrence.isBundledCitation,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:extraction-limited"],
          rationale: "Extraction confidence is too low for model adjudication.",
          confidence: "low",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-v1",
          },
        });
      }
      return Promise.resolve(
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
      );
    },
  };
}

async function buildEvidenceAncestors(
  options: {
    grounding?: GroundingVariant;
    claim?: string;
    blocks?: typeof SOURCE_BLOCKS;
    runId?: string;
    classifier?: ClassifierVariant;
    multipleClaims?: boolean;
    contextText?: string;
  } = {},
): Promise<{
  discover: DiscoverArtifact;
  scope: ScopeArtifact;
  prepare: PrepareArtifact;
  evidence: EvidenceArtifact;
}> {
  const claim = options.claim ?? TRACKED_CLAIM;
  const discoverResult = await runCanonicalDiscover(
    discoverOptions(claim),
    discoverAdapters(claim, options.multipleClaims, options.contextText),
  );
  const discover = buildCanonicalDiscoverArtifact({
    result: discoverResult,
    runId: options.runId ?? "run-canonical-adjudicate-fixture",
    createdAt: "2026-07-17T09:05:00.000Z",
  });
  const scopeResult = await runCanonicalScope(
    discover,
    scopeAdapters(options.grounding ?? "grounded", options.blocks),
    {
      recordedAt: "2026-07-17T09:10:00.000Z",
      discoverArtifactUri: "fixture://canonical-discover/discover.json",
    },
  );
  const scope = buildCanonicalScopeArtifact({
    result: scopeResult,
    runId: discover.runId,
    createdAt: "2026-07-17T09:15:00.000Z",
  });
  const prepareResult = await runCanonicalPrepare(
    scope,
    discover,
    prepareAdapters(options.classifier ?? "default"),
    {
      recordedAt: "2026-07-17T09:20:00.000Z",
      scopeArtifactUri: "fixture://canonical-scope/scope.json",
    },
  );
  const prepare = buildCanonicalPrepareArtifact({
    result: prepareResult,
    runId: discover.runId,
    createdAt: "2026-07-17T09:25:00.000Z",
  });
  const evidenceResult = await runCanonicalEvidence(
    prepare,
    scope,
    {},
    {
      recordedAt: "2026-07-17T09:30:00.000Z",
      prepareArtifactUri: "fixture://canonical-prepare/prepare.json",
      scopeArtifactUri: "fixture://canonical-scope/scope.json",
      reranking: { enabled: false },
    },
  );
  const evidence = buildCanonicalEvidenceArtifact({
    result: evidenceResult,
    runId: discover.runId,
    createdAt: "2026-07-17T09:35:00.000Z",
  });
  return { discover, scope, prepare, evidence };
}

function adjudicateAdapter(
  variant: AdjudicateVariant,
  calls: CanonicalAdjudicateAdapterInput[],
) {
  return (input: CanonicalAdjudicateAdapterInput) => {
    calls.push(input);
    const execution = {
      ...modelExecution("adjudicate", input.recordId),
      promptId: String(input.promptId),
      promptVersion: String(input.promptVersion),
      promptContentHash: canonicalSha256(input.promptText),
      requestHash: hashCanonicalAdjudicateRequest(input),
    };
    if (variant === "wrong_prompt_id") {
      execution.promptId = "wrong-prompt-id";
    } else if (variant === "wrong_prompt_version") {
      execution.promptVersion = "wrong-version";
    } else if (variant === "wrong_prompt_hash") {
      execution.promptContentHash = canonicalSha256("wrong prompt");
    } else if (
      variant === "wrong_request_hash" ||
      variant === "failed_wrong_request_hash"
    ) {
      execution.requestHash = canonicalSha256("wrong request");
    }
    if (
      variant === "nonfatal_failure" ||
      variant === "fatal_failure" ||
      variant === "failed_wrong_request_hash"
    ) {
      return Promise.resolve({
        status: "failed",
        reasonCode: variant === "fatal_failure" ? "quota" : "timeout",
        reason:
          variant === "fatal_failure"
            ? "Fixture adjudicator quota exhausted."
            : "Fixture adjudicator timed out.",
        execution,
      });
    }
    if (variant === "malformed") {
      return Promise.resolve({
        status: "completed",
        rawOutput: { verdict: "supported" },
        execution,
      });
    }
    const chunkIds = input.packet.selectedChunks.map((chunk) => chunk.chunkId);
    const chunkId = chunkIds[0]!;
    const verdict =
      variant === "high_confidence_still_one_call"
        ? "F"
        : variant === "unknown_chunk" ||
            variant === "duplicate_chunk" ||
            variant === "all_references" ||
            variant === "reordered_references" ||
            variant === "wrong_prompt_id" ||
            variant === "wrong_prompt_version" ||
            variant === "wrong_prompt_hash" ||
            variant === "wrong_request_hash"
          ? "F"
          : variant;
    const citedChunkIds =
      variant === "unknown_chunk"
        ? [buildStableId("evidence-chunk", { missing: true })]
        : variant === "duplicate_chunk"
          ? [chunkId, chunkId]
          : variant === "all_references"
            ? chunkIds
            : variant === "reordered_references"
              ? [...chunkIds].reverse()
              : [chunkId];
    return Promise.resolve({
      status: "completed",
      rawOutput: {
        citingAssertion:
          "The citing paper attributes Rab35 silencing to bulkhead loss.",
        sourceStatement:
          "The cited chunks report the same phenotype in hepatocytes.",
        verdict,
        mutationKinds: verdict === "D" ? ["certainty_strengthened"] : [],
        direction: verdict === "F" ? "none" : "strengthened",
        rationale:
          "The attribution matches the selected cited evidence with only reasonable compression.",
        confidence:
          variant === "high_confidence_still_one_call" ? "high" : "medium",
        citedChunkIds,
      },
      execution,
    });
  };
}

async function runAdjudicateFixture(
  options: {
    grounding?: GroundingVariant;
    classifier?: ClassifierVariant;
    variant?: AdjudicateVariant;
    claim?: string;
    blocks?: typeof SOURCE_BLOCKS;
    multipleClaims?: boolean;
    contextText?: string;
  } = {},
) {
  const ancestors = await buildEvidenceAncestors(options);
  const calls: CanonicalAdjudicateAdapterInput[] = [];
  const result = await runCanonicalAdjudicate(
    ancestors.evidence,
    ancestors.prepare,
    {
      adjudicate: adjudicateAdapter(options.variant ?? "F", calls),
    },
    {
      recordedAt: "2026-07-17T09:40:00.000Z",
      evidenceArtifactUri: "fixture://canonical-evidence/evidence.json",
      prepareArtifactUri: "fixture://canonical-prepare/prepare.json",
    },
  );
  return { ...ancestors, result, calls };
}

function rehashArtifact<T extends { contentHash: string; artifactId: string }>(
  artifact: T,
): T {
  artifact.contentHash = computeLeanArtifactContentHash(artifact as never);
  artifact.artifactId = computeLeanArtifactId(artifact as never);
  return artifact;
}

function buildRetrievalFailedEvidence(
  evidence: EvidenceArtifact,
): EvidenceArtifact {
  const failed = structuredClone(evidence);
  failed.payload.bm25Runs = [];
  failed.payload.selections = [];
  for (const record of failed.payload.records) {
    record.retrievalStatus = "retrieval_failed";
    delete record.bm25RunId;
    delete record.componentBm25RunIds;
    delete record.finalSelectionId;
    record.failure = {
      code: "bm25_failed",
      reason: "Fixture deterministic BM25 retrieval failure.",
    };
  }
  for (const decision of failed.decisions) {
    if (decision.decisionType === "evidence_retrieval_outcome") {
      decision.outcome = "retrieval_failed";
      decision.reason = "Fixture deterministic BM25 retrieval failure.";
      decision.decisionId = buildDecisionId(decision);
    } else if (decision.decisionType === "evidence_final_selection") {
      decision.outcome = "not_available";
      decision.reason =
        "No final selection exists because deterministic retrieval failed.";
      decision.decisionId = buildDecisionId(decision);
    }
  }
  return evidenceArtifactSchema.parse(rehashArtifact(failed));
}

describe("canonical Adjudicate", () => {
  it("emits exactly one outcome per Evidence record with no sampling", async () => {
    const { evidence, result } = await runAdjudicateFixture();
    expect(result.payload.records).toHaveLength(
      evidence.payload.records.length,
    );
    expect(
      result.payload.records.map((record) => record.recordId).sort(),
    ).toEqual(evidence.payload.records.map((record) => record.recordId).sort());
    expect(result.exclusions).toEqual([]);
    expect(result.decisions).toHaveLength(evidence.payload.records.length * 3);
  });

  it("allows fully gated runs without a model adapter", async () => {
    const ancestors = await buildEvidenceAncestors({
      grounding: "seed_text_unavailable",
    });
    const result = await runCanonicalAdjudicate(
      ancestors.evidence,
      ancestors.prepare,
      {},
      { recordedAt: "2026-07-17T09:40:00.000Z" },
    );
    expect(
      result.payload.records.every(
        (record) => record.status === "not_adjudicated",
      ),
    ).toBe(true);
    expect(result.provenanceInputs).toEqual({
      prompts: [],
      models: [],
      responseArtifacts: [],
    });
    const artifact = buildCanonicalAdjudicateArtifact({
      result,
      runId: ancestors.evidence.runId,
      createdAt: "2026-07-17T09:41:00.000Z",
    });
    expect(artifact.execution).toMatchObject({
      kind: "deterministic",
      replayableFromInputs: true,
    });
    expect(artifact.provenance.prompts).toEqual([]);
    expect(artifact.provenance.models).toEqual([]);
  });

  it("requires a model adapter only when an eligible record is reached", async () => {
    const ancestors = await buildEvidenceAncestors();
    await expect(
      runCanonicalAdjudicate(
        ancestors.evidence,
        ancestors.prepare,
        {},
        { recordedAt: "2026-07-17T09:40:00.000Z" },
      ),
    ).rejects.toThrow(/requires an adapter for eligible record/i);
  });

  it("gates every operational failure without F/D/E/U verdicts", async () => {
    const cases: Array<{
      grounding?: GroundingVariant;
      classifier?: ClassifierVariant;
      gateCode: string;
    }> = [
      { grounding: "seed_text_unavailable", gateCode: "seed_text_unavailable" },
      { grounding: "acquisition_failed", gateCode: "seed_acquisition_failed" },
      {
        classifier: "classification_failed",
        gateCode: "classification_failed",
      },
      { classifier: "skip_low_information", gateCode: "skip_low_information" },
      { classifier: "ambiguous", gateCode: "manual_review_role_ambiguous" },
      {
        classifier: "manual_review_role_ambiguous",
        gateCode: "manual_review_role_ambiguous",
      },
      {
        classifier: "manual_review_extraction_limited",
        gateCode: "manual_review_extraction_limited",
      },
    ];
    for (const testCase of cases) {
      const { result, calls } = await runAdjudicateFixture(testCase);
      expect(calls).toHaveLength(0);
      for (const record of result.payload.records) {
        expect(record.status).toBe("not_adjudicated");
        if (record.status === "not_adjudicated") {
          expect(record.gateCode).toBe(testCase.gateCode);
        }
        expect(record).not.toHaveProperty("verdict");
      }
    }
  });

  it("keeps role-ambiguous records in the manual-review queue with zero model calls", async () => {
    const { result, calls } = await runAdjudicateFixture({
      classifier: "manual_review_role_ambiguous",
    });
    expect(calls).toHaveLength(0);
    expect(
      result.payload.records.every(
        (record) =>
          record.status === "not_adjudicated" &&
          record.gateCode === "manual_review_role_ambiguous",
      ),
    ).toBe(true);
    expect(
      result.payload.records.every((record) => !("verdict" in record)),
    ).toBe(true);
  });

  it("gates a valid typed retrieval failure with zero model calls", async () => {
    const ancestors = await buildEvidenceAncestors();
    const evidence = buildRetrievalFailedEvidence(ancestors.evidence);
    const calls: CanonicalAdjudicateAdapterInput[] = [];
    const result = await runCanonicalAdjudicate(
      evidence,
      ancestors.prepare,
      { adjudicate: adjudicateAdapter("F", calls) },
      { recordedAt: "2026-07-17T09:40:00.000Z" },
    );
    expect(calls).toEqual([]);
    for (const record of result.payload.records) {
      expect(record.status).toBe("not_adjudicated");
      if (record.status === "not_adjudicated") {
        expect(record.gateCode).toBe("retrieval_failed");
      }
      expect(record).not.toHaveProperty("verdict");
    }
  });

  it("gates whitespace-only exact citing context with zero model calls", async () => {
    const { result, calls } = await runAdjudicateFixture({
      contextText: "   \n\t ",
    });
    expect(calls).toEqual([]);
    for (const record of result.payload.records) {
      expect(record.status).toBe("not_adjudicated");
      if (record.status === "not_adjudicated") {
        expect(record.gateCode).toBe("invalid_context");
      }
      expect(record).not.toHaveProperty("verdict");
    }
  });

  it("never turns no_lexical_matches into E or U", async () => {
    const { result, calls } = await runAdjudicateFixture({
      grounding: "not_found",
      claim: "Completely unrelated lexical query about quantum chromodynamics",
      blocks: [
        {
          blockId: "scope-block-unrelated",
          text: "This manuscript discusses plant photosynthesis rates under drought.",
          sectionTitle: "Results",
          blockKind: "body_paragraph",
        },
      ],
    });
    expect(calls).toHaveLength(0);
    for (const record of result.payload.records) {
      expect(record.status).toBe("not_adjudicated");
      if (record.status === "not_adjudicated") {
        expect(record.gateCode).toBe("no_lexical_matches");
      }
      expect(JSON.stringify(record)).not.toMatch(/"verdict":"E"|"verdict":"U"/);
    }
  });

  it("keeps Scope not_found eligible when exact selected evidence exists", async () => {
    const { prepare, evidence, result, calls } = await runAdjudicateFixture({
      grounding: "not_found",
      variant: "E",
    });
    expect(prepare.payload.records[0]!.family.grounding.status).toBe(
      "not_found",
    );
    expect(
      evidence.payload.records.every(
        (record) => record.retrievalStatus === "retrieved",
      ),
    ).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(
      result.payload.records.every((record) => record.status === "adjudicated"),
    ).toBe(true);
    for (const call of calls) {
      expect(call.promptText).not.toMatch(/not_found|not found|ungrounded/i);
      expect(call.promptText).not.toMatch(/grounding status/i);
    }
  });

  it("keeps Scope grounding_failed eligible with independently selected evidence", async () => {
    const { prepare, evidence, result, calls } = await runAdjudicateFixture({
      grounding: "grounding_failed",
      variant: "F",
    });
    expect(
      prepare.payload.records.every(
        (record) => record.family.grounding.status === "grounding_failed",
      ),
    ).toBe(true);
    expect(
      evidence.payload.records.every(
        (record) =>
          record.retrievalStatus === "retrieved" &&
          record.finalSelectionId != null,
      ),
    ).toBe(true);
    expect(calls).toHaveLength(evidence.payload.records.length);
    expect(
      result.payload.records.every((record) => record.status === "adjudicated"),
    ).toBe(true);
    for (const call of calls) {
      expect(call.packet).not.toHaveProperty("grounding");
      expect(call.promptText).not.toMatch(
        /grounding_failed|grounding failed|grounding status/i,
      );
    }
  });

  it("validates F, D, E, and U under exact definitions with evidence required for U", async () => {
    for (const verdict of ["F", "D", "E", "U"] as const) {
      const { result } = await runAdjudicateFixture({ variant: verdict });
      for (const record of result.payload.records) {
        expect(record.status).toBe("adjudicated");
        if (record.status === "adjudicated") {
          expect(record.verdict).toBe(verdict);
          expect(record.selectedCitedChunkIds.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps nonfatal model failure and malformed output as typed non-verdicts", async () => {
    const failed = await runAdjudicateFixture({ variant: "nonfatal_failure" });
    for (const record of failed.result.payload.records) {
      expect(record.status).toBe("adjudication_failed");
      expect(record).not.toHaveProperty("verdict");
    }

    const invalid = await runAdjudicateFixture({ variant: "malformed" });
    for (const record of invalid.result.payload.records) {
      expect(record.status).toBe("invalid_output");
      expect(record).not.toHaveProperty("verdict");
    }
  });

  it("stops the stage on fatal provider failure", async () => {
    await expect(
      runAdjudicateFixture({ variant: "fatal_failure" }),
    ).rejects.toBeInstanceOf(CanonicalAdjudicateFatalError);
  });

  it("rejects adapter execution that is not bound to the exact prompt and request", async () => {
    for (const variant of [
      "wrong_prompt_id",
      "wrong_prompt_version",
      "wrong_prompt_hash",
      "wrong_request_hash",
      "failed_wrong_request_hash",
    ] as const) {
      await expect(runAdjudicateFixture({ variant })).rejects.toBeInstanceOf(
        CanonicalAdjudicateBoundaryError,
      );
    }
  });

  it("makes exactly one model call per eligible record regardless of confidence", async () => {
    const { evidence, calls, result } = await runAdjudicateFixture({
      variant: "high_confidence_still_one_call",
    });
    expect(calls).toHaveLength(evidence.payload.records.length);
    expect(
      result.payload.records.every(
        (record) =>
          record.status === "adjudicated" &&
          record.confidence === "high" &&
          record.verdict === "F",
      ),
    ).toBe(true);
    expect(result.payload.method.routing).toBe("none");
    expect(result.payload.method.calibrationStatus).toBe("uncalibrated");
    expect(JSON.stringify(result)).not.toMatch(
      /advisor|vector_first|escalat|challenger/i,
    );
  });

  it("builds a neutral packet/prompt without leading or score leakage", async () => {
    const { prepare, evidence, calls } = await runAdjudicateFixture({
      variant: "F",
    });
    const prepareRecord = prepare.payload.records[0]!;
    const evidenceOutcome = evidence.payload.records.find(
      (record) => record.recordId === prepareRecord.recordId,
    )!;
    const selection = evidence.payload.selections.find(
      (entry) => entry.selectionId === evidenceOutcome.finalSelectionId,
    )!;
    const chunks = evidence.payload.corpora
      .flatMap((corpus) => corpus.chunks)
      .filter((chunk) => selection.selectedChunkIds.includes(chunk.chunkId));
    const packet = buildCanonicalAdjudicatePacket({
      prepareRecord,
      selection,
      selectedChunks: chunks,
    });
    const prompt = buildCanonicalAdjudicatePrompt(packet);
    expect(prompt).toContain(
      prepareRecord.occurrenceSourceClaimRecords[0]!.extractedClaimText,
    );
    // Chunks are numbered in the prompt; the model never echoes hashes.
    expect(prompt).toContain("#1 (");
    expect(prompt).not.toContain(selection.selectedChunkIds[0]!);
    expect(prompt).toMatch(/Bundled-reference warning|Seed reference label|▶/);
    expect(prompt).not.toMatch(/bm25Score|relevanceScore|rawScore/);
    expect(prompt).not.toMatch(/not_found|grounding status|cannot_determine/i);
    expect(prompt).not.toMatch(
      /\b(partially_supported|overstated_or_generalized)\b/,
    );
    expect(prompt).not.toMatch(
      /this may be distorted|expected answer|prior verdict/i,
    );
    expect(calls[0]!.promptText).toBe(prompt);
  });

  it("rejects unknown or duplicate chunk references as invalid_output", async () => {
    for (const variant of ["unknown_chunk", "duplicate_chunk"] as const) {
      const { result } = await runAdjudicateFixture({ variant });
      for (const record of result.payload.records) {
        expect(record.status).toBe("invalid_output");
      }
    }
  });

  it("binds the occurrence-local claim set from Prepare without a model echo", async () => {
    const { prepare, result } = await runAdjudicateFixture({
      variant: "F",
      multipleClaims: true,
    });
    for (const record of result.payload.records) {
      expect(record.status).toBe("adjudicated");
      if (record.status !== "adjudicated") continue;
      const prepareRecord = prepare.payload.records.find(
        (entry) => entry.recordId === record.recordId,
      )!;
      expect(record.evaluatedClaimRecordIds).toEqual(
        prepareRecord.occurrenceSourceClaimRecords.map(
          (claim) => claim.claimRecordId,
        ),
      );
    }
  });

  it("records mutation kinds and direction for D verdicts only", async () => {
    const distorted = await runAdjudicateFixture({ variant: "D" });
    for (const record of distorted.result.payload.records) {
      expect(record.status).toBe("adjudicated");
      if (record.status !== "adjudicated") continue;
      expect(record.mutationKinds).toEqual(["certainty_strengthened"]);
      expect(record.direction).toBe("strengthened");
    }
    const faithful = await runAdjudicateFixture({ variant: "F" });
    for (const record of faithful.result.payload.records) {
      if (record.status !== "adjudicated") continue;
      expect(record.mutationKinds).toEqual([]);
      expect(record.direction).toBe("none");
    }
  });

  it("canonicalizes equivalent claim and chunk reference ordering", async () => {
    const ordered = await runAdjudicateFixture({
      variant: "all_references",
      multipleClaims: true,
    });
    const reordered = await runAdjudicateFixture({
      variant: "reordered_references",
      multipleClaims: true,
    });
    expect(reordered.result.payload.records).toEqual(
      ordered.result.payload.records,
    );
    for (const record of ordered.result.payload.records) {
      expect(record.status).toBe("adjudicated");
      if (record.status !== "adjudicated") continue;
      const prepareRecord = ordered.prepare.payload.records.find(
        (entry) => entry.recordId === record.recordId,
      )!;
      const evidenceRecord = ordered.evidence.payload.records.find(
        (entry) => entry.recordId === record.recordId,
      )!;
      const selection = ordered.evidence.payload.selections.find(
        (entry) => entry.selectionId === evidenceRecord.finalSelectionId,
      )!;
      expect(record.evaluatedClaimRecordIds).toEqual(
        prepareRecord.occurrenceSourceClaimRecords.map(
          (claim) => claim.claimRecordId,
        ),
      );
      expect(record.modelCitedChunkIds).toEqual(selection.selectedChunkIds);
    }
  });

  it("binds citing claims and cited chunks to Prepare/Evidence provenance", async () => {
    const { prepare, evidence, result } = await runAdjudicateFixture({
      variant: "F",
    });
    for (const record of result.payload.records) {
      expect(record.status).toBe("adjudicated");
      if (record.status !== "adjudicated") continue;
      const prepareRecord = prepare.payload.records.find(
        (entry) => entry.recordId === record.recordId,
      )!;
      const allowedClaims = new Set(
        prepareRecord.occurrenceSourceClaimRecords.map(
          (claim) => claim.claimRecordId,
        ),
      );
      const evidenceOutcome = evidence.payload.records.find(
        (entry) => entry.recordId === record.recordId,
      )!;
      const selection = evidence.payload.selections.find(
        (entry) => entry.selectionId === evidenceOutcome.finalSelectionId,
      )!;
      expect(record.selectedCitedChunkIds).toEqual(selection.selectedChunkIds);
      for (const claimId of record.evaluatedClaimRecordIds) {
        expect(allowedClaims.has(claimId)).toBe(true);
      }
      expect(record.evaluatedCitingClaimText).toContain(
        prepareRecord.occurrenceSourceClaimRecords[0]!.extractedClaimText,
      );
    }
  });

  it("changes adjudication identity with model output but never Prepare record ID", async () => {
    const first = await runAdjudicateFixture({ variant: "F" });
    const second = await runAdjudicateFixture({ variant: "D" });
    expect(
      first.result.payload.records.map((record) => record.recordId),
    ).toEqual(second.result.payload.records.map((record) => record.recordId));
    expect(
      first.result.payload.records.map((record) =>
        record.status === "adjudicated" ? record.adjudicationResultId : null,
      ),
    ).not.toEqual(
      second.result.payload.records.map((record) =>
        record.status === "adjudicated" ? record.adjudicationResultId : null,
      ),
    );
    expect(
      first.prepare.payload.records.map((record) => record.recordId),
    ).toEqual(second.prepare.payload.records.map((record) => record.recordId));
  });

  it("stabilizes non-verdict identity around semantic status and execution", async () => {
    const gated = await runAdjudicateFixture({
      grounding: "seed_text_unavailable",
    });
    const gatedRecord = gated.result.payload.records[0]!;
    expect(gatedRecord.status).toBe("not_adjudicated");
    if (gatedRecord.status !== "not_adjudicated") return;
    const gatedReasonChanged = {
      ...gatedRecord,
      reason: "Different descriptive gate wording.",
    };
    expect(buildAdjudicationResultId(gatedReasonChanged)).toBe(
      gatedRecord.adjudicationResultId,
    );
    expect(
      adjudicateRecordOutcomeSchema.parse(gatedReasonChanged)
        .adjudicationResultId,
    ).toBe(gatedRecord.adjudicationResultId);
    expect(
      buildAdjudicationResultId({
        ...gatedRecord,
        gateCode: "seed_acquisition_failed",
      }),
    ).not.toBe(gatedRecord.adjudicationResultId);

    const failed = await runAdjudicateFixture({
      variant: "nonfatal_failure",
    });
    const failedRecord = failed.result.payload.records[0]!;
    expect(failedRecord.status).toBe("adjudication_failed");
    if (failedRecord.status !== "adjudication_failed") return;
    const descriptiveChanges = {
      ...failedRecord,
      reason: "Different provider wording.",
      execution: {
        ...failedRecord.execution,
        requestArtifact: {
          ...failedRecord.execution.requestArtifact,
          role: "different-request-role",
          uri: "fixture://different/request-location",
        },
        responseArtifact: {
          ...failedRecord.execution.responseArtifact,
          role: "different-response-role",
          uri: "fixture://different/response-location",
        },
      },
    };
    expect(buildAdjudicationResultId(descriptiveChanges)).toBe(
      failedRecord.adjudicationResultId,
    );
    expect(
      adjudicateRecordOutcomeSchema.parse(descriptiveChanges)
        .adjudicationResultId,
    ).toBe(failedRecord.adjudicationResultId);
    expect(
      buildAdjudicationResultId({
        ...failedRecord,
        failureCode: "transport",
      }),
    ).not.toBe(failedRecord.adjudicationResultId);
    // The stored request body carries cachePolicy and promptCachePolicy, so a
    // cached re-run rewrites its digest without changing what was asked.
    expect(
      buildAdjudicationResultId({
        ...failedRecord,
        execution: {
          ...failedRecord.execution,
          requestArtifact: {
            ...failedRecord.execution.requestArtifact,
            contentHash: canonicalSha256("same request, bypassed cache"),
          },
          responseArtifact: {
            ...failedRecord.execution.responseArtifact,
            contentHash: canonicalSha256("differently worded provider error"),
          },
        },
      }),
    ).toBe(failedRecord.adjudicationResultId);
    expect(
      buildAdjudicationResultId({
        ...failedRecord,
        execution: {
          ...failedRecord.execution,
          requestHash: canonicalSha256("a different packet"),
        },
      }),
    ).not.toBe(failedRecord.adjudicationResultId);
    expect(
      buildAdjudicationResultId({
        ...failedRecord,
        execution: {
          ...failedRecord.execution,
          promptContentHash: canonicalSha256("a different prompt"),
        },
      }),
    ).not.toBe(failedRecord.adjudicationResultId);
    // Telemetry describes how a call was served, never what it decided.
    expect(
      buildAdjudicationResultId({
        ...failedRecord,
        execution: {
          ...failedRecord.execution,
          servedModel: "claude-opus-4-6-20260101",
          exactCacheHit: true,
        },
      }),
    ).toBe(failedRecord.adjudicationResultId);

    const invalid = await runAdjudicateFixture({ variant: "malformed" });
    const invalidRecord = invalid.result.payload.records[0]!;
    expect(invalidRecord.status).toBe("invalid_output");
    if (invalidRecord.status !== "invalid_output") return;
    expect(
      buildAdjudicationResultId({
        ...invalidRecord,
        reason: "Different parser diagnostic wording.",
      }),
    ).toBe(invalidRecord.adjudicationResultId);

    const adjudicated = await runAdjudicateFixture({ variant: "F" });
    const adjudicatedRecord = adjudicated.result.payload.records[0]!;
    expect(adjudicatedRecord.status).toBe("adjudicated");
    if (adjudicatedRecord.status !== "adjudicated") return;
    expect(
      buildAdjudicationResultId({
        ...adjudicatedRecord,
        rationale: "A substantively different parsed rationale.",
      }),
    ).not.toBe(adjudicatedRecord.adjudicationResultId);
  });

  it("round-trips the current-version artifact and detects tampering", async () => {
    const { evidence, prepare, result } = await runAdjudicateFixture();
    const artifact = buildCanonicalAdjudicateArtifact({
      result,
      runId: evidence.runId,
      createdAt: "2026-07-17T09:45:00.000Z",
    });
    expect(artifact.payload.lineage.evidenceArtifact.artifactId).toBe(
      evidence.artifactId,
    );
    expect(artifact.payload.lineage.prepareArtifact.contentHash).toBe(
      prepare.contentHash,
    );

    const directory = mkdtempSync(join(tmpdir(), "canonical-adjudicate-"));
    const path = join(directory, "adjudicate.json");
    try {
      writeCanonicalArtifact("adjudicate", path, artifact);
      const loaded = loadCanonicalArtifact("adjudicate", path);
      expect(loaded).toEqual(artifact);

      const tampered = {
        ...artifact,
        payload: {
          ...artifact.payload,
          method: {
            ...artifact.payload.method,
            calibrationStatus: "uncalibrated",
          },
        },
        contentHash: "0".repeat(64),
      };
      writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
      expect(() => loadCanonicalArtifact("adjudicate", path)).toThrow(
        /contentHash|tamper|Invalid/i,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects removal or swapping of every modeled provenance link", async () => {
    const { evidence, result } = await runAdjudicateFixture();
    const artifact = buildCanonicalAdjudicateArtifact({
      result,
      runId: evidence.runId,
      createdAt: "2026-07-17T09:46:00.000Z",
    });
    const directory = mkdtempSync(join(tmpdir(), "adjudicate-provenance-"));
    const path = join(directory, "adjudicate.json");
    const changedReference = artifactReference(
      "tampered-provenance",
      "replacement",
    );
    const mutations: Array<{
      name: string;
      mutate: (value: typeof artifact) => void;
    }> = [
      {
        name: "remove prompt provenance",
        mutate: (value) => {
          value.provenance.prompts = [];
        },
      },
      {
        name: "swap prompt provenance",
        mutate: (value) => {
          value.provenance.prompts[0]!.contentHash =
            canonicalSha256("swapped prompt");
        },
      },
      {
        name: "remove model provenance",
        mutate: (value) => {
          value.provenance.models = [];
        },
      },
      {
        name: "swap model request provenance",
        mutate: (value) => {
          value.provenance.models[0]!.requestArtifact = changedReference;
        },
      },
      {
        name: "swap model request hash",
        mutate: (value) => {
          value.provenance.models[0]!.requestHash = canonicalSha256(
            "swapped request hash",
          );
        },
      },
      {
        name: "swap model response provenance",
        mutate: (value) => {
          value.provenance.models[0]!.responseArtifact = changedReference;
        },
      },
      {
        name: "remove stage response provenance",
        mutate: (value) => {
          if (value.execution.kind !== "model") {
            throw new Error("Expected model artifact");
          }
          value.execution.responseArtifacts = [];
        },
      },
      {
        name: "swap stage response provenance",
        mutate: (value) => {
          if (value.execution.kind !== "model") {
            throw new Error("Expected model artifact");
          }
          value.execution.responseArtifacts[0] = changedReference;
        },
      },
      {
        name: "remove modeled decision request provenance",
        mutate: (value) => {
          const decision = value.decisions.find(
            (entry) => entry.decisionType === "adjudicate_model_outcome",
          )!;
          const modeledRecord = value.payload.records.find(
            (record) => record.status === "adjudicated",
          )!;
          if (modeledRecord.status !== "adjudicated") {
            throw new Error("Expected modeled record");
          }
          decision.evidenceArtifacts = decision.evidenceArtifacts.filter(
            (reference) =>
              reference.artifactId !==
              modeledRecord.execution.requestArtifact.artifactId,
          );
          decision.decisionId = buildDecisionId(decision);
        },
      },
      {
        name: "swap modeled decision response provenance",
        mutate: (value) => {
          const decision = value.decisions.find(
            (entry) => entry.decisionType === "adjudicate_final_outcome",
          )!;
          const modeledRecord = value.payload.records.find(
            (record) => record.status === "adjudicated",
          )!;
          if (modeledRecord.status !== "adjudicated") {
            throw new Error("Expected modeled record");
          }
          decision.evidenceArtifacts = decision.evidenceArtifacts.map(
            (reference) =>
              reference.artifactId ===
              modeledRecord.execution.responseArtifact.artifactId
                ? changedReference
                : reference,
          );
          decision.decisionId = buildDecisionId(decision);
        },
      },
    ];
    try {
      for (const mutation of mutations) {
        const tampered = structuredClone(artifact);
        mutation.mutate(tampered);
        rehashArtifact(tampered);
        writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
        expect(
          () => loadCanonicalArtifact("adjudicate", path),
          mutation.name,
        ).toThrow(/Invalid canonical Adjudicate artifact/i);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("forbids model provenance on fully gated artifacts", async () => {
    const { evidence, result } = await runAdjudicateFixture({
      grounding: "seed_text_unavailable",
    });
    const artifact = buildCanonicalAdjudicateArtifact({
      result,
      runId: evidence.runId,
      createdAt: "2026-07-17T09:47:00.000Z",
    });
    expect(artifact.execution.kind).toBe("deterministic");
    expect(artifact.provenance.prompts).toEqual([]);
    expect(artifact.provenance.models).toEqual([]);

    const tampered = structuredClone(artifact);
    tampered.provenance.prompts.push({
      promptId: "orphan-prompt",
      version: "v1",
      contentHash: canonicalSha256("orphan prompt"),
    });
    rehashArtifact(tampered);
    const directory = mkdtempSync(join(tmpdir(), "adjudicate-gated-"));
    const path = join(directory, "adjudicate.json");
    try {
      writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
      expect(() => loadCanonicalArtifact("adjudicate", path)).toThrow(
        /Invalid canonical Adjudicate artifact/i,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects cross-run or mismatched Evidence/Prepare lineage before adapters run", async () => {
    const first = await buildEvidenceAncestors({ runId: "run-a" });
    const second = await buildEvidenceAncestors({ runId: "run-b" });
    const calls: CanonicalAdjudicateAdapterInput[] = [];
    await expect(
      runCanonicalAdjudicate(
        first.evidence,
        second.prepare,
        { adjudicate: adjudicateAdapter("F", calls) },
        { recordedAt: "2026-07-17T09:40:00.000Z" },
      ),
    ).rejects.toBeInstanceOf(CanonicalAdjudicateBoundaryError);
    expect(calls).toHaveLength(0);
  });

  it("proves Discover → Scope → Prepare → Evidence → Adjudicate complete accounting", async () => {
    const { discover, scope, prepare, evidence, result } =
      await runAdjudicateFixture({ grounding: "not_found", variant: "E" });
    expect(discover.canonicalStage).toBe("discover");
    expect(scope.canonicalStage).toBe("scope");
    expect(prepare.canonicalStage).toBe("prepare");
    expect(evidence.canonicalStage).toBe("evidence");
    expect(result.payload.records).toHaveLength(prepare.payload.records.length);
    expect(result.payload.records).toHaveLength(
      evidence.payload.records.length,
    );
    expect(
      canonicalSerialize(
        result.payload.records.map((record) => record.recordId).sort(),
      ),
    ).toBe(
      canonicalSerialize(
        prepare.payload.records.map((record) => record.recordId).sort(),
      ),
    );
    const artifact = buildCanonicalAdjudicateArtifact({
      result,
      runId: discover.runId,
      createdAt: "2026-07-17T09:50:00.000Z",
    });
    expect(artifact.execution.replayableFromInputs).toBe(false);
    expect(artifact.payload.method.calibrationStatus).toBe("uncalibrated");
  });
});
