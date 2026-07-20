import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  buildDecisionId,
  computeLeanArtifactContentHash,
  computeLeanArtifactId,
  createAppendOnlyExclusion,
  hashCanonicalAdjudicateRequest,
  reportArtifactPayloadSchema,
  reportArtifactSchema,
  reportRateSchema,
  reportRecordTraceSchema,
  type ArtifactReference,
  type EvidenceArtifact,
  type PrepareArtifact,
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
  type CanonicalEvidenceRerankerInput,
} from "../../src/pipeline/canonical-evidence.js";
import {
  buildCanonicalAdjudicateArtifact,
  runCanonicalAdjudicate,
  type CanonicalAdjudicateAdapterInput,
} from "../../src/pipeline/canonical-adjudicate.js";
import {
  buildCanonicalReportArtifact,
  CanonicalReportBoundaryError,
  runCanonicalReport,
} from "../../src/pipeline/canonical-report.js";
import {
  loadCanonicalReportArtifact,
  writeCanonicalReportArtifacts,
} from "../../src/pipeline/canonical-report-artifact.js";
import { renderCanonicalReportMarkdown } from "../../src/reporting/canonical-report-markdown.js";

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
  purpose: "discover" | "scope" | "rerank" | "adjudicate",
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

function discoverOptions(): CanonicalDiscoverOptions {
  return {
    seeds: [
      {
        doi: "10.1000/report-seed",
        provenanceArtifacts: [
          artifactReference("doi-input", "10.1000/report-seed"),
        ],
      },
    ],
    neighborhood: {
      provider: "fixture-citation-index",
      query: "works-citing-report-seed",
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
    recordedAt: "2026-07-17T10:00:00.000Z",
  };
}

function discoverAdapters(): CanonicalDiscoverAdapters {
  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: "seed-paper",
          providerRecordId: "provider-seed-paper",
          title: "Seed report paper",
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
              mention.mentionIndex === 0
                ? TRACKED_CLAIM
                : `  ${TRACKED_CLAIM.toUpperCase()}  `,
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

function materializedBlocks() {
  let offset = 0;
  return SOURCE_BLOCKS.map((block) => {
    const charOffsetStart = offset;
    const charOffsetEnd = charOffsetStart + block.text.length;
    offset = charOffsetEnd + 2;
    return { ...block, charOffsetStart, charOffsetEnd };
  });
}

function scopeAdapters(
  grounding: "grounded" | "seed_text_unavailable" = "grounded",
): CanonicalScopeAdapters {
  return {
    materializeSeed: ({ seed }) => {
      const execution = {
        kind: "external" as const,
        ...externalExecution("fixture-full-text", seed.seedId),
      };
      if (grounding === "seed_text_unavailable") {
        return Promise.resolve({
          seedId: seed.seedId,
          status: "seed_text_unavailable",
          reasonCode: "unavailable" as const,
          reason: "No inspectable seed manuscript was available.",
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
        blocks: materializedBlocks(),
        execution,
      });
    },
    groundFamily: ({ family }) =>
      Promise.resolve({
        status: "completed",
        rawOutput: {
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
        execution: {
          ...modelExecution("scope", family.familyId),
        },
      }),
  };
}

function prepareAdapters(
  mode: "mixed" | "default" = "mixed",
): CanonicalPrepareAdapters {
  return {
    classifyCitation: ({ citationOccurrence }) => {
      if (mode === "mixed" && citationOccurrence.mentionIndex === 1) {
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
          rationale: "Fixture low-information gate.",
          confidence: "high",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-low-info-v1",
          },
        });
      }
      if (citationOccurrence.isBundledCitation) {
        return Promise.resolve({
          status: "classified",
          citationRole: "background_context",
          evaluationMode: "fidelity_bundled_use",
          modifiers: {
            isBundled: true,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:bundled-background"],
          rationale: "Fixture bundled background attribution.",
          confidence: "medium",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-v1",
          },
        });
      }
      return Promise.resolve({
        status: "classified",
        citationRole: "substantive_attribution",
        evaluationMode: "fidelity_specific_claim",
        modifiers: {
          isBundled: false,
          isReviewMediated: false,
          bundleSize: 1,
        },
        signals: ["fixture:direct-attribution"],
        rationale: "Fixture substantive attribution.",
        confidence: "high",
        execution: {
          kind: "deterministic",
          implementation: "fixture-classifier-v1",
        },
      });
    },
  };
}

async function buildChain(
  options: {
    grounding?: "grounded" | "seed_text_unavailable";
    classifier?: "mixed" | "default";
    adjudicateVariant?: "F" | "D" | "U" | "nonfatal_failure" | "malformed";
    reranking?: boolean;
    runId?: string;
  } = {},
) {
  const runId = options.runId ?? "run-canonical-report-fixture";
  const discoverResult = await runCanonicalDiscover(
    discoverOptions(),
    discoverAdapters(),
  );
  const discover = buildCanonicalDiscoverArtifact({
    result: discoverResult,
    runId,
    createdAt: "2026-07-17T10:05:00.000Z",
  });
  const scopeResult = await runCanonicalScope(
    discover,
    scopeAdapters(options.grounding ?? "grounded"),
    {
      recordedAt: "2026-07-17T10:10:00.000Z",
      discoverArtifactUri: "fixture://canonical-discover/discover.json",
    },
  );
  const scope = buildCanonicalScopeArtifact({
    result: scopeResult,
    runId: discover.runId,
    createdAt: "2026-07-17T10:15:00.000Z",
  });
  const prepareResult = await runCanonicalPrepare(
    scope,
    discover,
    prepareAdapters(options.classifier ?? "mixed"),
    {
      recordedAt: "2026-07-17T10:20:00.000Z",
      scopeArtifactUri: "fixture://canonical-scope/scope.json",
    },
  );
  const prepare = buildCanonicalPrepareArtifact({
    result: prepareResult,
    runId: discover.runId,
    createdAt: "2026-07-17T10:25:00.000Z",
  });
  const evidenceResult = await runCanonicalEvidence(
    prepare,
    scope,
    options.reranking
      ? {
          rerank: (input: CanonicalEvidenceRerankerInput) =>
            Promise.resolve({
              status: "completed",
              rawOutput: {
                results: [
                  {
                    chunkId: input.candidates[0]!.chunkId,
                    relevanceScore: 99,
                    rank: 1,
                    rationale:
                      "Fixture reranker selected the most relevant candidate.",
                  },
                ],
              },
              execution: {
                ...modelExecution("rerank", input.bm25RunId),
              },
            }),
        }
      : {},
    {
      recordedAt: "2026-07-17T10:30:00.000Z",
      prepareArtifactUri: "fixture://canonical-prepare/prepare.json",
      scopeArtifactUri: "fixture://canonical-scope/scope.json",
      reranking: options.reranking
        ? { enabled: true, topN: 3 }
        : { enabled: false },
    },
  );
  const evidence = buildCanonicalEvidenceArtifact({
    result: evidenceResult,
    runId: discover.runId,
    createdAt: "2026-07-17T10:35:00.000Z",
  });

  const variant = options.adjudicateVariant ?? "F";
  const calls: CanonicalAdjudicateAdapterInput[] = [];
  const adjudicateResult = await runCanonicalAdjudicate(
    evidence,
    prepare,
    {
      adjudicate: (input) => {
        calls.push(input);
        const execution = {
          ...modelExecution("adjudicate", input.recordId),
          promptId: String(input.promptId),
          promptVersion: String(input.promptVersion),
          promptContentHash: canonicalSha256(input.promptText),
          requestHash: hashCanonicalAdjudicateRequest(input),
        };
        if (variant === "nonfatal_failure") {
          return Promise.resolve({
            status: "failed",
            reasonCode: "timeout",
            reason: "Fixture adjudicator timed out.",
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
        return Promise.resolve({
          status: "completed",
          rawOutput: {
            comparison:
              "The citing paper attributes Rab35 silencing to bulkhead loss.",
            verdict: variant,
            rationale: "Fixture adjudication rationale.",
            confidence: "medium",
            evaluatedClaimRecordIds: input.packet.occurrenceClaims.map(
              (claim) => claim.claimRecordId,
            ),
            citedChunkIds: [input.packet.selectedChunks[0]!.chunkId],
          },
          execution,
        });
      },
    },
    {
      recordedAt: "2026-07-17T10:40:00.000Z",
      evidenceArtifactUri: "fixture://canonical-evidence/evidence.json",
      prepareArtifactUri: "fixture://canonical-prepare/prepare.json",
    },
  );
  const adjudicate = buildCanonicalAdjudicateArtifact({
    result: adjudicateResult,
    runId: discover.runId,
    createdAt: "2026-07-17T10:45:00.000Z",
  });
  return { discover, scope, prepare, evidence, adjudicate, calls };
}

function rehashArtifact<T extends { contentHash: string; artifactId: string }>(
  artifact: T,
): T {
  artifact.contentHash = computeLeanArtifactContentHash(artifact as never);
  artifact.artifactId = computeLeanArtifactId(artifact as never);
  return artifact;
}

describe("canonical Report", () => {
  it("builds a complete Discover→…→Report fixture with mixed adjudicated and gated outcomes", async () => {
    const chain = await buildChain({
      classifier: "mixed",
      adjudicateVariant: "F",
    });
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );

    expect(result.payload.recordTraces).toHaveLength(
      chain.prepare.payload.records.length,
    );
    expect(result.payload.funnel.adjudicate.adjudicated.count).toBeGreaterThan(
      0,
    );
    expect(
      result.payload.funnel.adjudicate.notAdjudicated.count,
    ).toBeGreaterThan(0);
    expect(
      result.payload.funnel.adjudicate.adjudicated.count +
        result.payload.funnel.adjudicate.notAdjudicated.count +
        result.payload.funnel.adjudicate.adjudicationFailed.count +
        result.payload.funnel.adjudicate.invalidOutput.count,
    ).toBe(result.payload.funnel.adjudicate.totalRecordOutcomes.count);

    const artifact = buildCanonicalReportArtifact({
      result,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T10:51:00.000Z",
    });
    expect(artifact.execution).toMatchObject({
      kind: "deterministic",
      replayableFromInputs: true,
    });
    expect(artifact.provenance.prompts).toEqual([]);
    expect(artifact.provenance.models).toEqual([]);
    expect(artifact.inputArtifacts).toHaveLength(5);
  });

  it("validates exact lineage across all five ancestors before output", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      {
        recordedAt: "2026-07-17T10:50:00.000Z",
        discoverArtifactUri: "fixture://discover.json",
        scopeArtifactUri: "fixture://scope.json",
        prepareArtifactUri: "fixture://prepare.json",
        evidenceArtifactUri: "fixture://evidence.json",
        adjudicateArtifactUri: "fixture://adjudicate.json",
      },
    );
    expect(result.payload.lineage.runId).toBe(chain.discover.runId);
    expect(result.payload.lineage.discoverArtifact.artifactId).toBe(
      chain.discover.artifactId,
    );
    expect(result.payload.lineage.scopeArtifact.contentHash).toBe(
      chain.scope.contentHash,
    );
    expect(result.payload.lineage.prepareArtifact.artifactId).toBe(
      chain.prepare.artifactId,
    );
    expect(result.payload.lineage.evidenceArtifact.contentHash).toBe(
      chain.evidence.contentHash,
    );
    expect(result.payload.lineage.adjudicateArtifact.artifactId).toBe(
      chain.adjudicate.artifactId,
    );
  });

  it("matches funnel counts to source artifacts for each distinct unit", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const { funnel } = result.payload;
    expect(funnel.discover.seeds.count).toBe(
      chain.discover.payload.seeds.length,
    );
    expect(funnel.discover.returnedCitingPaperObservations.count).toBe(
      chain.discover.payload.citingPapers.length,
    );
    expect(funnel.discover.citationOccurrences.count).toBe(
      chain.discover.payload.citationMentions.length,
    );
    expect(funnel.discover.attributedClaimRecords.count).toBe(
      chain.discover.payload.attributedClaimRecords.length,
    );
    expect(funnel.discover.candidateClaims.count).toBe(
      chain.discover.payload.claimCandidates.length,
    );
    expect(funnel.scope.families.count).toBe(
      chain.scope.payload.families.length,
    );
    expect(funnel.prepare.preparedRecords.count).toBe(
      chain.prepare.payload.records.length,
    );
    expect(funnel.prepare.manualReview.metricId).toBe("prepare.manual_review");
    expect(funnel.prepare.manualReviewRoleAmbiguous.metricId).toBe(
      "prepare.manual_review_role_ambiguous",
    );
    expect(funnel.prepare.manualReviewExtractionLimited.metricId).toBe(
      "prepare.manual_review_extraction_limited",
    );
    expect(funnel.prepare.manualReviewRoleAmbiguous.unit).toBe(
      "family_occurrence_records",
    );
    expect(funnel.prepare.manualReviewExtractionLimited.unit).toBe(
      "family_occurrence_records",
    );
    expect(funnel.evidence.recordOutcomes.count).toBe(
      chain.evidence.payload.records.length,
    );
    expect(funnel.adjudicate.totalRecordOutcomes.count).toBe(
      chain.adjudicate.payload.records.length,
    );
    expect(funnel.discover.seeds.unit).toBe("seeds");
    expect(funnel.discover.returnedCitingPaperObservations.unit).toBe(
      "citing_paper_observations",
    );
    expect(funnel.discover.citationOccurrences.unit).toBe(
      "citation_occurrences",
    );
    expect(funnel.discover.candidateClaims.unit).toBe("candidates");
    expect(funnel.scope.families.unit).toBe("families");
    expect(funnel.prepare.preparedRecords.unit).toBe(
      "family_occurrence_records",
    );

    const wrongUnit = structuredClone(result.payload);
    wrongUnit.funnel.discover.returnedCitingPaperObservations.unit =
      "candidates";
    expect(reportArtifactPayloadSchema.safeParse(wrongUnit).success).toBe(
      false,
    );
  });

  it("recomputes every rate with documented numerator and denominator", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    for (const rate of result.payload.rates) {
      if (rate.denominator === 0) {
        expect(rate.value).toBeNull();
      } else {
        expect(rate.value).toBe(rate.numerator / rate.denominator);
      }
      expect(Number.isFinite(rate.numerator)).toBe(true);
      expect(Number.isFinite(rate.denominator)).toBe(true);
      if (rate.value != null) {
        expect(Number.isFinite(rate.value)).toBe(true);
      }
      expect(rate.numeratorDefinition.length).toBeGreaterThan(0);
      expect(rate.denominatorDefinition.length).toBeGreaterThan(0);
    }
    expect(
      reportRateSchema.safeParse({
        ...result.payload.rates[0],
        numerator: 2,
        denominator: 1,
        value: 2,
      }).success,
    ).toBe(false);
  });

  it("binds required rate numerators and denominators to funnel populations", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    for (const metricId of [
      "adjudication_coverage",
      "retrieval_coverage",
      "scope_selection_rate",
    ]) {
      const tampered = structuredClone(result.payload);
      const rate = tampered.rates.find((entry) => entry.metricId === metricId);
      if (rate == null || rate.denominator === 0) {
        throw new Error(`Expected estimable fixture rate: ${metricId}`);
      }
      rate.numerator = rate.numerator === 0 ? 1 : 0;
      rate.value = rate.numerator / rate.denominator;
      expect(
        reportArtifactPayloadSchema.safeParse(tampered).success,
        metricId,
      ).toBe(false);
    }
  });

  it("rejects tampered funnel partitions for every population class", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const cases: Array<{
      name: string;
      mutate: (payload: typeof result.payload) => void;
    }> = [
      {
        name: "Discover probe",
        mutate: (payload) => {
          payload.funnel.discover.probed.count += 1;
        },
      },
      {
        name: "Discover materialization",
        mutate: (payload) => {
          payload.funnel.discover.materializationSucceeded.count += 1;
        },
      },
      {
        name: "Discover harvest",
        mutate: (payload) => {
          payload.funnel.discover.harvestSucceeded.count += 1;
        },
      },
      {
        name: "Discover extraction",
        mutate: (payload) => {
          payload.funnel.discover.extractionClaimsExtracted.count += 1;
        },
      },
      {
        name: "Discover candidates",
        mutate: (payload) => {
          payload.funnel.discover.deferredCandidates.count += 1;
        },
      },
      {
        name: "Scope candidates",
        mutate: (payload) => {
          payload.funnel.scope.scopedCandidates.count += 1;
        },
      },
      {
        name: "Scope grounding statuses",
        mutate: (payload) => {
          payload.funnel.scope.groundingStatusCounts[0]!.count += 1;
        },
      },
      {
        name: "Prepare expected pairs",
        mutate: (payload) => {
          payload.funnel.prepare.expectedFamilyOccurrencePairs.count += 1;
        },
      },
      {
        name: "Prepare classifications",
        mutate: (payload) => {
          payload.funnel.prepare.classified.count += 1;
        },
      },
      {
        name: "Evidence retrieval",
        mutate: (payload) => {
          payload.funnel.evidence.retrievalStatusCounts[0]!.count += 1;
        },
      },
      {
        name: "Evidence rerank",
        mutate: (payload) => {
          payload.funnel.evidence.rerankDisabled.count += 1;
        },
      },
      {
        name: "Adjudicate statuses",
        mutate: (payload) => {
          payload.funnel.adjudicate.notAdjudicated.count += 1;
        },
      },
      {
        name: "Adjudicate verdicts",
        mutate: (payload) => {
          payload.funnel.adjudicate.verdictCounts.F.count += 1;
        },
      },
    ];
    for (const testCase of cases) {
      const tampered = structuredClone(result.payload);
      testCase.mutate(tampered);
      expect(
        reportArtifactPayloadSchema.safeParse(tampered).success,
        testCase.name,
      ).toBe(false);
    }
  });

  it("requires unique ordered status summaries and exact Evidence status enums", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );

    const duplicate = structuredClone(result.payload);
    duplicate.funnel.evidence.retrievalStatusCounts.push(
      structuredClone(duplicate.funnel.evidence.retrievalStatusCounts[0]!),
    );
    expect(reportArtifactPayloadSchema.safeParse(duplicate).success).toBe(
      false,
    );

    const unordered = structuredClone(result.payload);
    unordered.funnel.evidence.retrievalStatusCounts = [
      { status: "retrieved", count: unordered.recordTraces.length },
      { status: "no_lexical_matches", count: 0 },
    ];
    expect(reportArtifactPayloadSchema.safeParse(unordered).success).toBe(
      false,
    );

    const inventedRetrieval = structuredClone(result.payload);
    Object.assign(inventedRetrieval.recordTraces[0]!.evidence, {
      retrievalStatus: "invented_retrieval_status",
    });
    expect(
      reportArtifactPayloadSchema.safeParse(inventedRetrieval).success,
    ).toBe(false);

    const inventedRerank = structuredClone(result.payload);
    Object.assign(inventedRerank.recordTraces[0]!.evidence, {
      rerankStatus: "invented_rerank_status",
    });
    expect(reportArtifactPayloadSchema.safeParse(inventedRerank).success).toBe(
      false,
    );
  });

  it("requires stable identifiers throughout per-record traces", async () => {
    const chain = await buildChain({ reranking: true });
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const fields: Array<{
      name: string;
      mutate: (payload: typeof result.payload) => void;
    }> = [
      {
        name: "recordId",
        mutate: (payload) => {
          payload.recordTraces[0]!.recordId = "malformed";
        },
      },
      {
        name: "familyId",
        mutate: (payload) => {
          payload.recordTraces[0]!.familyId = "malformed";
        },
      },
      {
        name: "citationOccurrenceId",
        mutate: (payload) => {
          payload.recordTraces[0]!.citationOccurrenceId = "malformed";
        },
      },
      {
        name: "adjudicationResultId",
        mutate: (payload) => {
          payload.recordTraces[0]!.adjudication.adjudicationResultId =
            "malformed";
        },
      },
      {
        name: "queryId",
        mutate: (payload) => {
          payload.recordTraces[0]!.evidence.queryId = "malformed";
        },
      },
      {
        name: "bm25RunId",
        mutate: (payload) => {
          payload.recordTraces[0]!.evidence.bm25RunId = "malformed";
        },
      },
      {
        name: "rerankRunId",
        mutate: (payload) => {
          payload.recordTraces[0]!.evidence.rerankRunId = "malformed";
        },
      },
      {
        name: "finalSelectionId",
        mutate: (payload) => {
          payload.recordTraces[0]!.evidence.finalSelectionId = "malformed";
        },
      },
    ];
    for (const testCase of fields) {
      const tampered = structuredClone(result.payload);
      testCase.mutate(tampered);
      expect(
        reportArtifactPayloadSchema.safeParse(tampered).success,
        testCase.name,
      ).toBe(false);
    }
  });

  it("enforces exact adjudication trace variants and forbidden combinations", async () => {
    const normalChain = await buildChain({ classifier: "mixed" });
    const normal = runCanonicalReport(
      normalChain.discover,
      normalChain.scope,
      normalChain.prepare,
      normalChain.evidence,
      normalChain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    ).payload;
    const failedChain = await buildChain({
      classifier: "default",
      adjudicateVariant: "nonfatal_failure",
    });
    const failed = runCanonicalReport(
      failedChain.discover,
      failedChain.scope,
      failedChain.prepare,
      failedChain.evidence,
      failedChain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    ).payload;
    const invalidChain = await buildChain({
      classifier: "default",
      adjudicateVariant: "malformed",
    });
    const invalid = runCanonicalReport(
      invalidChain.discover,
      invalidChain.scope,
      invalidChain.prepare,
      invalidChain.evidence,
      invalidChain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    ).payload;

    const adjudicatedIndex = normal.recordTraces.findIndex(
      (trace) => trace.adjudication.status === "adjudicated",
    );
    const gatedIndex = normal.recordTraces.findIndex(
      (trace) => trace.adjudication.status === "not_adjudicated",
    );
    if (adjudicatedIndex < 0 || gatedIndex < 0) {
      throw new Error("Expected mixed adjudicated and gated fixture");
    }
    const cases: Array<{
      name: string;
      payload: typeof normal;
      index: number;
      mutate: (trace: (typeof normal.recordTraces)[number]) => void;
    }> = [
      {
        name: "adjudicated missing verdict",
        payload: normal,
        index: adjudicatedIndex,
        mutate: (trace) => {
          delete (trace.adjudication as { verdict?: string }).verdict;
        },
      },
      {
        name: "adjudicated with gate",
        payload: normal,
        index: adjudicatedIndex,
        mutate: (trace) => {
          Object.assign(trace.adjudication, {
            gateCode: "skip_low_information",
          });
        },
      },
      {
        name: "adjudicated with failure",
        payload: normal,
        index: adjudicatedIndex,
        mutate: (trace) => {
          Object.assign(trace.adjudication, { failureCode: "timeout" });
        },
      },
      {
        name: "not_adjudicated missing gate",
        payload: normal,
        index: gatedIndex,
        mutate: (trace) => {
          delete (trace.adjudication as { gateCode?: string }).gateCode;
        },
      },
      {
        name: "not_adjudicated with verdict",
        payload: normal,
        index: gatedIndex,
        mutate: (trace) => {
          Object.assign(trace.adjudication, { verdict: "U" });
        },
      },
      {
        name: "not_adjudicated with failure",
        payload: normal,
        index: gatedIndex,
        mutate: (trace) => {
          Object.assign(trace.adjudication, { failureCode: "timeout" });
        },
      },
      {
        name: "adjudication_failed missing failure",
        payload: failed,
        index: 0,
        mutate: (trace) => {
          delete (trace.adjudication as { failureCode?: string }).failureCode;
        },
      },
      {
        name: "adjudication_failed with verdict",
        payload: failed,
        index: 0,
        mutate: (trace) => {
          Object.assign(trace.adjudication, { verdict: "U" });
        },
      },
      {
        name: "adjudication_failed with gate",
        payload: failed,
        index: 0,
        mutate: (trace) => {
          Object.assign(trace.adjudication, {
            gateCode: "retrieval_failed",
          });
        },
      },
      {
        name: "invalid_output with verdict",
        payload: invalid,
        index: 0,
        mutate: (trace) => {
          Object.assign(trace.adjudication, { verdict: "U" });
        },
      },
      {
        name: "invalid_output with gate",
        payload: invalid,
        index: 0,
        mutate: (trace) => {
          Object.assign(trace.adjudication, {
            gateCode: "retrieval_failed",
          });
        },
      },
      {
        name: "invalid_output with failure",
        payload: invalid,
        index: 0,
        mutate: (trace) => {
          Object.assign(trace.adjudication, { failureCode: "timeout" });
        },
      },
    ];
    for (const testCase of cases) {
      const tampered = structuredClone(testCase.payload);
      testCase.mutate(tampered.recordTraces[testCase.index]!);
      expect(
        reportArtifactPayloadSchema.safeParse(tampered).success,
        testCase.name,
      ).toBe(false);
    }
  });

  it("enforces canonical Evidence trace status and reference combinations", async () => {
    const normalChain = await buildChain({ classifier: "default" });
    const normalPayload = runCanonicalReport(
      normalChain.discover,
      normalChain.scope,
      normalChain.prepare,
      normalChain.evidence,
      normalChain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    ).payload;
    const rerankedChain = await buildChain({
      classifier: "default",
      reranking: true,
    });
    const rerankedPayload = runCanonicalReport(
      rerankedChain.discover,
      rerankedChain.scope,
      rerankedChain.prepare,
      rerankedChain.evidence,
      rerankedChain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    ).payload;
    const retrieved = structuredClone(normalPayload.recordTraces[0]!);
    const reranked = structuredClone(rerankedPayload.recordTraces[0]!);
    if (
      retrieved.evidence.bm25RunId == null ||
      retrieved.evidence.finalSelectionId == null ||
      reranked.evidence.rerankRunId == null
    ) {
      throw new Error("Expected complete retrieved/reranked fixture traces");
    }

    const gatedAdjudication = (
      gateCode:
        | "no_lexical_matches"
        | "seed_text_unavailable"
        | "seed_acquisition_failed"
        | "retrieval_failed",
    ) => ({
      status: "not_adjudicated" as const,
      adjudicationResultId: retrieved.adjudication.adjudicationResultId,
      gateCode,
    });
    const noMatches = {
      ...structuredClone(retrieved),
      evidence: {
        retrievalStatus: "no_lexical_matches" as const,
        rerankStatus: "not_attempted_no_candidates" as const,
        queryId: retrieved.evidence.queryId,
        bm25RunId: retrieved.evidence.bm25RunId,
      },
      adjudication: gatedAdjudication("no_lexical_matches"),
    };
    const unavailable = {
      ...structuredClone(retrieved),
      evidence: {
        retrievalStatus: "seed_text_unavailable" as const,
        rerankStatus: "not_attempted_unavailable" as const,
        queryId: retrieved.evidence.queryId,
      },
      adjudication: gatedAdjudication("seed_text_unavailable"),
    };
    const acquisitionFailed = {
      ...structuredClone(retrieved),
      evidence: {
        retrievalStatus: "seed_acquisition_failed" as const,
        rerankStatus: "disabled" as const,
        queryId: retrieved.evidence.queryId,
      },
      adjudication: gatedAdjudication("seed_acquisition_failed"),
    };
    const retrievalFailed = {
      ...structuredClone(retrieved),
      evidence: {
        retrievalStatus: "retrieval_failed" as const,
        rerankStatus: "not_attempted_retrieval_failure" as const,
        queryId: retrieved.evidence.queryId,
      },
      adjudication: gatedAdjudication("retrieval_failed"),
    };
    const rerankFailed = {
      ...structuredClone(retrieved),
      evidence: {
        ...retrieved.evidence,
        rerankStatus: "failed" as const,
        rerankRunId: reranked.evidence.rerankRunId,
        rankingSource: "bm25" as const,
      },
    };

    for (const [name, trace] of [
      ["retrieved with disabled rerank", retrieved],
      ["retrieved with completed rerank", reranked],
      ["no lexical matches", noMatches],
      ["seed text unavailable", unavailable],
      ["seed acquisition failed", acquisitionFailed],
      ["retrieval failed", retrievalFailed],
      ["retrieved with failed rerank BM25 fallback", rerankFailed],
    ] as const) {
      expect(reportRecordTraceSchema.safeParse(trace).success, name).toBe(true);
    }

    const cases: Array<{
      name: string;
      base: unknown;
      mutate: (trace: { evidence: Record<string, unknown> }) => void;
    }> = [
      {
        name: "missing query",
        base: retrieved,
        mutate: (trace) => {
          delete trace.evidence.queryId;
        },
      },
      {
        name: "retrieved missing BM25",
        base: retrieved,
        mutate: (trace) => {
          delete trace.evidence.bm25RunId;
        },
      },
      {
        name: "retrieved missing final selection",
        base: retrieved,
        mutate: (trace) => {
          delete trace.evidence.finalSelectionId;
          delete trace.evidence.rankingSource;
        },
      },
      {
        name: "retrieved with not-attempted rerank",
        base: retrieved,
        mutate: (trace) => {
          trace.evidence.rerankStatus = "not_attempted_no_candidates";
        },
      },
      {
        name: "reranked source without completed rerank",
        base: retrieved,
        mutate: (trace) => {
          trace.evidence.rankingSource = "reranked";
        },
      },
      {
        name: "no matches missing BM25",
        base: noMatches,
        mutate: (trace) => {
          delete trace.evidence.bm25RunId;
        },
      },
      {
        name: "no matches with final selection",
        base: noMatches,
        mutate: (trace) => {
          trace.evidence.finalSelectionId = retrieved.evidence.finalSelectionId;
          trace.evidence.rankingSource = "bm25";
        },
      },
      {
        name: "no matches with rerank run",
        base: noMatches,
        mutate: (trace) => {
          trace.evidence.rerankRunId = reranked.evidence.rerankRunId;
        },
      },
      {
        name: "unavailable with ranking references",
        base: unavailable,
        mutate: (trace) => {
          trace.evidence.bm25RunId = retrieved.evidence.bm25RunId;
          trace.evidence.finalSelectionId = retrieved.evidence.finalSelectionId;
          trace.evidence.rankingSource = "bm25";
        },
      },
      {
        name: "acquisition failed with rerank reference",
        base: acquisitionFailed,
        mutate: (trace) => {
          trace.evidence.rerankStatus = "failed";
          trace.evidence.rerankRunId = reranked.evidence.rerankRunId;
        },
      },
      {
        name: "retrieval failed with BM25 reference",
        base: retrievalFailed,
        mutate: (trace) => {
          trace.evidence.bm25RunId = retrieved.evidence.bm25RunId;
        },
      },
      {
        name: "completed rerank missing rerank run",
        base: reranked,
        mutate: (trace) => {
          delete trace.evidence.rerankRunId;
        },
      },
      {
        name: "failed rerank missing rerank run",
        base: rerankFailed,
        mutate: (trace) => {
          delete trace.evidence.rerankRunId;
        },
      },
      {
        name: "disabled rerank with rerank run",
        base: retrieved,
        mutate: (trace) => {
          trace.evidence.rerankRunId = reranked.evidence.rerankRunId;
        },
      },
      {
        name: "not-attempted rerank with rerank run",
        base: noMatches,
        mutate: (trace) => {
          trace.evidence.rerankRunId = reranked.evidence.rerankRunId;
        },
      },
      {
        name: "reranked source with failed rerank",
        base: rerankFailed,
        mutate: (trace) => {
          trace.evidence.rankingSource = "reranked";
        },
      },
      {
        name: "BM25 source with completed rerank",
        base: reranked,
        mutate: (trace) => {
          trace.evidence.rankingSource = "bm25";
        },
      },
    ];
    for (const testCase of cases) {
      const tampered = structuredClone(testCase.base) as {
        evidence: Record<string, unknown>;
      };
      testCase.mutate(tampered);
      expect(
        reportRecordTraceSchema.safeParse(tampered).success,
        testCase.name,
      ).toBe(false);
    }
  });

  it("rejects fatal failure codes on per-record nonfatal adjudication failures", async () => {
    const chain = await buildChain({
      classifier: "default",
      adjudicateVariant: "nonfatal_failure",
    });
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const tampered = structuredClone(result.payload);
    Object.assign(tampered.recordTraces[0]!.adjudication, {
      failureCode: "quota",
    });
    expect(reportArtifactPayloadSchema.safeParse(tampered).success).toBe(false);
  });

  it("uses adjudicated denominator for F/D/E/U rates and all records for coverage", async () => {
    const chain = await buildChain({ adjudicateVariant: "D" });
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const adjudicated = result.payload.funnel.adjudicate.adjudicated.count;
    const total = result.payload.funnel.adjudicate.totalRecordOutcomes.count;
    const coverage = result.payload.rates.find(
      (rate) => rate.metricId === "adjudication_coverage",
    )!;
    expect(coverage.denominator).toBe(total);
    expect(coverage.numerator).toBe(adjudicated);
    for (const metricId of [
      "verdict_F_rate",
      "verdict_D_rate",
      "verdict_E_rate",
      "verdict_U_rate",
    ]) {
      const rate = result.payload.rates.find(
        (entry) => entry.metricId === metricId,
      )!;
      expect(rate.denominator).toBe(adjudicated);
      expect(rate.denominator).not.toBe(total);
    }
  });

  it("keeps operational failures out of verdict counts and keeps U separate", async () => {
    const chain = await buildChain({
      classifier: "default",
      adjudicateVariant: "nonfatal_failure",
    });
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    expect(result.payload.funnel.adjudicate.adjudicationFailed.count).toBe(
      chain.adjudicate.payload.records.length,
    );
    expect(result.payload.funnel.adjudicate.adjudicated.count).toBe(0);
    expect(result.payload.funnel.adjudicate.verdictCounts.U.count).toBe(0);
    expect(result.payload.funnel.adjudicate.verdictCounts.E.count).toBe(0);
    for (const trace of result.payload.recordTraces) {
      expect(trace.adjudication.status).toBe("adjudication_failed");
      expect(trace.adjudication).not.toHaveProperty("verdict");
    }
  });

  it("yields null verdict rates and Markdown not-estimable for zero adjudicated", async () => {
    const chain = await buildChain({ grounding: "seed_text_unavailable" });
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    expect(result.payload.funnel.adjudicate.adjudicated.count).toBe(0);
    for (const metricId of [
      "verdict_F_rate",
      "verdict_D_rate",
      "verdict_E_rate",
      "verdict_U_rate",
    ]) {
      const rate = result.payload.rates.find(
        (entry) => entry.metricId === metricId,
      )!;
      expect(rate.denominator).toBe(0);
      expect(rate.value).toBeNull();
    }
    const markdown = renderCanonicalReportMarkdown(result.payload);
    expect(markdown).toContain("not estimable (zero denominator)");
    expect(markdown).not.toMatch(/verdict_F_rate`.*\b0%/);
    expect(markdown).not.toContain("NaN");
    expect(markdown).not.toContain("Infinity");
  });

  it("omits headline score and evaluation statistics from schema and output", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const serialized = canonicalSerialize(result.payload);
    for (const forbidden of [
      "headlineScore",
      "qualityScore",
      "faithfulnessRate",
      "partialFidelityRate",
      "accuracy",
      "agreement",
      "benchmark",
      "humanVsModel",
      "evaluationStatistics",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(
      result.payload.rates.some((rate) =>
        /accuracy|agreement|benchmark|headline|quality|faithfulness|partial_fidelity/.test(
          rate.metricId,
        ),
      ),
    ).toBe(false);
  });

  it("keeps BM25 and reranked selection-source counts separate", async () => {
    const chain = await buildChain({ classifier: "default" });
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    expect(result.payload.funnel.evidence.uniqueFinalSelectionsBm25.count).toBe(
      chain.evidence.payload.selections.filter(
        (selection) => selection.rankingSource === "bm25",
      ).length,
    );
    expect(
      result.payload.funnel.evidence.uniqueFinalSelectionsReranked.count,
    ).toBe(
      chain.evidence.payload.selections.filter(
        (selection) => selection.rankingSource === "reranked",
      ).length,
    );
    expect(result.payload.funnel.evidence.recordSelectionBm25.count).toBe(
      result.payload.recordTraces.filter(
        (trace) => trace.evidence.rankingSource === "bm25",
      ).length,
    );
    expect(result.payload.funnel.evidence.recordSelectionReranked.count).toBe(
      result.payload.recordTraces.filter(
        (trace) => trace.evidence.rankingSource === "reranked",
      ).length,
    );
    expect(result.payload.funnel.evidence.rerankDisabled.count).toBe(
      chain.evidence.payload.records.length,
    );

    const rerankedChain = await buildChain({
      classifier: "default",
      reranking: true,
    });
    const rerankedResult = runCanonicalReport(
      rerankedChain.discover,
      rerankedChain.scope,
      rerankedChain.prepare,
      rerankedChain.evidence,
      rerankedChain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    expect(
      rerankedResult.payload.funnel.evidence.uniqueFinalSelectionsReranked
        .count,
    ).toBeGreaterThan(0);
    expect(
      rerankedResult.payload.funnel.evidence.recordSelectionReranked.count,
    ).toBe(rerankedResult.payload.recordTraces.length);
    expect(
      rerankedResult.payload.funnel.evidence.uniqueFinalSelectionsReranked
        .count,
    ).toBeLessThanOrEqual(
      rerankedResult.payload.funnel.evidence.recordSelectionReranked.count,
    );
    expect(
      rerankedResult.payload.funnel.evidence.uniqueFinalSelectionsBm25.count,
    ).toBe(0);
    expect(
      rerankedResult.payload.funnel.evidence.recordSelectionBm25.count,
    ).toBe(0);

    for (const field of [
      "uniqueFinalSelectionsBm25",
      "uniqueFinalSelectionsReranked",
      "recordSelectionBm25",
      "recordSelectionReranked",
    ] as const) {
      const tampered = structuredClone(result.payload);
      tampered.funnel.evidence[field].count += 1;
      expect(
        reportArtifactPayloadSchema.safeParse(tampered).success,
        field,
      ).toBe(false);
    }
  });

  it("emits exactly one per-record trace and rejects missing or duplicate traces", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const ids = result.payload.recordTraces.map((trace) => trace.recordId);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids.sort()).toEqual(
      chain.prepare.payload.records.map((record) => record.recordId).sort(),
    );

    const artifact = buildCanonicalReportArtifact({
      result,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T10:51:00.000Z",
    });
    const duplicated = structuredClone(artifact);
    duplicated.payload.recordTraces.push(duplicated.payload.recordTraces[0]!);
    expect(reportArtifactSchema.safeParse(duplicated).success).toBe(false);

    const missing = structuredClone(artifact);
    missing.payload.recordTraces = missing.payload.recordTraces.slice(1);
    missing.payload.funnel.prepare.preparedRecords.count =
      missing.payload.recordTraces.length;
    missing.payload.funnel.evidence.recordOutcomes.count =
      missing.payload.recordTraces.length;
    missing.payload.funnel.adjudicate.totalRecordOutcomes.count =
      missing.payload.recordTraces.length;
    expect(reportArtifactSchema.safeParse(missing).success).toBe(false);
  });

  it("is stable and deterministic across identical inputs excluding createdAt", async () => {
    const chain = await buildChain();
    const resultA = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const resultB = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    expect(canonicalSerialize(resultA.payload)).toBe(
      canonicalSerialize(resultB.payload),
    );
    const artifactA = buildCanonicalReportArtifact({
      result: resultA,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T10:51:00.000Z",
    });
    const artifactB = buildCanonicalReportArtifact({
      result: resultB,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T11:00:00.000Z",
    });
    expect(artifactA.artifactId).toBe(artifactB.artifactId);
    expect(artifactA.contentHash).toBe(artifactB.contentHash);
    expect(renderCanonicalReportMarkdown(artifactA.payload)).toBe(
      renderCanonicalReportMarkdown(artifactB.payload),
    );
  });

  it("renders Markdown from exact JSON numerators, denominators, and rates", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const markdown = renderCanonicalReportMarkdown(result.payload);
    for (const rate of result.payload.rates) {
      expect(markdown).toContain(`\`${rate.metricId}\``);
      expect(markdown).toContain(`numerator=${String(rate.numerator)}`);
      expect(markdown).toContain(`denominator=${String(rate.denominator)}`);
      if (rate.value == null) {
        expect(markdown).toContain("not estimable (zero denominator)");
      } else {
        expect(markdown).toContain(String(rate.value));
      }
    }
    expect(markdown).toContain(result.payload.interpretationWarning);
    expect(markdown).toContain(
      "Low-information and manual-review counts are overlapping",
    );
    expect(markdown).toContain(
      "Manual-review queue entries stay gated as operational non-verdicts",
    );
    expect(markdown).toContain("prepare.manual_review_role_ambiguous");
    expect(markdown).toContain("prepare.manual_review_extraction_limited");
    expect(markdown).toContain(
      "Unique final selections count selection objects",
    );
    expect(markdown).toContain("unit: citing-paper observations");
  });

  it("writes paired JSON/Markdown and loads current JSON with tamper hashes", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const artifact = buildCanonicalReportArtifact({
      result,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T10:51:00.000Z",
    });
    const dir = mkdtempSync(join(tmpdir(), "canonical-report-"));
    try {
      const jsonPath = join(dir, "report.json");
      const markdownPath = join(dir, "report.md");
      const written = writeCanonicalReportArtifacts(
        jsonPath,
        markdownPath,
        artifact,
      );
      expect(written.markdown).toBe(readFileSync(markdownPath, "utf8"));
      const loaded = loadCanonicalReportArtifact(jsonPath);
      expect(loaded.artifactId).toBe(artifact.artifactId);
      expect(loaded.contentHash).toBe(artifact.contentHash);
      expect(renderCanonicalReportMarkdown(loaded)).toBe(written.markdown);

      const tampered = structuredClone(loaded);
      tampered.payload.funnel.discover.seeds.count = 999;
      writeFileSync(jsonPath, JSON.stringify(tampered, null, 2), "utf8");
      expect(() => loadCanonicalReportArtifact(jsonPath)).toThrow(
        /Invalid canonical Report|contentHash|artifactId/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects resolved JSON/Markdown path collisions before writing", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const artifact = buildCanonicalReportArtifact({
      result,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T10:51:00.000Z",
    });
    const dir = mkdtempSync(join(tmpdir(), "canonical-report-collision-"));
    try {
      const jsonPath = join(dir, "report.json");
      const collidingMarkdownPath = `${dir}/./report.json`;
      writeFileSync(jsonPath, "sentinel", "utf8");
      expect(() =>
        writeCanonicalReportArtifacts(
          jsonPath,
          collidingMarkdownPath,
          artifact,
        ),
      ).toThrow(/must resolve to different files/i);
      expect(readFileSync(jsonPath, "utf8")).toBe("sentinel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects cross-run, tampered, and mismatched ancestors", async () => {
    const chain = await buildChain();
    const other = await buildChain({ runId: "run-other-report" });
    expect(() =>
      runCanonicalReport(
        other.discover,
        chain.scope,
        chain.prepare,
        chain.evidence,
        chain.adjudicate,
        { recordedAt: "2026-07-17T10:50:00.000Z" },
      ),
    ).toThrow(CanonicalReportBoundaryError);

    const tamperedEvidence: EvidenceArtifact = structuredClone(chain.evidence);
    const firstDecision = tamperedEvidence.decisions[0];
    if (firstDecision == null) {
      throw new Error("Expected at least one Evidence decision");
    }
    firstDecision.reason =
      "Tampered evidence decision reason for lineage mismatch.";
    firstDecision.decisionId = buildDecisionId(firstDecision);
    rehashArtifact(tamperedEvidence);
    expect(() =>
      runCanonicalReport(
        chain.discover,
        chain.scope,
        chain.prepare,
        tamperedEvidence,
        chain.adjudicate,
        { recordedAt: "2026-07-17T10:50:00.000Z" },
      ),
    ).toThrow(/Evidence lineage|content hash|different runs/i);

    const mismatchedPrepare: PrepareArtifact = structuredClone(chain.prepare);
    mismatchedPrepare.runId = "run-mismatched";
    rehashArtifact(mismatchedPrepare);
    expect(() =>
      runCanonicalReport(
        chain.discover,
        chain.scope,
        mismatchedPrepare,
        chain.evidence,
        chain.adjudicate,
        { recordedAt: "2026-07-17T10:50:00.000Z" },
      ),
    ).toThrow(CanonicalReportBoundaryError);
  });

  it("rejects model/prompt/non-replayable execution provenance on Report artifacts", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const artifact = buildCanonicalReportArtifact({
      result,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T10:51:00.000Z",
    });
    const withModel = structuredClone(artifact);
    withModel.execution = {
      kind: "model",
      implementation: "canonical-report-v1",
      replayableFromInputs: false,
      responseArtifacts: [
        artifactReference("model-response", "forbidden-report"),
      ],
    };
    withModel.provenance.prompts = [
      {
        promptId: "forbidden",
        version: "v1",
        contentHash: canonicalSha256("forbidden"),
      },
    ];
    withModel.provenance.models = [
      {
        provider: "fixture",
        model: "fixture-model",
        requestHash: canonicalSha256("request"),
        requestArtifact: artifactReference("model-request", "forbidden"),
        responseArtifact: artifactReference("model-response", "forbidden"),
      },
    ];
    rehashArtifact(withModel);
    expect(reportArtifactSchema.safeParse(withModel).success).toBe(false);
  });

  it("requires exactly the two canonical deterministic Report decisions", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const artifact = buildCanonicalReportArtifact({
      result,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T10:51:00.000Z",
    });

    const missing = structuredClone(artifact);
    missing.decisions = missing.decisions.slice(1);
    rehashArtifact(missing);
    expect(reportArtifactSchema.safeParse(missing).success).toBe(false);

    const duplicate = structuredClone(artifact);
    duplicate.decisions.push(structuredClone(duplicate.decisions[0]!));
    rehashArtifact(duplicate);
    expect(reportArtifactSchema.safeParse(duplicate).success).toBe(false);

    const extra = structuredClone(artifact);
    const extraDecision = structuredClone(extra.decisions[0]!);
    extraDecision.decisionType = "report_extra_decision";
    extraDecision.outcome = "forbidden";
    extraDecision.reason = "Report cannot add another decision.";
    extraDecision.decisionId = buildDecisionId(extraDecision);
    extra.decisions.push(extraDecision);
    rehashArtifact(extra);
    expect(reportArtifactSchema.safeParse(extra).success).toBe(false);

    const wrongReason = structuredClone(artifact);
    wrongReason.decisions[0]!.reason = "Changed interpretation reason.";
    wrongReason.decisions[0]!.decisionId = buildDecisionId(
      wrongReason.decisions[0]!,
    );
    rehashArtifact(wrongReason);
    expect(reportArtifactSchema.safeParse(wrongReason).success).toBe(false);

    const wrongActor = structuredClone(artifact);
    wrongActor.decisions[1]!.actor.identifier = "other-reporter";
    wrongActor.decisions[1]!.decisionId = buildDecisionId(
      wrongActor.decisions[1]!,
    );
    rehashArtifact(wrongActor);
    expect(reportArtifactSchema.safeParse(wrongActor).success).toBe(false);

    const missingLineage = structuredClone(artifact);
    missingLineage.decisions[0]!.evidenceArtifacts =
      missingLineage.decisions[0]!.evidenceArtifacts.slice(1);
    missingLineage.decisions[0]!.decisionId = buildDecisionId(
      missingLineage.decisions[0]!,
    );
    rehashArtifact(missingLineage);
    expect(reportArtifactSchema.safeParse(missingLineage).success).toBe(false);
  });

  it("forbids Report-stage exclusions", async () => {
    const chain = await buildChain();
    const result = runCanonicalReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-07-17T10:50:00.000Z" },
    );
    const artifact = buildCanonicalReportArtifact({
      result,
      runId: chain.discover.runId,
      createdAt: "2026-07-17T10:51:00.000Z",
    });
    const tampered = structuredClone(artifact);
    tampered.exclusions.push(
      createAppendOnlyExclusion({
        recordId: tampered.decisions[0]!.recordId,
        reasonCode: "forbidden_report_exclusion",
        reason: "Report must not exclude an upstream record.",
        recordedAt: "2026-07-17T10:50:00.000Z",
        actor: {
          kind: "deterministic",
          identifier: "canonical-audit-report-v1",
        },
        evidenceArtifacts: tampered.inputArtifacts,
        decisionId: tampered.decisions[0]!.decisionId,
      }),
    );
    rehashArtifact(tampered);
    expect(reportArtifactSchema.safeParse(tampered).success).toBe(false);
  });
});
