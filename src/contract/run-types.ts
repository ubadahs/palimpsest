import { z } from "zod";

import { undefinedable } from "../domain/common.js";
import {
  claudeModelValues,
  type ClaudeModel,
} from "../shared/anthropic-token-cost.js";
import {
  candidateSelectionPolicySchema,
  defaultAdaptivePortfolioPolicy,
} from "./adaptive-portfolio-policy.js";

export {
  candidateSelectionModeValues,
  defaultAllCandidatesPolicy,
  type CandidateSelectionMode,
  type CandidateSelectionPolicy,
} from "./adaptive-portfolio-policy.js";
import type { StageInspectorPayload } from "./inspector-payloads.js";
import { stageKeySchema, type StageKey } from "./lean-stages.js";
import { thinkingEffortSchema } from "./model-execution.js";
import { stageWorkflowSnapshotSchema } from "./workflow.js";

export const analysisRunStatusValues = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export const analysisRunStatusSchema = z.enum(analysisRunStatusValues);
export type AnalysisRunStatus = z.infer<typeof analysisRunStatusSchema>;

export const analysisRunStageStatusValues = [
  "not_started",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "stale",
  "blocked",
  "interrupted",
] as const;
export const analysisRunStageStatusSchema = z.enum(
  analysisRunStageStatusValues,
);
export type AnalysisRunStageStatus = z.infer<
  typeof analysisRunStageStatusSchema
>;

const claudeModelSchema = z.enum(claudeModelValues);

/**
 * Single source of truth for canonical run-config defaults.
 * Schema field defaults, UI form defaults, and CLI empty-config parse all
 * consume this object (directly or via analysisRunConfigSchema.parse({})).
 */
export const CANONICAL_RUN_CONFIG_DEFAULTS = {
  stopAfterStage: "report" as const satisfies StageKey,
  forceRefresh: false,
  modelConcurrency: 6,
  discover: {
    neighborhoodProvider: "openalex",
    neighborhoodQuery: "works-citing-seed",
    neighborhoodLimit: 10_000,
    probeBudget: 100,
    fetchConcurrency: 6,
    candidateSelection: defaultAdaptivePortfolioPolicy,
    extractionModel: "claude-haiku-5-5" as ClaudeModel,
    extractionThinking: false,
    canonicalizationModel: "claude-sonnet-5-5" as ClaudeModel,
    canonicalizationThinking: false,
  },
  scope: {
    groundingModel: "claude-sonnet-5-5" as ClaudeModel,
    groundingThinking: true,
    codebookModel: "claude-sonnet-5-5" as ClaudeModel,
    taggingModel: "claude-haiku-5-5" as ClaudeModel,
  },
  prepare: {
    classifier: "deterministic" as const,
    roleClassifierModel: "claude-haiku-5-5" as ClaudeModel,
  },
  evidence: {
    rerankEnabled: true,
    rerankModel: "claude-haiku-5-5" as ClaudeModel,
    rerankTopN: 5,
    bm25CandidateLimit: 20,
    selectionLimit: 5,
  },
  adjudicate: {
    model: "claude-sonnet-5-5" as ClaudeModel,
    thinking: true,
    effort: "high" as const,
    evidence: "seed_text" as const,
  },
};

/**
 * What the adjudicator reads of the seed paper: its whole text, or only the
 * chunks Evidence selected.
 */
export const adjudicationEvidenceSchema = z.enum([
  "seed_text",
  "selected_chunks",
]);
export type AdjudicationEvidence = z.infer<typeof adjudicationEvidenceSchema>;

/**
 * Run config, grouped by stage. Unknown fields are rejected.
 */
