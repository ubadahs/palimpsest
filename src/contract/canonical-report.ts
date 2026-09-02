import { z } from "zod";

import {
  fidelityTopLabelSchema,
  mutationKindSchema,
} from "../domain/taxonomy.js";
import {
  buildStableId,
  canonicalSerialize,
} from "../shared/stable-identity.js";
import {
  adjudicateGateCodeSchema,
  mutationDirectionSchema,
  adjudicateNonfatalFailureCodeSchema,
} from "./canonical-adjudicate.js";
import {
  evidenceRerankStatusSchema,
  evidenceRetrievalStatusSchema,
} from "./canonical-evidence-statuses.js";
import {
  artifactReferenceSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "./lean-artifact-primitives.js";
import { canonicalStageKeySchema } from "./lean-stages.js";

/**
 * Canonical Report contract (isolated stage module). Shared envelope
 * primitives come from a cycle-free module; scientific stage contracts stay
 * outside that primitive boundary. Markdown is not part of the JSON payload —
 * it is a pure deterministic rendering of validated JSON only.
 */

export const canonicalReportMethodId = "canonical-audit-report-v1" as const;

export const canonicalReportMethodSchema = z
  .object({
    methodId: z.literal(canonicalReportMethodId),
    strategy: z.literal("deterministic_funnel"),
    calibrationStatus: z.literal("uncalibrated"),
    outputs: z.literal("json_and_markdown"),
  })
  .strict();
export type CanonicalReportMethod = z.infer<typeof canonicalReportMethodSchema>;

export const canonicalReportMethod: CanonicalReportMethod = {
  methodId: canonicalReportMethodId,
  strategy: "deterministic_funnel",
  calibrationStatus: "uncalibrated",
  outputs: "json_and_markdown",
};

export const reportInterpretationStatusSchema = z.literal(
  "uncalibrated_research_output",
);
export type ReportInterpretationStatus = z.infer<
  typeof reportInterpretationStatusSchema
>;

export const REPORT_INTERPRETATION_WARNING =
  "F/D/E/U labels are uncalibrated research outputs and have not been validated against blinded human labels. Do not treat verdict rates as calibrated faithfulness rates.";
export const REPORT_PUBLICATION_REASON =
  "Canonical Report publishes deterministic funnel accounting only; it does not manufacture scientific fidelity decisions.";

export function buildReportDecisionRecordId(runId: string): string {
  return buildStableId("report", {
    identityKind: "canonical-report-run-record",
    runId,
  });
}

const reportDiscoverArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-discover-input"),
    canonicalStage: z.literal("discover"),
  })
  .strict();

const reportScopeArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-scope-input"),
    canonicalStage: z.literal("scope"),
  })
  .strict();

const reportPrepareArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-prepare-input"),
    canonicalStage: z.literal("prepare"),
  })
  .strict();

const reportEvidenceArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-evidence-input"),
    canonicalStage: z.literal("evidence"),
  })
  .strict();

const reportAdjudicateArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-adjudicate-input"),
    canonicalStage: z.literal("adjudicate"),
  })
  .strict();

/**
 * Report binds all five upstream artifacts as direct inputs in fixed
 * canonical order: Discover → Scope → Prepare → Evidence → Adjudicate.
 */
export const reportLineageSchema = z
  .object({
    runId: z.string().min(1),
    discoverArtifact: reportDiscoverArtifactReferenceSchema,
    scopeArtifact: reportScopeArtifactReferenceSchema,
    prepareArtifact: reportPrepareArtifactReferenceSchema,
    evidenceArtifact: reportEvidenceArtifactReferenceSchema,
    adjudicateArtifact: reportAdjudicateArtifactReferenceSchema,
  })
  .strict();
export type ReportLineage = z.infer<typeof reportLineageSchema>;

const reportCountUnitSchema = z.enum([
  "seeds",
  "citing_paper_observations",
  "citing_papers",
  "citation_occurrences",
  "citation_groups",
  "attributed_claim_records",
  "candidates",
  "families",
  "family_occurrence_records",
  "unique_claim_units",
  "adjudication_packets",
  "bm25_runs",
  "rerank_runs",
  "selections",
  "decisions",
  "exclusions",
]);
export type ReportCountUnit = z.infer<typeof reportCountUnitSchema>;

const reportCountSchema = z
  .object({
    metricId: z.string().min(1),
    count: z.number().int().nonnegative(),
    unit: reportCountUnitSchema,
    population: z.string().min(1),
  })
  .strict();
export type ReportCount = z.infer<typeof reportCountSchema>;

export const reportRateSchema = z
  .object({
    metricId: z.string().min(1),
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    value: z.number().finite().nullable(),
    unit: z.string().min(1),
    populationLabel: z.string().min(1),
    numeratorDefinition: z.string().min(1),
    denominatorDefinition: z.string().min(1),
  })
  .strict()
  .superRefine((rate, context) => {
    if (
      !Number.isFinite(rate.numerator) ||
      !Number.isFinite(rate.denominator)
    ) {
      context.addIssue({
        code: "custom",
        path: ["numerator"],
        message: "Rate numerator and denominator must be finite integers",
      });
      return;
    }
    if (rate.numerator > rate.denominator) {
      context.addIssue({
        code: "custom",
        path: ["numerator"],
        message: "Rate numerator cannot exceed its denominator",
      });
    }
    if (rate.denominator === 0) {
      if (rate.value !== null) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message:
            "Zero-denominator rates must store value null (not estimable); never 0, NaN, or Infinity",
        });
      }
      return;
    }
    const expected = rate.numerator / rate.denominator;
    if (rate.value === null || !Number.isFinite(rate.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message:
          "Nonzero-denominator rates must store a finite recomputed numerator/denominator value",
      });
      return;
    }
    if (Math.abs(rate.value - expected) > 1e-12) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `Rate value ${String(rate.value)} does not equal numerator/denominator ${String(expected)}`,
      });
    }
  });
export type ReportRate = z.infer<typeof reportRateSchema>;

const reportStatusCountSchema = z
  .object({
    status: z.string().min(1),
    count: z.number().int().nonnegative(),
  })
  .strict();

