import { z } from "zod";

import { undefinedable } from "../domain/common.js";
import { stageKeyValues } from "./stages.js";
import { stageWorkflowSnapshotSchema } from "./workflow.js";

export const stageKeySchema = z.enum(stageKeyValues);
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

export const analysisRunConfigObjectSchema = z
  .object({
    stopAfterStage: stageKeySchema.default("adjudicate"),
    forceRefresh: z.boolean().default(false),
    curateTargetSize: z.number().int().positive().default(40),
    adjudicateModel: z.string().min(1).default("claude-opus-4-6"),
    adjudicateThinking: z.boolean().default(true),
    evidenceLlmRerank: z.boolean().default(true),
    discoverStrategy: z
      .enum(["legacy", "attribution_first"])
      .default("attribution_first"),
    discoverTopN: z.number().int().positive().default(5),
    discoverRank: z.boolean().default(true),
    discoverModel: z.string().min(1).default("claude-opus-4-6"),
    discoverProbeBudget: z.number().int().positive().default(20),
    discoverShortlistCap: z.number().int().positive().default(10),
    screenGroundingModel: z.string().min(1).default("claude-opus-4-6"),
    screenFilterModel: z.string().min(1).default("claude-haiku-4-5"),
    screenFilterConcurrency: z.number().int().positive().default(10),
    evidenceRerankModel: z.string().min(1).default("claude-haiku-4-5"),
    evidenceRerankTopN: z.number().int().positive().default(5),
    familyConcurrency: z.number().int().positive().default(3),
  })
  .passthrough();

function migrateConfigFields(val: unknown): unknown {
  if (typeof val !== "object" || val === null) return val;
  const obj = val as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  // Migrate old field names from stored config_json
  if ("m5TargetSize" in obj && !("curateTargetSize" in obj)) {
    out["curateTargetSize"] = obj["m5TargetSize"];
    delete out["m5TargetSize"];
  }
  if ("m6Model" in obj && !("adjudicateModel" in obj)) {
    out["adjudicateModel"] = obj["m6Model"];
    delete out["m6Model"];
  }
  if ("m6Thinking" in obj && !("adjudicateThinking" in obj)) {
    out["adjudicateThinking"] = obj["m6Thinking"];
    delete out["m6Thinking"];
  }
  if (out["stopAfterStage"] === "m6-llm-judge")
    out["stopAfterStage"] = "adjudicate";
  if (out["stopAfterStage"] === "pre-screen") out["stopAfterStage"] = "screen";
  if (out["stopAfterStage"] === "m2-extract") out["stopAfterStage"] = "extract";
  if (out["stopAfterStage"] === "m3-classify")
    out["stopAfterStage"] = "classify";
  if (out["stopAfterStage"] === "m4-evidence")
    out["stopAfterStage"] = "evidence";
  if (out["stopAfterStage"] === "m5-adjudicate")
    out["stopAfterStage"] = "curate";
  return out;
}

export const analysisRunConfigSchema = z.preprocess(
  migrateConfigFields,
  analysisRunConfigObjectSchema,
);
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
    familyIndex: z.number().int().nonnegative().default(0),
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

export const runSummarySchema = analysisRunSchema.extend({
  stages: z.array(logicalStageGroupSchema),
  healthSummary: z.string().min(1),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runDetailSchema = analysisRunSchema.extend({
  stages: z.array(logicalStageGroupSchema),
  activeWorkflow: stageWorkflowSnapshotSchema.optional(),
});
export type RunDetail = z.infer<typeof runDetailSchema>;

export const runStageDetailSchema = analysisRunStageSchema.extend({
  stageTitle: z.string().min(1),
  durationMs: undefinedable(z.number().int().nonnegative()),
  artifactPointers: z.array(stageArtifactPointerSchema),
  inspectorPayload: z.unknown().optional(),
  workflow: stageWorkflowSnapshotSchema,
});
export type RunStageDetail = z.infer<typeof runStageDetailSchema>;

export const runStageGroupDetailSchema = z.object({
  stageKey: stageKeySchema,
  stageTitle: z.string().min(1),
  aggregateStatus: analysisRunStageStatusSchema,
  members: z.array(runStageDetailSchema),
});
export type RunStageGroupDetail = z.infer<typeof runStageGroupDetailSchema>;

export const stageMetricSchema = z
  .object({
    label: z.string().min(1),
    value: z.string().min(1),
  })
  .passthrough();
export type StageMetric = z.infer<typeof stageMetricSchema>;
