import { z } from "zod";

import { undefinedable } from "../domain/common.js";
import type { StageInspectorPayload } from "./inspector-payloads.js";
import { stageKeyValues } from "./stages.js";
import { stageWorkflowSnapshotSchema } from "./workflow.js";

const stageKeySchema = z.enum(stageKeyValues);
export type StageKey = z.infer<typeof stageKeySchema>;

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

/**
 * Minimal canonical run config. Grouped by stage where practical.
 * Old seven-stage fields (screen/curate/advisor/vector/shortlist) are rejected.
 */
export const analysisRunConfigSchema = z
  .object({
    stopAfterStage: stageKeySchema.default("report"),
    forceRefresh: z.boolean().default(false),

    discover: z
      .object({
        neighborhoodProvider: z.string().min(1).default("openalex"),
        neighborhoodQuery: z.string().min(1).default("works-citing-seed"),
        neighborhoodLimit: z.number().int().positive().default(200),
        probeBudget: z.number().int().nonnegative().default(100),
        scopeCandidateCap: z.number().int().nonnegative().default(5),
        fromYear: z.number().int().positive().optional(),
        toYear: z.number().int().positive().optional(),
        extractionModel: z.string().min(1).default("claude-haiku-4-5"),
        extractionThinking: z.boolean().default(false),
      })
      .strict()
      .default(() => ({
        neighborhoodProvider: "openalex",
        neighborhoodQuery: "works-citing-seed",
        neighborhoodLimit: 200,
        probeBudget: 100,
        scopeCandidateCap: 5,
        extractionModel: "claude-haiku-4-5",
        extractionThinking: false,
      })),

    scope: z
      .object({
        groundingModel: z.string().min(1).default("claude-sonnet-4-6"),
        groundingThinking: z.boolean().default(true),
        /** Absolute path to a local PDF for the seed paper (bypasses OA lookup). */
        seedPdfPath: z.string().min(1).optional(),
      })
      .strict()
      .default(() => ({
        groundingModel: "claude-sonnet-4-6",
        groundingThinking: true,
      })),

    prepare: z
      .object({
        classifier: z.literal("deterministic").default("deterministic"),
      })
      .strict()
      .default(() => ({
        classifier: "deterministic" as const,
      })),

    evidence: z
      .object({
        /** Relevance-only LLM rerank; disabled by default. */
        rerankEnabled: z.boolean().default(false),
        rerankModel: z.string().min(1).default("claude-haiku-4-5"),
        rerankTopN: z.number().int().positive().default(5),
        bm25CandidateLimit: z.number().int().positive().default(20),
        selectionLimit: z.number().int().positive().default(5),
      })
      .strict()
      .default(() => ({
        rerankEnabled: false,
        rerankModel: "claude-haiku-4-5",
        rerankTopN: 5,
        bm25CandidateLimit: 20,
        selectionLimit: 5,
      })),

    adjudicate: z
      .object({
        model: z.string().min(1).default("claude-opus-4-6"),
        thinking: z.boolean().default(true),
      })
      .strict()
      .default(() => ({
        model: "claude-opus-4-6",
        thinking: true,
      })),
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
    inputArtifactPath: undefinedable(z.string()),
    primaryArtifactPath: undefinedable(z.string()),
    reportArtifactPath: undefinedable(z.string()),
    manifestPath: undefinedable(z.string()),
    logPath: undefinedable(z.string()),
    summary: undefinedable(analysisStageSummarySchema),
    errorMessage: undefinedable(z.string()),
    startedAt: undefinedable(z.string()),
    finishedAt: undefinedable(z.string()),
    exitCode: undefinedable(z.number().int()),
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
    trackedClaim: undefinedable(z.string().min(1)),
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