const reportEvidenceRetrievalStatusCountSchema = z
  .object({
    status: evidenceRetrievalStatusSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

const reportAdjudicateGateCountSchema = z
  .object({
    status: adjudicateGateCodeSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

const reportAdjudicateFailureCountSchema = z
  .object({
    status: adjudicateNonfatalFailureCodeSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

const reportMutationKindCountSchema = z
  .object({
    status: mutationKindSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

const reportMutationDirectionCountSchema = z
  .object({
    status: mutationDirectionSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

const reportVerdictsByRankingSourceSchema = z
  .object({
    rankingSource: z.enum([
      "bm25",
      "reranked",
      "bm25_with_scope_pins",
      "reranked_with_scope_pins",
    ]),
    F: z.number().int().nonnegative(),
    D: z.number().int().nonnegative(),
    E: z.number().int().nonnegative(),
    U: z.number().int().nonnegative(),
  })
  .strict();

const reportProbeStratumCountSchema = z
  .object({
    /** `<year band>::<paper type>` as used by the deterministic probe sampler. */
    stratum: z.string().min(1),
    returned: z.number().int().nonnegative(),
    probed: z.number().int().nonnegative(),
  })
  .strict();

const discoverFunnelCountsSchema = z
  .object({
    seeds: reportCountSchema,
    /** Sampling design: how many citing papers each stratum returned and how many were probed. */
    probeStratumCounts: z.array(reportProbeStratumCountSchema),
    returnedCitingPaperObservations: reportCountSchema,
    probed: reportCountSchema,
    notProbed: reportCountSchema,
    materializationSucceeded: reportCountSchema,
    materializationFailed: reportCountSchema,
    materializationUnavailable: reportCountSchema,
    materializationNotAttempted: reportCountSchema,
    harvestSucceeded: reportCountSchema,
    harvestNoMentions: reportCountSchema,
    harvestFailed: reportCountSchema,
    harvestNotAttempted: reportCountSchema,
    citationOccurrences: reportCountSchema,
    extractionClaimsExtracted: reportCountSchema,
    extractionNoClaims: reportCountSchema,
    extractionFailed: reportCountSchema,
    attributedClaimRecords: reportCountSchema,
    candidateClaims: reportCountSchema,
    selectedCandidates: reportCountSchema,
    deferredCandidates: reportCountSchema,
    uniqueCitingPapersWithOccurrences: reportCountSchema,
    uniqueCitationGroups: reportCountSchema,
    attributedClaimsWithVerifiedSupportSpan: reportCountSchema,
    attributedClaimsMissingSupportSpan: reportCountSchema,
    deferredByFamilyCap: reportCountSchema,
    deferredByRecordBudget: reportCountSchema,
    deferredByNovelty: reportCountSchema,
  })
  .strict();
const scopeFunnelCountsSchema = z
  .object({
    scopedCandidates: reportCountSchema,
    deferredCandidates: reportCountSchema,
    families: reportCountSchema,
    groundingStatusCounts: z.array(reportStatusCountSchema),
  })
  .strict();
const prepareFunnelCountsSchema = z
  .object({
    expectedFamilyOccurrencePairs: reportCountSchema,
    preparedRecords: reportCountSchema,
    classified: reportCountSchema,
    ambiguous: reportCountSchema,
    failed: reportCountSchema,
    lowInformation: reportCountSchema,
    manualReview: reportCountSchema,
    manualReviewRoleAmbiguous: reportCountSchema,
    manualReviewExtractionLimited: reportCountSchema,
  })
  .strict();
const evidenceFunnelCountsSchema = z
  .object({
    recordOutcomes: reportCountSchema,
    retrievalStatusCounts: z.array(reportEvidenceRetrievalStatusCountSchema),
    bm25MatchedRuns: reportCountSchema,
    bm25NoMatchRuns: reportCountSchema,
    rerankDisabled: reportCountSchema,
    rerankCompleted: reportCountSchema,
    rerankFailed: reportCountSchema,
    rerankNotAttempted: reportCountSchema,
    uniqueFinalSelectionsBm25: reportCountSchema,
    uniqueFinalSelectionsReranked: reportCountSchema,
    recordSelectionBm25: reportCountSchema,
    recordSelectionReranked: reportCountSchema,
  })
  .strict();
const adjudicateFunnelCountsSchema = z
  .object({
    totalRecordOutcomes: reportCountSchema,
    adjudicated: reportCountSchema,
    notAdjudicated: reportCountSchema,
    adjudicationFailed: reportCountSchema,
    invalidOutput: reportCountSchema,
    gateCodeCounts: z.array(reportAdjudicateGateCountSchema),
    failureCodeCounts: z.array(reportAdjudicateFailureCountSchema),
    verdictCounts: z
      .object({
        F: reportCountSchema,
        D: reportCountSchema,
        E: reportCountSchema,
        U: reportCountSchema,
      })
      .strict(),
    /** Drift direction over D verdicts: which dimension moved, and which way. */
    mutationKindCounts: z.array(reportMutationKindCountSchema),
    mutationDirectionCounts: z.array(reportMutationDirectionCountSchema),
    /**
     * Verdicts split by evidence regime, so scope-pinned and unpinned records
     * can be compared instead of pooled.
     */
    verdictCountsByRankingSource: z.array(reportVerdictsByRankingSourceSchema),
    uniqueClaimUnits: reportCountSchema,
    uniqueAdjudicatedClaimUnits: reportCountSchema,
    /**
     * Unique family × citing-paper × claim units that received each verdict.
     * A unit is counted under every distinct verdict its records received,
     * so repeated citations of one claim do not inflate a verdict.
     */
    uniqueClaimUnitVerdictCounts: z
      .object({
        F: reportCountSchema,
        D: reportCountSchema,
        E: reportCountSchema,
        U: reportCountSchema,
      })
      .strict(),
    repeatedRecordsBeyondUniqueUnits: reportCountSchema,
    packetsWithVerifiedSupportSpans: reportCountSchema,
    packetsMissingSupportSpans: reportCountSchema,
    evidenceSufficient: reportCountSchema,
    evidenceLimited: reportCountSchema,
    figureOnlyLimitation: reportCountSchema,
  })
  .strict();
const reportFunnelCountsSchema = z
  .object({
    discover: discoverFunnelCountsSchema,
    scope: scopeFunnelCountsSchema,
    prepare: prepareFunnelCountsSchema,
    evidence: evidenceFunnelCountsSchema,
    adjudicate: adjudicateFunnelCountsSchema,
  })
  .strict();
export type ReportFunnelCounts = z.infer<typeof reportFunnelCountsSchema>;

const reportEvidenceTraceSchema = z
  .object({
    retrievalStatus: evidenceRetrievalStatusSchema,
    rerankStatus: evidenceRerankStatusSchema,
    rankingSource: z
      .enum([
        "bm25",
        "reranked",
        "bm25_with_scope_pins",
        "reranked_with_scope_pins",
      ])
      .optional(),
    queryId: stableIdentifierSchema,
    bm25RunId: stableIdentifierSchema.optional(),
    rerankRunId: stableIdentifierSchema.optional(),
    finalSelectionId: stableIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((trace, context) => {
    if ((trace.finalSelectionId == null) !== (trace.rankingSource == null)) {
      context.addIssue({
        code: "custom",
        path: ["rankingSource"],
        message:
          "Evidence trace rankingSource and finalSelectionId must either both exist or both be absent",
      });
    }
    if (
      (trace.retrievalStatus === "retrieved") !==
      (trace.finalSelectionId != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalSelectionId"],
        message:
          "Only retrieved Evidence traces may carry a final selection, and every retrieved trace must carry one",
      });
    }
    if (
      (trace.rerankStatus === "completed" ||
        trace.rerankStatus === "failed") !==
      (trace.rerankRunId != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rerankRunId"],
        message:
          "Completed/failed reranking requires rerankRunId; disabled/not-attempted reranking forbids it",
      });
    }

    if (trace.retrievalStatus === "retrieved") {
      if (trace.bm25RunId == null) {
        context.addIssue({
          code: "custom",
          path: ["bm25RunId"],
          message: "Retrieved Evidence traces require a BM25 run",
        });
      }
      if (
        trace.rerankStatus === "completed" &&
        trace.rankingSource !== "reranked" &&
        trace.rankingSource !== "reranked_with_scope_pins"
      ) {
        context.addIssue({
          code: "custom",
          path: ["rankingSource"],
          message:
            "Completed reranking requires reranked as the final ranking source",
        });
      }
      if (
        (trace.rerankStatus === "disabled" ||
          trace.rerankStatus === "failed") &&
        trace.rankingSource !== "bm25" &&
        trace.rankingSource !== "bm25_with_scope_pins"
      ) {
        context.addIssue({
          code: "custom",
          path: ["rankingSource"],
          message:
            "BM25 (optionally with Scope pins) must be the final ranking source when reranking is disabled or failed",
        });
      }
      if (
        trace.rerankStatus !== "disabled" &&
        trace.rerankStatus !== "completed" &&
        trace.rerankStatus !== "failed"
      ) {
        context.addIssue({
          code: "custom",
          path: ["rerankStatus"],
          message:
            "Retrieved Evidence traces allow only disabled, completed, or failed rerank status",
        });
      }
      return;
    }

    if (trace.retrievalStatus === "no_lexical_matches") {
      if (trace.bm25RunId == null) {
        context.addIssue({
          code: "custom",
          path: ["bm25RunId"],
          message: "No-lexical-match Evidence traces require a BM25 run",
        });
      }
      if (
        trace.rerankRunId != null ||
        trace.finalSelectionId != null ||
        trace.rankingSource != null
      ) {
        context.addIssue({
          code: "custom",
          path: ["finalSelectionId"],
          message:
            "No-lexical-match Evidence traces cannot claim reranking or a final selection",
        });
      }
      if (
        trace.rerankStatus !== "disabled" &&
        trace.rerankStatus !== "not_attempted_no_candidates"
      ) {
        context.addIssue({
          code: "custom",
          path: ["rerankStatus"],
          message:
            "No-lexical-match Evidence traces require disabled or not_attempted_no_candidates reranking",
        });
      }
      return;
    }

    if (
      trace.bm25RunId != null ||
      trace.rerankRunId != null ||
      trace.finalSelectionId != null ||
      trace.rankingSource != null
    ) {
      context.addIssue({
        code: "custom",
        path: ["bm25RunId"],
        message:
          "Unavailable/acquisition/retrieval-failure Evidence traces cannot claim ranking runs or final selections",
      });
    }
    const expectedNotAttempted =
      trace.retrievalStatus === "retrieval_failed"
        ? "not_attempted_retrieval_failure"
        : "not_attempted_unavailable";
    if (
      trace.rerankStatus !== "disabled" &&
      trace.rerankStatus !== expectedNotAttempted
    ) {
      context.addIssue({
        code: "custom",
        path: ["rerankStatus"],
        message: `${trace.retrievalStatus} Evidence traces require disabled or ${expectedNotAttempted} reranking`,
      });
    }
  });

const reportAdjudicationTraceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("adjudicated"),
      adjudicationResultId: stableIdentifierSchema,
      verdict: fidelityTopLabelSchema,
      mutationKinds: z.array(mutationKindSchema),
      direction: mutationDirectionSchema,
      evidenceSufficiency: z.enum(["sufficient", "limited"]),
      evidenceLimitation: z.enum(["figure_only_support"]).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("not_adjudicated"),
      adjudicationResultId: stableIdentifierSchema,
      gateCode: adjudicateGateCodeSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("adjudication_failed"),
      adjudicationResultId: stableIdentifierSchema,
      failureCode: adjudicateNonfatalFailureCodeSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("invalid_output"),
      adjudicationResultId: stableIdentifierSchema,
    })
    .strict(),
]);

export const reportRecordTraceSchema = z
  .object({
    recordId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    prepareArtifact: reportPrepareArtifactReferenceSchema,
    evidenceArtifact: reportEvidenceArtifactReferenceSchema,
    adjudicateArtifact: reportAdjudicateArtifactReferenceSchema,
    evidence: reportEvidenceTraceSchema,
    adjudication: reportAdjudicationTraceSchema,
  })
  .strict();
export type ReportRecordTrace = z.infer<typeof reportRecordTraceSchema>;

const reportDecisionSummarySchema = z
  .object({
    stage: canonicalStageKeySchema,
    decisionType: z.string().min(1),
    outcome: z.string().min(1),
    count: z.number().int().nonnegative(),
    unit: z.literal("decisions"),
  })
  .strict();
export type ReportDecisionSummary = z.infer<typeof reportDecisionSummarySchema>;

const reportExclusionSummarySchema = z
  .object({
    stage: canonicalStageKeySchema,
    reasonCode: z.string().min(1),
    count: z.number().int().nonnegative(),
    unit: z.literal("exclusions"),
  })
  .strict();
export type ReportExclusionSummary = z.infer<
  typeof reportExclusionSummarySchema
>;

export const REQUIRED_REPORT_RATE_METRIC_IDS = [
  "scope_selection_rate",
  "retrieval_coverage",
  "adjudication_coverage",
  "verdict_F_rate",
  "verdict_D_rate",
  "verdict_E_rate",
  "verdict_U_rate",
  "verdict_F_unique_rate",
  "verdict_D_unique_rate",
  "verdict_E_unique_rate",
  "verdict_U_unique_rate",
] as const;

const reportFamilyRecordStatusSchema = z.enum([
  "adjudicated",
  "not_adjudicated",
  "adjudication_failed",
  "invalid_output",
]);

/**
 * One citing paper's restatement of a family claim. This is the scientific
 * unit of the report: what the citer said, in publication order, and how the
 * adjudicator judged it against the seed.
 */
const reportFamilyMutationRecordSchema = z
  .object({
    recordId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    citingPaperId: z.string().min(1),
    citingPaperTitle: z.string().min(1),
    citingPaperDoi: z.string().min(1).optional(),
    citingPaperYear: z.number().int().optional(),
    sectionTitle: z.string().min(1).optional(),
    /** The occurrence-local attributed claim text(s), newline-joined. */
    citingRestatement: z.string().min(1),
    /** Exact-verified citing-side spans the claims were extracted from. */
    supportSpanTexts: z.array(z.string().min(1)),
    status: reportFamilyRecordStatusSchema,
    verdict: fidelityTopLabelSchema.optional(),
    mutationKinds: z.array(mutationKindSchema).optional(),
    direction: mutationDirectionSchema.optional(),
    citingAssertion: z.string().min(1).optional(),
    sourceStatement: z.string().min(1).optional(),
    gateCode: adjudicateGateCodeSchema.optional(),
    evidenceSufficiency: z.enum(["sufficient", "limited"]).optional(),
    rankingSource: z
      .enum([
        "bm25",
        "reranked",
        "bm25_with_scope_pins",
        "reranked_with_scope_pins",
      ])
      .optional(),
  })
  .strict();
export type ReportFamilyMutationRecord = z.infer<
  typeof reportFamilyMutationRecordSchema
>;

const reportFamilyGroundingSpanSchema = z
  .object({
    blockId: z.string().min(1),
    sectionTitle: z.string().min(1).optional(),
    text: z.string().min(1),
  })
  .strict();

/**
 * A seed finding and every citing restatement of it, chronologically. The
 * canonical, hashable form of what the UI Families tab displays.
 */
export const reportFamilyMutationSchema = z
  .object({
    familyId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    seedDoi: z.string().min(1),
    seedTitle: z.string().min(1).optional(),
    trackedClaim: z.string().min(1),
    /** How the family's member claims were judged equivalent in Discover. */
    equivalenceMethod: z.enum(["model", "exact_normalized_text"]).optional(),
    groundingStatus: z.string().min(1),
    verifiedSeedGroundingSpans: z.array(reportFamilyGroundingSpanSchema),
    verdictCounts: z
      .object({
        F: z.number().int().nonnegative(),
        D: z.number().int().nonnegative(),
        E: z.number().int().nonnegative(),
        U: z.number().int().nonnegative(),
        not_adjudicated: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
    uniqueClaimUnits: z.number().int().nonnegative(),
    /** Chronological: citing year, then title, then recordId. */
    records: z.array(reportFamilyMutationRecordSchema).min(1),
  })
  .strict();
export type ReportFamilyMutation = z.infer<typeof reportFamilyMutationSchema>;

export const reportArtifactPayloadSchema = z
  .object({
    lineage: reportLineageSchema,
    method: canonicalReportMethodSchema,
    interpretationStatus: reportInterpretationStatusSchema,
    interpretationWarning: z.literal(REPORT_INTERPRETATION_WARNING),
    deterministic: z.literal(true),
    replayableFromInputs: z.literal(true),
    funnel: reportFunnelCountsSchema,
    rates: z.array(reportRateSchema),
    /** The scientific content: each family and its restatements in order. */
    familyMutations: z.array(reportFamilyMutationSchema),
    recordTraces: z.array(reportRecordTraceSchema),
    decisionSummaries: z.array(reportDecisionSummarySchema),
    exclusionSummaries: z.array(reportExclusionSummarySchema),
  })
  .strict()
  .superRefine(validateReportPayload);
export type ReportArtifactPayload = z.infer<typeof reportArtifactPayloadSchema>;

function validateReportPayload(
  payload: z.infer<typeof reportArtifactPayloadSchema>,
  context: z.RefinementCtx,
): void {
  if (payload.method.methodId !== canonicalReportMethodId) {
    context.addIssue({
      code: "custom",
      path: ["method", "methodId"],
      message:
        "Canonical Report method ID is not the current audit report method",
    });
  }
  if (payload.method.calibrationStatus !== "uncalibrated") {
    context.addIssue({
      code: "custom",
      path: ["method", "calibrationStatus"],
      message:
        "Canonical Report remains uncalibrated until blinded human labels exist",
    });
  }
  if (payload.interpretationStatus !== "uncalibrated_research_output") {
    context.addIssue({
      code: "custom",
      path: ["interpretationStatus"],
      message: "Canonical Report must declare uncalibrated_research_output",
    });
  }

  const forbiddenRateIds = new Set([
    "accuracy",
    "agreement",
    "benchmark",
    "calibration",
    "headline_score",
    "quality_score",
    "faithfulness_rate",
    "partial_fidelity_rate",
    "human_vs_model",
    "evaluation_statistics",
  ]);

  const rateIds = payload.rates.map((rate) => rate.metricId);
  addDuplicateIdentifierIssue(rateIds, ["rates"], context);
  for (const metricId of rateIds) {
    if (forbiddenRateIds.has(metricId)) {
      context.addIssue({
        code: "custom",
        path: ["rates"],
        message: `Canonical Report forbids evaluation/headline rate metric: ${metricId}`,
      });
    }
  }
  for (const requiredId of REQUIRED_REPORT_RATE_METRIC_IDS) {
    if (!rateIds.includes(requiredId)) {
      context.addIssue({
        code: "custom",
        path: ["rates"],
        message: `Missing required rate metric: ${requiredId}`,
      });
    }
  }

  const sortedRateIds = [...rateIds].sort(compareCodeUnits);
  if (canonicalSerialize(rateIds) !== canonicalSerialize(sortedRateIds)) {
    context.addIssue({
      code: "custom",
      path: ["rates"],
      message: "Report rates must be ordered by stable metricId",
    });
  }

  const recordIds = payload.recordTraces.map((trace) => trace.recordId);
  addDuplicateIdentifierIssue(recordIds, ["recordTraces"], context);
  const sortedRecordIds = [...recordIds].sort(compareCodeUnits);
  if (canonicalSerialize(recordIds) !== canonicalSerialize(sortedRecordIds)) {
    context.addIssue({
      code: "custom",
      path: ["recordTraces"],
      message: "Report record traces must be ordered by stable recordId",
    });
  }

  validateOrderedUniqueStatusCounts(
    payload.funnel.scope.groundingStatusCounts,
    ["funnel", "scope", "groundingStatusCounts"],
    context,
  );
  validateOrderedUniqueStatusCounts(
    payload.funnel.evidence.retrievalStatusCounts,
    ["funnel", "evidence", "retrievalStatusCounts"],
    context,
  );
  validateOrderedUniqueStatusCounts(
    payload.funnel.adjudicate.gateCodeCounts,
    ["funnel", "adjudicate", "gateCodeCounts"],
    context,
  );
  validateOrderedUniqueStatusCounts(
    payload.funnel.adjudicate.failureCodeCounts,
    ["funnel", "adjudicate", "failureCodeCounts"],
    context,
  );

  const prepareCount = payload.funnel.prepare.preparedRecords.count;
  const evidenceCount = payload.funnel.evidence.recordOutcomes.count;
  const adjudicateCount = payload.funnel.adjudicate.totalRecordOutcomes.count;
  if (
    prepareCount !== evidenceCount ||
    prepareCount !== adjudicateCount ||
    prepareCount !== payload.recordTraces.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["recordTraces"],
      message:
        "Report must emit exactly one per-record trace for every Prepare/Evidence/Adjudicate record",
    });
  }

  const adjudicationCoverage = payload.rates.find(
    (rate) => rate.metricId === "adjudication_coverage",
  );
  if (
    adjudicationCoverage != null &&
    (adjudicationCoverage.numerator !==
      payload.funnel.adjudicate.adjudicated.count ||
      adjudicationCoverage.denominator !== adjudicateCount)
  ) {
    context.addIssue({
      code: "custom",
      path: ["rates"],
      message:
        "adjudication_coverage must use adjudicated records over all canonical Prepare/Evidence/Adjudicate records",
    });
  }

  const adjudicated = payload.funnel.adjudicate.adjudicated.count;
  for (const verdict of ["F", "D", "E", "U"] as const) {
    const rate = payload.rates.find(
      (entry) => entry.metricId === `verdict_${verdict}_rate`,
    );
    if (rate == null) continue;
    if (rate.denominator !== adjudicated) {
      context.addIssue({
        code: "custom",
        path: ["rates"],
        message: `verdict_${verdict}_rate denominator must be adjudicated records only`,
      });
    }
    const count = payload.funnel.adjudicate.verdictCounts[verdict].count;
    if (rate.numerator !== count) {
      context.addIssue({
        code: "custom",
        path: ["rates"],
        message: `verdict_${verdict}_rate numerator must match adjudicated ${verdict} count`,
      });
    }
  }

  const uniqueAdjudicated =
    payload.funnel.adjudicate.uniqueAdjudicatedClaimUnits.count;
  for (const verdict of ["F", "D", "E", "U"] as const) {
    const rate = payload.rates.find(
      (entry) => entry.metricId === `verdict_${verdict}_unique_rate`,
    );
    if (rate == null) continue;
    if (rate.denominator !== uniqueAdjudicated) {
      context.addIssue({
        code: "custom",
        path: ["rates"],
        message: `verdict_${verdict}_unique_rate denominator must be unique adjudicated claim units`,
      });
    }
    const count =
      payload.funnel.adjudicate.uniqueClaimUnitVerdictCounts[verdict].count;
    if (rate.numerator !== count) {
      context.addIssue({
        code: "custom",
        path: ["rates"],
        message: `verdict_${verdict}_unique_rate numerator must match the unique-unit ${verdict} count`,
      });
    }
  }

  const traceById = new Map(
    payload.recordTraces.map((trace) => [trace.recordId, trace]),
  );
  const familyRecordIds = new Set<string>();
  for (const [familyIndex, family] of payload.familyMutations.entries()) {
    for (const [recordIndex, record] of family.records.entries()) {
      const path = ["familyMutations", familyIndex, "records", recordIndex];
      if (familyRecordIds.has(record.recordId)) {
        context.addIssue({
          code: "custom",
          path,
          message: "Family mutation records must not repeat across families",
        });
      }
      familyRecordIds.add(record.recordId);
      const trace = traceById.get(record.recordId);
      if (!trace) {
        context.addIssue({
          code: "custom",
          path,
          message: "Family mutation record has no per-record trace",
        });
        continue;
      }
      if (trace.familyId !== family.familyId) {
        context.addIssue({
          code: "custom",
          path,
          message: "Family mutation record belongs to a different family",
        });
      }
      if (trace.adjudication.status !== record.status) {
        context.addIssue({
          code: "custom",
          path: [...path, "status"],
          message: "Family mutation record status must match its trace",
        });
      }
      if (
        trace.adjudication.status === "adjudicated" &&
        trace.adjudication.verdict !== record.verdict
      ) {
        context.addIssue({
          code: "custom",
          path: [...path, "verdict"],
          message: "Family mutation record verdict must match its trace",
        });
      }
    }
  }
  if (familyRecordIds.size !== payload.recordTraces.length) {
    context.addIssue({
      code: "custom",
      path: ["familyMutations"],
      message:
        "Family mutations must cover every per-record trace exactly once",
    });
  }

  const retrievalCoverage = payload.rates.find(
    (rate) => rate.metricId === "retrieval_coverage",
  );
  const retrievedCount = statusCount(
    payload.funnel.evidence.retrievalStatusCounts,
    "retrieved",
  );
  if (
    retrievalCoverage != null &&
    (retrievalCoverage.numerator !== retrievedCount ||
      retrievalCoverage.denominator !== prepareCount)
  ) {
    context.addIssue({
      code: "custom",
      path: ["rates"],
      message:
        "retrieval_coverage must use retrieved Evidence records over all Prepare records",
    });
  }

  const scopeSelection = payload.rates.find(
    (rate) => rate.metricId === "scope_selection_rate",
  );
  const discoverCandidates =
    payload.funnel.discover.selectedCandidates.count +
    payload.funnel.discover.deferredCandidates.count;
  if (
    scopeSelection != null &&
    (scopeSelection.numerator !==
      payload.funnel.discover.selectedCandidates.count ||
      scopeSelection.denominator !== discoverCandidates)
  ) {
    context.addIssue({
      code: "custom",
      path: ["rates"],
      message:
        "scope_selection_rate must use selected Discover candidates over all Discover candidates",
    });
  }

  validateFunnelPartitions(payload, context);
  validateTraceAccounting(payload, context);

  const statusSum =
    payload.funnel.adjudicate.adjudicated.count +
    payload.funnel.adjudicate.notAdjudicated.count +
    payload.funnel.adjudicate.adjudicationFailed.count +
    payload.funnel.adjudicate.invalidOutput.count;
  if (statusSum !== adjudicateCount) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate"],
      message: "Adjudicate status counts must sum to total record outcomes",
    });
  }

  const verdictSum =
    payload.funnel.adjudicate.verdictCounts.F.count +
    payload.funnel.adjudicate.verdictCounts.D.count +
    payload.funnel.adjudicate.verdictCounts.E.count +
    payload.funnel.adjudicate.verdictCounts.U.count;
  if (verdictSum !== adjudicated) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate", "verdictCounts"],
      message:
        "F/D/E/U counts must sum to adjudicated records only; operational failures never enter verdict counts",
    });
  }
}