export const analysisRunConfigSchema = z
  .object({
    stopAfterStage: stageKeySchema.default(
      CANONICAL_RUN_CONFIG_DEFAULTS.stopAfterStage,
    ),
    forceRefresh: z
      .boolean()
      .default(CANONICAL_RUN_CONFIG_DEFAULTS.forceRefresh),
    /**
     * Model requests in flight at once within a stage. Changes wall time
     * only: results are appended in input order, so artifacts hash the same
     * at any value. Kept modest to stay under provider rate limits.
     */
    modelConcurrency: z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(CANONICAL_RUN_CONFIG_DEFAULTS.modelConcurrency),

    discover: z
      .object({
        neighborhoodProvider: z
          .string()
          .min(1)
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.discover.neighborhoodProvider),
        neighborhoodQuery: z
          .string()
          .min(1)
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.discover.neighborhoodQuery),
        neighborhoodLimit: z
          .number()
          .int()
          .positive()
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.discover.neighborhoodLimit),
        /**
         * Citing works probed. `"all"` probes every enumerated work (up to
         * `neighborhoodLimit`, which stays the one cap on the neighborhood),
         * so a census never restates that cap as a number.
         */
        probeBudget: z
          .union([z.number().int().nonnegative(), z.literal("all")])
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.discover.probeBudget),
        /**
         * Citing papers fetched, parsed, and harvested at once. Changes wall
         * time only: harvests are appended in neighborhood order, so the
         * artifact is the same at any value, and a resume ignores it.
         */
        fetchConcurrency: z
          .number()
          .int()
          .min(1)
          .max(32)
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.discover.fetchConcurrency),
        candidateSelection: candidateSelectionPolicySchema.default(
          () => CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection,
        ),
        fromYear: z.number().int().positive().optional(),
        toYear: z.number().int().positive().optional(),
        extractionModel: claudeModelSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.discover.extractionModel,
        ),
        extractionThinking: z
          .boolean()
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.discover.extractionThinking),
        /** Model that clusters paraphrased claims across citers, once per seed. */
        canonicalizationModel: claudeModelSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.discover.canonicalizationModel,
        ),
        canonicalizationThinking: z
          .boolean()
          .default(
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.canonicalizationThinking,
          ),
      })
      .strict()
      .default(() => ({ ...CANONICAL_RUN_CONFIG_DEFAULTS.discover })),

    scope: z
      .object({
        groundingModel: claudeModelSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.scope.groundingModel,
        ),
        groundingThinking: z
          .boolean()
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.scope.groundingThinking),
        /**
         * Model that builds a seed codebook. Only used when no codebook is
         * stored for the seed text: changing it does not regenerate one.
         */
        codebookModel: claudeModelSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.scope.codebookModel,
        ),
        /** Model that tags each citing claim with codebook entries. */
        taggingModel: claudeModelSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.scope.taggingModel,
        ),
        /** Absolute path to a local PDF for the seed paper (bypasses OA lookup). */
        seedPdfPath: z.string().min(1).optional(),
      })
      .strict()
      .default(() => ({ ...CANONICAL_RUN_CONFIG_DEFAULTS.scope })),

    prepare: z
      .object({
        /** Deterministic regex pass; its `unclear` verdict falls back to a model. */
        classifier: z
          .literal("deterministic")
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.prepare.classifier),
        /** Model asked to settle a citation role the regex pass left unclear. */
        roleClassifierModel: claudeModelSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.prepare.roleClassifierModel,
        ),
      })
      .strict()
      .default(() => ({ ...CANONICAL_RUN_CONFIG_DEFAULTS.prepare })),

    evidence: z
      .object({
        /** Relevance-only LLM rerank of BM25 candidates; on by default. */
        rerankEnabled: z
          .boolean()
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.evidence.rerankEnabled),
        rerankModel: claudeModelSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.evidence.rerankModel,
        ),
        rerankTopN: z
          .number()
          .int()
          .positive()
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.evidence.rerankTopN),
        bm25CandidateLimit: z
          .number()
          .int()
          .positive()
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.evidence.bm25CandidateLimit),
        selectionLimit: z
          .number()
          .int()
          .positive()
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.evidence.selectionLimit),
      })
      .strict()
      .default(() => ({ ...CANONICAL_RUN_CONFIG_DEFAULTS.evidence })),

    adjudicate: z
      .object({
        model: claudeModelSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.adjudicate.model,
        ),
        thinking: z
          .boolean()
          .default(CANONICAL_RUN_CONFIG_DEFAULTS.adjudicate.thinking),
        /**
         * Thinking effort when `thinking` is on. Exposed so the
         * cheap experiment — does `medium` agree with `high`? — can be run
         * without editing source.
         */
        effort: thinkingEffortSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.adjudicate.effort,
        ),
        /**
         * The whole seed text is the default: the seed is a prompt prefix the
         * provider caches across a seed's records, and the verdict rests on
         * quotes verified against it. A seed text too long to send falls back
         * to the selected chunks.
         */
        evidence: adjudicationEvidenceSchema.default(
          CANONICAL_RUN_CONFIG_DEFAULTS.adjudicate.evidence,
        ),
      })
      .strict()
      .default(() => ({ ...CANONICAL_RUN_CONFIG_DEFAULTS.adjudicate })),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.discover.fromYear != null &&
      config.discover.toYear != null &&
      config.discover.fromYear > config.discover.toYear
    ) {
      context.addIssue({
        code: "custom",
        path: ["discover", "fromYear"],
        message: "discover.fromYear must be ≤ discover.toYear",
      });
    }
    if (config.evidence.selectionLimit > config.evidence.bm25CandidateLimit) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "selectionLimit"],
        message: "selectionLimit cannot exceed bm25CandidateLimit",
      });
    }
  });

export type AnalysisRunConfig = z.infer<typeof analysisRunConfigSchema>;

export const stageArtifactPointerSchema = z
  .object({
    kind: z.string().min(1),
    path: z.string().min(1),
  })
  .passthrough();
export type StageArtifactPointer = z.infer<typeof stageArtifactPointerSchema>;

export const analysisStageSummarySchema = z
  .object({
    headline: z.string().min(1),
    metrics: z.array(
      z
        .object({
          label: z.string().min(1),
          value: z.string().min(1),
        })
        .passthrough(),
    ),
    artifacts: z.array(stageArtifactPointerSchema).default([]),
  })
  .passthrough();
