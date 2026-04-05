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

export const analysisRunConfigSchema = z
  .object({
    stopAfterStage: stageKeySchema.default("m6-llm-judge"),
    forceRefresh: z.boolean().default(false),
    m5TargetSize: z.number().int().positive().default(40),
    m6Model: z.string().min(1).default("claude-opus-4-6"),
    m6Thinking: z.boolean().default(false),
  })
  .passthrough();
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
    stageOrder: z.number().int().positive(),
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

export const analysisRunSchema = z
  .object({
    id: z.string().min(1),
    seedDoi: z.string().min(1),
    trackedClaim: z.string().min(1),
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
  stages: z.array(analysisRunStageSchema),
  healthSummary: z.string().min(1),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runDetailSchema = analysisRunSchema.extend({
  stages: z.array(analysisRunStageSchema),
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

export const stageMetricSchema = z
  .object({
    label: z.string().min(1),
    value: z.string().min(1),
  })
  .passthrough();
export type StageMetric = z.infer<typeof stageMetricSchema>;