function validateFunnelPartitions(
  payload: ReportArtifactPayload,
  context: z.RefinementCtx,
): void {
  const { discover, scope, prepare, evidence } = payload.funnel;
  for (const [field, entry] of Object.entries({
    returnedCitingPaperObservations: discover.returnedCitingPaperObservations,
    probed: discover.probed,
    notProbed: discover.notProbed,
    materializationSucceeded: discover.materializationSucceeded,
    materializationFailed: discover.materializationFailed,
    materializationUnavailable: discover.materializationUnavailable,
    materializationNotAttempted: discover.materializationNotAttempted,
    harvestSucceeded: discover.harvestSucceeded,
    harvestNoMentions: discover.harvestNoMentions,
    harvestFailed: discover.harvestFailed,
    harvestNotAttempted: discover.harvestNotAttempted,
  })) {
    if (entry.unit !== "citing_paper_observations") {
      context.addIssue({
        code: "custom",
        path: ["funnel", "discover", field, "unit"],
        message:
          "Discover citing-paper records are seed-specific citing-paper observations, not globally unique papers",
      });
    }
  }
  for (const [field, entry] of Object.entries({
    uniqueFinalSelectionsBm25: evidence.uniqueFinalSelectionsBm25,
    uniqueFinalSelectionsReranked: evidence.uniqueFinalSelectionsReranked,
  })) {
    if (entry.unit !== "selections") {
      context.addIssue({
        code: "custom",
        path: ["funnel", "evidence", field, "unit"],
        message: "Unique final-selection counts must use selections",
      });
    }
  }
  for (const [field, entry] of Object.entries({
    recordSelectionBm25: evidence.recordSelectionBm25,
    recordSelectionReranked: evidence.recordSelectionReranked,
  })) {
    if (entry.unit !== "family_occurrence_records") {
      context.addIssue({
        code: "custom",
        path: ["funnel", "evidence", field, "unit"],
        message:
          "Per-record final-selection use must use family×occurrence records",
      });
    }
  }
  const returned = discover.returnedCitingPaperObservations.count;
  assertCountEqual(
    discover.probed.count + discover.notProbed.count,
    returned,
    ["funnel", "discover"],
    "Discover probed + notProbed must equal returned citing-paper observations",
    context,
  );
  assertCountEqual(
    discover.materializationSucceeded.count +
      discover.materializationFailed.count +
      discover.materializationUnavailable.count +
      discover.materializationNotAttempted.count,
    returned,
    ["funnel", "discover"],
    "Discover materialization statuses must partition returned citing-paper observations",
    context,
  );
  assertCountEqual(
    discover.harvestSucceeded.count +
      discover.harvestNoMentions.count +
      discover.harvestFailed.count +
      discover.harvestNotAttempted.count,
    returned,
    ["funnel", "discover"],
    "Discover harvest statuses must partition returned citing-paper observations",
    context,
  );
  assertCountEqual(
    discover.extractionClaimsExtracted.count +
      discover.extractionNoClaims.count +
      discover.extractionFailed.count,
    discover.citationOccurrences.count,
    ["funnel", "discover"],
    "Discover extraction statuses must partition citation occurrences",
    context,
  );
  assertCountEqual(
    discover.selectedCandidates.count + discover.deferredCandidates.count,
    discover.candidateClaims.count,
    ["funnel", "discover"],
    "Discover selected + deferred candidates must equal candidate claims",
    context,
  );
  assertCountEqual(
    discover.attributedClaimsWithVerifiedSupportSpan.count +
      discover.attributedClaimsMissingSupportSpan.count,
    discover.attributedClaimRecords.count,
    ["funnel", "discover"],
    "Discover verified + missing support-span claims must equal attributed claim records",
    context,
  );

  assertCountEqual(
    scope.scopedCandidates.count + scope.deferredCandidates.count,
    discover.candidateClaims.count,
    ["funnel", "scope"],
    "Scope scoped + deferred candidates must equal all Discover candidates",
    context,
  );
  assertCountEqual(
    scope.scopedCandidates.count,
    discover.selectedCandidates.count,
    ["funnel", "scope", "scopedCandidates"],
    "Scope scoped candidates must equal Discover selected candidates",
    context,
  );
  assertCountEqual(
    scope.deferredCandidates.count,
    discover.deferredCandidates.count,
    ["funnel", "scope", "deferredCandidates"],
    "Scope deferred candidates must equal Discover deferred candidates",
    context,
  );
  assertCountEqual(
    sumStatusCounts(scope.groundingStatusCounts),
    scope.families.count,
    ["funnel", "scope", "groundingStatusCounts"],
    "Scope grounding-status counts must partition scoped families",
    context,
  );

  assertCountEqual(
    prepare.expectedFamilyOccurrencePairs.count,
    prepare.preparedRecords.count,
    ["funnel", "prepare"],
    "Expected Prepare family×occurrence pairs must equal prepared records",
    context,
  );
  assertCountEqual(
    prepare.classified.count + prepare.ambiguous.count + prepare.failed.count,
    prepare.preparedRecords.count,
    ["funnel", "prepare"],
    "Prepare classification statuses must partition prepared records",
    context,
  );

  assertCountEqual(
    sumStatusCounts(evidence.retrievalStatusCounts),
    evidence.recordOutcomes.count,
    ["funnel", "evidence", "retrievalStatusCounts"],
    "Evidence retrieval statuses must partition Evidence record outcomes",
    context,
  );
  assertCountEqual(
    evidence.rerankDisabled.count +
      evidence.rerankCompleted.count +
      evidence.rerankFailed.count +
      evidence.rerankNotAttempted.count,
    evidence.recordOutcomes.count,
    ["funnel", "evidence"],
    "Evidence rerank status populations must partition Evidence record outcomes",
    context,
  );
  assertCountEqual(
    evidence.recordSelectionBm25.count + evidence.recordSelectionReranked.count,
    statusCount(evidence.retrievalStatusCounts, "retrieved"),
    ["funnel", "evidence"],
    "Evidence per-record final-selection uses must equal retrieved records",
    context,
  );
  if (
    evidence.uniqueFinalSelectionsBm25.count >
      evidence.recordSelectionBm25.count ||
    evidence.uniqueFinalSelectionsReranked.count >
      evidence.recordSelectionReranked.count
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "evidence"],
      message:
        "Unique final-selection counts cannot exceed their per-record selection-use counts",
    });
  }

  const { adjudicate } = payload.funnel;
  assertCountEqual(
    adjudicate.packetsWithVerifiedSupportSpans.count +
      adjudicate.packetsMissingSupportSpans.count,
    adjudicate.totalRecordOutcomes.count,
    ["funnel", "adjudicate"],
    "Adjudicate support-span packet diagnostics must partition record outcomes",
    context,
  );
  assertCountEqual(
    adjudicate.evidenceSufficient.count + adjudicate.evidenceLimited.count,
    adjudicate.adjudicated.count,
    ["funnel", "adjudicate"],
    "Evidence sufficiency diagnostics must partition adjudicated records",
    context,
  );
  if (
    adjudicate.figureOnlyLimitation.count > adjudicate.evidenceLimited.count
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate", "figureOnlyLimitation"],
      message:
        "Figure-only limitation count cannot exceed evidence-limited adjudicated records",
    });
  }
  if (
    adjudicate.uniqueAdjudicatedClaimUnits.count >
    adjudicate.uniqueClaimUnits.count
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate", "uniqueAdjudicatedClaimUnits"],
      message:
        "Unique adjudicated claim units cannot exceed unique claim units",
    });
  }
}