export type AnalysisStageSummary = z.infer<typeof analysisStageSummarySchema>;

export const analysisRunStageSchema = z
  .object({
    runId: z.string().min(1),
    stageKey: stageKeySchema,
    stageOrder: z.number().int().nonnegative(),
    status: analysisRunStageStatusSchema,
    primaryArtifactPath: undefinedable(z.string()),
    reportArtifactPath: undefinedable(z.string()),
    manifestPath: undefinedable(z.string()),
    logPath: undefinedable(z.string()),
    summary: undefinedable(analysisStageSummarySchema),
    errorMessage: undefinedable(z.string()),
    startedAt: undefinedable(z.string()),
    finishedAt: undefinedable(z.string()),
    processId: undefinedable(z.number().int()),
  })
  .passthrough();
export type AnalysisRunStage = z.infer<typeof analysisRunStageSchema>;

export const logicalStageGroupSchema = z.object({
  stageKey: stageKeySchema,
  stageOrder: z.number().int().nonnegative(),
  aggregateStatus: analysisRunStageStatusSchema,
  members: z.array(analysisRunStageSchema),
  summary: undefinedable(analysisStageSummarySchema),
});
export type LogicalStageGroup = z.infer<typeof logicalStageGroupSchema>;

export const analysisRunSchema = z
  .object({
    id: z.string().min(1),
    seedDoi: z.string().min(1),
    /** Always absent for canonical DOI-first runs; column may be null in SQLite. */
    targetStage: stageKeySchema,
    status: analysisRunStatusSchema,
    currentStage: undefinedable(stageKeySchema),
    runRoot: z.string().min(1),
    config: analysisRunConfigSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();
export type AnalysisRun = z.infer<typeof analysisRunSchema>;

/** Canonical F/D/E/U verdict counts (adjudicated records only). */
export const runVerdictSummarySchema = z.object({
  F: z.number().int().nonnegative(),
  D: z.number().int().nonnegative(),
  E: z.number().int().nonnegative(),
  U: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** Operational non-verdict coverage (gates/failures), distinct from U. */
  notAdjudicated: z.number().int().nonnegative(),
  adjudicationFailed: z.number().int().nonnegative(),
  invalidOutput: z.number().int().nonnegative(),
});
export type RunVerdictSummary = z.infer<typeof runVerdictSummarySchema>;

export const dashboardStatsSchema = z.object({
  totalRuns: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
  completedRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
  adjudicatedCitationTotal: z.number().int().nonnegative(),
});
export type DashboardStats = z.infer<typeof dashboardStatsSchema>;

export const runSummarySchema = analysisRunSchema.extend({
  stages: z.array(logicalStageGroupSchema),
  healthSummary: z.string().min(1),
  verdictSummary: runVerdictSummarySchema.optional(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runDetailSchema = analysisRunSchema.extend({
  stages: z.array(logicalStageGroupSchema),
  activeWorkflow: stageWorkflowSnapshotSchema.optional(),
  verdictSummary: runVerdictSummarySchema.optional(),
});
export type RunDetail = z.infer<typeof runDetailSchema>;

export const runStageDetailSchema = analysisRunStageSchema.extend({
  stageTitle: z.string().min(1),
  durationMs: undefinedable(z.number().int().nonnegative()),
  artifactPointers: z.array(stageArtifactPointerSchema),
  inspectorPayload: z.unknown().optional(),
  workflow: stageWorkflowSnapshotSchema,
});
type StripIndexSignature<T> = {
  [K in keyof T as string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K]: T[K];
};
type RunStageDetailBase = StripIndexSignature<
  z.infer<typeof runStageDetailSchema>
>;
type RunStageDetailMap = {
  [K in StageKey]: Omit<RunStageDetailBase, "stageKey" | "inspectorPayload"> & {
    stageKey: K;
    inspectorPayload?: StageInspectorPayload<K>;
  };
};
export type RunStageDetail<K extends StageKey = StageKey> =
  RunStageDetailMap[K];

export const runStageGroupDetailSchema = z.object({
  stageKey: stageKeySchema,
  stageTitle: z.string().min(1),
  aggregateStatus: analysisRunStageStatusSchema,
  members: z.array(runStageDetailSchema),
});
type RunStageGroupDetailBase = StripIndexSignature<
  z.infer<typeof runStageGroupDetailSchema>
>;
type RunStageGroupDetailMap = {
  [K in StageKey]: Omit<RunStageGroupDetailBase, "stageKey" | "members"> & {
    stageKey: K;
    members: RunStageDetail<K>[];
  };
};
export type RunStageGroupDetail<K extends StageKey = StageKey> =
  RunStageGroupDetailMap[K];

export const stageMetricSchema = z
  .object({
    label: z.string().min(1),
    value: z.string().min(1),
  })
  .passthrough();
export type StageMetric = z.infer<typeof stageMetricSchema>;