function validateTraceAccounting(
  payload: ReportArtifactPayload,
  context: z.RefinementCtx,
): void {
  const traces = payload.recordTraces;
  const evidence = payload.funnel.evidence;
  const adjudicate = payload.funnel.adjudicate;

  const expectedRetrievalCounts = summarizeStatuses(
    traces.map((trace) => trace.evidence.retrievalStatus),
  );
  if (
    canonicalSerialize(evidence.retrievalStatusCounts) !==
    canonicalSerialize(expectedRetrievalCounts)
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "evidence", "retrievalStatusCounts"],
      message:
        "Evidence retrieval-status summary must exactly match per-record traces",
    });
  }

  const rerankDisabled = traces.filter(
    (trace) => trace.evidence.rerankStatus === "disabled",
  ).length;
  const rerankCompleted = traces.filter(
    (trace) => trace.evidence.rerankStatus === "completed",
  ).length;
  const rerankFailed = traces.filter(
    (trace) => trace.evidence.rerankStatus === "failed",
  ).length;
  const rerankNotAttempted = traces.filter((trace) =>
    trace.evidence.rerankStatus.startsWith("not_attempted_"),
  ).length;
  assertCountEqual(
    evidence.rerankDisabled.count,
    rerankDisabled,
    ["funnel", "evidence", "rerankDisabled"],
    "Rerank-disabled count must match per-record traces",
    context,
  );
  assertCountEqual(
    evidence.rerankCompleted.count,
    rerankCompleted,
    ["funnel", "evidence", "rerankCompleted"],
    "Rerank-completed count must match per-record traces",
    context,
  );
  assertCountEqual(
    evidence.rerankFailed.count,
    rerankFailed,
    ["funnel", "evidence", "rerankFailed"],
    "Rerank-failed count must match per-record traces",
    context,
  );
  assertCountEqual(
    evidence.rerankNotAttempted.count,
    rerankNotAttempted,
    ["funnel", "evidence", "rerankNotAttempted"],
    "Rerank-not-attempted count must match per-record traces",
    context,
  );

  const bm25SelectionIds = new Set<string>();
  const rerankedSelectionIds = new Set<string>();
  let recordSelectionBm25 = 0;
  let recordSelectionReranked = 0;
  for (const trace of traces) {
    const selectionId = trace.evidence.finalSelectionId;
    if (selectionId == null) continue;
    if (
      trace.evidence.rankingSource === "bm25" ||
      trace.evidence.rankingSource === "bm25_with_scope_pins"
    ) {
      bm25SelectionIds.add(selectionId);
      recordSelectionBm25 += 1;
    } else if (
      trace.evidence.rankingSource === "reranked" ||
      trace.evidence.rankingSource === "reranked_with_scope_pins"
    ) {
      rerankedSelectionIds.add(selectionId);
      recordSelectionReranked += 1;
    }
  }
  assertCountEqual(
    evidence.uniqueFinalSelectionsBm25.count,
    bm25SelectionIds.size,
    ["funnel", "evidence", "uniqueFinalSelectionsBm25"],
    "Unique BM25 final-selection count must match unique selection IDs in traces",
    context,
  );
  assertCountEqual(
    evidence.uniqueFinalSelectionsReranked.count,
    rerankedSelectionIds.size,
    ["funnel", "evidence", "uniqueFinalSelectionsReranked"],
    "Unique reranked final-selection count must match unique selection IDs in traces",
    context,
  );
  assertCountEqual(
    evidence.recordSelectionBm25.count,
    recordSelectionBm25,
    ["funnel", "evidence", "recordSelectionBm25"],
    "BM25 record-selection count must match per-record selection use",
    context,
  );
  assertCountEqual(
    evidence.recordSelectionReranked.count,
    recordSelectionReranked,
    ["funnel", "evidence", "recordSelectionReranked"],
    "Reranked record-selection count must match per-record selection use",
    context,
  );

  const adjudicationStatusCounts = summarizeStatuses(
    traces.map((trace) => trace.adjudication.status),
  );
  const statusCountFromTrace = (status: string) =>
    statusCount(adjudicationStatusCounts, status);
  assertCountEqual(
    adjudicate.adjudicated.count,
    statusCountFromTrace("adjudicated"),
    ["funnel", "adjudicate", "adjudicated"],
    "Adjudicated count must match per-record traces",
    context,
  );
  assertCountEqual(
    adjudicate.notAdjudicated.count,
    statusCountFromTrace("not_adjudicated"),
    ["funnel", "adjudicate", "notAdjudicated"],
    "Not-adjudicated count must match per-record traces",
    context,
  );
  assertCountEqual(
    adjudicate.adjudicationFailed.count,
    statusCountFromTrace("adjudication_failed"),
    ["funnel", "adjudicate", "adjudicationFailed"],
    "Adjudication-failed count must match per-record traces",
    context,
  );
  assertCountEqual(
    adjudicate.invalidOutput.count,
    statusCountFromTrace("invalid_output"),
    ["funnel", "adjudicate", "invalidOutput"],
    "Invalid-output count must match per-record traces",
    context,
  );

  const expectedGateCounts = summarizeStatuses(
    traces.flatMap((trace) =>
      trace.adjudication.status === "not_adjudicated"
        ? [trace.adjudication.gateCode]
        : [],
    ),
  );
  if (
    canonicalSerialize(adjudicate.gateCodeCounts) !==
    canonicalSerialize(expectedGateCounts)
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate", "gateCodeCounts"],
      message: "Gate-code summary must exactly match per-record traces",
    });
  }
  const expectedFailureCounts = summarizeStatuses(
    traces.flatMap((trace) =>
      trace.adjudication.status === "adjudication_failed"
        ? [trace.adjudication.failureCode]
        : [],
    ),
  );
  if (
    canonicalSerialize(adjudicate.failureCodeCounts) !==
    canonicalSerialize(expectedFailureCounts)
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate", "failureCodeCounts"],
      message: "Failure-code summary must exactly match per-record traces",
    });
  }
  const expectedMutationKindCounts = summarizeStatuses(
    traces.flatMap((trace) =>
      trace.adjudication.status === "adjudicated"
        ? trace.adjudication.mutationKinds
        : [],
    ),
  );
  if (
    canonicalSerialize(adjudicate.mutationKindCounts) !==
    canonicalSerialize(expectedMutationKindCounts)
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate", "mutationKindCounts"],
      message: "Mutation-kind summary must exactly match per-record traces",
    });
  }
  const expectedDirectionCounts = summarizeStatuses(
    traces.flatMap((trace) =>
      trace.adjudication.status === "adjudicated" &&
      trace.adjudication.verdict === "D"
        ? [trace.adjudication.direction]
        : [],
    ),
  );
  if (
    canonicalSerialize(adjudicate.mutationDirectionCounts) !==
    canonicalSerialize(expectedDirectionCounts)
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate", "mutationDirectionCounts"],
      message: "Mutation-direction summary must exactly match D traces",
    });
  }
  const expectedBySource = new Map<
    string,
    { F: number; D: number; E: number; U: number }
  >();
  for (const trace of traces) {
    if (
      trace.adjudication.status !== "adjudicated" ||
      trace.evidence.rankingSource == null
    ) {
      continue;
    }
    const bucket = expectedBySource.get(trace.evidence.rankingSource) ?? {
      F: 0,
      D: 0,
      E: 0,
      U: 0,
    };
    bucket[trace.adjudication.verdict] += 1;
    expectedBySource.set(trace.evidence.rankingSource, bucket);
  }
  const expectedRows = [...expectedBySource.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([rankingSource, counts]) => ({ rankingSource, ...counts }));
  if (
    canonicalSerialize(adjudicate.verdictCountsByRankingSource) !==
    canonicalSerialize(expectedRows)
  ) {
    context.addIssue({
      code: "custom",
      path: ["funnel", "adjudicate", "verdictCountsByRankingSource"],
      message:
        "Verdict-by-ranking-source summary must exactly match per-record traces",
    });
  }
  for (const verdict of ["F", "D", "E", "U"] as const) {
    assertCountEqual(
      adjudicate.verdictCounts[verdict].count,
      traces.filter(
        (trace) =>
          trace.adjudication.status === "adjudicated" &&
          trace.adjudication.verdict === verdict,
      ).length,
      ["funnel", "adjudicate", "verdictCounts", verdict],
      `Verdict ${verdict} count must match per-record traces`,
      context,
    );
  }
}

function validateOrderedUniqueStatusCounts(
  counts: ReadonlyArray<{ status: string; count: number }>,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  const statuses = counts.map((entry) => entry.status);
  addDuplicateIdentifierIssue(statuses, path, context);
  if (
    canonicalSerialize(statuses) !==
    canonicalSerialize([...statuses].sort(compareCodeUnits))
  ) {
    context.addIssue({
      code: "custom",
      path,
      message: "Status-count entries must be ordered by stable status value",
    });
  }
}

function summarizeStatuses(
  statuses: readonly string[],
): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([status, count]) => ({ status, count }));
}

function sumStatusCounts(counts: ReadonlyArray<{ count: number }>): number {
  return counts.reduce((sum, entry) => sum + entry.count, 0);
}

function statusCount(
  counts: ReadonlyArray<{ status: string; count: number }>,
  status: string,
): number {
  return counts.find((entry) => entry.status === status)?.count ?? 0;
}

function assertCountEqual(
  actual: number,
  expected: number,
  path: Array<string | number>,
  message: string,
  context: z.RefinementCtx,
): void {
  if (actual !== expected) {
    context.addIssue({
      code: "custom",
      path,
      message,
    });
  }
}

export function validateReportArtifactLineage(
  artifact: {
    runId: string;
    inputArtifacts: ArtifactReference[];
    decisions: Array<{
      recordId: string;
      decisionType: string;
      outcome: string;
      reason: string;
      recordedAt: string;
      actor: {
        kind: "deterministic" | "model" | "external" | "human";
        identifier: string;
      };
      evidenceArtifacts: ArtifactReference[];
      supersedesDecisionId?: string | undefined;
    }>;
    exclusions: unknown[];
    provenance: {
      models: unknown[];
      prompts: unknown[];
    };
    execution: {
      kind: string;
      replayableFromInputs?: boolean;
      responseArtifacts?: ArtifactReference[] | undefined;
    };
    payload: ReportArtifactPayload;
  },
  context: z.RefinementCtx,
): void {
  const { lineage } = artifact.payload;
  if (artifact.runId !== lineage.runId) {
    context.addIssue({
      code: "custom",
      path: ["payload", "lineage", "runId"],
      message: "Report run ID must match its verified five-artifact lineage",
    });
  }

  const expectedInputs = [
    lineage.discoverArtifact,
    lineage.scopeArtifact,
    lineage.prepareArtifact,
    lineage.evidenceArtifact,
    lineage.adjudicateArtifact,
  ];
  if (
    artifact.inputArtifacts.length !== 5 ||
    !expectedInputs.every((expected, index) =>
      sameArtifactReference(artifact.inputArtifacts[index], expected),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["inputArtifacts"],
      message:
        "Report must reference Discover, Scope, Prepare, Evidence, and Adjudicate inputs in that fixed order",
    });
  }

  validateReportDecisions(artifact, expectedInputs, context);
  if (artifact.exclusions.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["exclusions"],
      message:
        "Canonical Report performs complete accounting and cannot add report-stage exclusions",
    });
  }

  if (
    artifact.execution.kind !== "deterministic" ||
    artifact.execution.replayableFromInputs !== true
  ) {
    context.addIssue({
      code: "custom",
      path: ["execution"],
      message:
        "Canonical Report must be deterministic and replayable from inputs",
    });
  }
  if (
    artifact.provenance.prompts.length !== 0 ||
    artifact.provenance.models.length !== 0 ||
    (artifact.execution.responseArtifacts?.length ?? 0) !== 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["provenance"],
      message:
        "Canonical Report forbids prompt, model, and response execution provenance",
    });
  }

  if (artifact.payload.deterministic !== true) {
    context.addIssue({
      code: "custom",
      path: ["payload", "deterministic"],
      message: "Canonical Report payload must declare deterministic: true",
    });
  }
  if (artifact.payload.replayableFromInputs !== true) {
    context.addIssue({
      code: "custom",
      path: ["payload", "replayableFromInputs"],
      message:
        "Canonical Report payload must declare replayableFromInputs: true",
    });
  }

  for (const [index, trace] of artifact.payload.recordTraces.entries()) {
    if (
      !sameArtifactReference(trace.prepareArtifact, lineage.prepareArtifact) ||
      !sameArtifactReference(
        trace.evidenceArtifact,
        lineage.evidenceArtifact,
      ) ||
      !sameArtifactReference(
        trace.adjudicateArtifact,
        lineage.adjudicateArtifact,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "recordTraces", index],
        message:
          "Per-record trace upstream artifact references must match Report lineage exactly",
      });
    }
  }
}

function validateReportDecisions(
  artifact: {
    runId: string;
    decisions: Array<{
      recordId: string;
      decisionType: string;
      outcome: string;
      reason: string;
      recordedAt: string;
      actor: {
        kind: "deterministic" | "model" | "external" | "human";
        identifier: string;
      };
      evidenceArtifacts: ArtifactReference[];
      supersedesDecisionId?: string | undefined;
    }>;
  },
  expectedInputs: ArtifactReference[],
  context: z.RefinementCtx,
): void {
  const expected = [
    {
      decisionType: "report_interpretation_status",
      outcome: "uncalibrated_research_output",
      reason: REPORT_INTERPRETATION_WARNING,
    },
    {
      decisionType: "report_publication_status",
      outcome: "research_artifact_only",
      reason: REPORT_PUBLICATION_REASON,
    },
  ] as const;
  if (artifact.decisions.length !== expected.length) {
    context.addIssue({
      code: "custom",
      path: ["decisions"],
      message:
        "Canonical Report must contain exactly interpretation-status and publication-status decisions",
    });
  }

  const expectedRecordId = buildReportDecisionRecordId(artifact.runId);
  for (const [index, expectedDecision] of expected.entries()) {
    const decision = artifact.decisions[index];
    if (decision == null) continue;
    if (
      decision.decisionType !== expectedDecision.decisionType ||
      decision.outcome !== expectedDecision.outcome ||
      decision.reason !== expectedDecision.reason ||
      decision.recordId !== expectedRecordId ||
      decision.actor.kind !== "deterministic" ||
      decision.actor.identifier !== canonicalReportMethodId ||
      decision.supersedesDecisionId != null ||
      decision.evidenceArtifacts.length !== expectedInputs.length ||
      !expectedInputs.every((reference, referenceIndex) =>
        sameArtifactReference(
          decision.evidenceArtifacts[referenceIndex],
          reference,
        ),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["decisions", index],
        message: `Canonical Report decision does not match exact ${expectedDecision.decisionType} contract`,
      });
    }
  }
  const firstRecordedAt = artifact.decisions[0]?.recordedAt;
  if (
    firstRecordedAt != null &&
    artifact.decisions.some(
      (decision) => decision.recordedAt !== firstRecordedAt,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["decisions"],
      message: "Canonical Report decisions must share one recording timestamp",
    });
  }
}

export function buildReportRate(input: {
  metricId: string;
  numerator: number;
  denominator: number;
  unit: string;
  populationLabel: string;
  numeratorDefinition: string;
  denominatorDefinition: string;
}): ReportRate {
  const value =
    input.denominator === 0 ? null : input.numerator / input.denominator;
  return reportRateSchema.parse({
    ...input,
    value,
  });
}

export function buildReportCount(input: {
  metricId: string;
  count: number;
  unit: ReportCountUnit;
  population: string;
}): ReportCount {
  return reportCountSchema.parse(input);
}

function addDuplicateIdentifierIssue(
  values: readonly string[],
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path,
        message: `Duplicate identifier: ${value}`,
      });
      return;
    }
    seen.add(value);
  }
}

function sameArtifactReference(
  left:
    | {
        artifactId: string;
        contentHash: string;
        role: string;
        canonicalStage?: string | undefined;
        uri?: string | undefined;
      }
    | undefined,
  right: {
    artifactId: string;
    contentHash: string;
    role: string;
    canonicalStage?: string | undefined;
    uri?: string | undefined;
  },
): boolean {
  return (
    left != null &&
    left.artifactId === right.artifactId &&
    left.contentHash === right.contentHash &&
    left.role === right.role &&
    left.canonicalStage === right.canonicalStage &&
    left.uri === right.uri
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
