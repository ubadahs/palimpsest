import { z } from "zod";

import {
  citationRoleSchema,
  evaluationModeSchema,
  transmissionModifiersSchema,
} from "./classification.js";
import { undefinedable } from "./common.js";
import { confidenceSchema } from "./extraction.js";
import {
  evidenceSpanSchema,
  taskEvidenceRetrievalStatusSchema,
} from "./evidence.js";
import { seedPaperInputSchema } from "./pre-screen.js";

export const adjudicationVerdictValues = [
  "supported",
  "partially_supported",
  "overstated_or_generalized",
  "not_supported",
  "cannot_determine",
] as const;

export const adjudicationVerdictSchema = z.enum(adjudicationVerdictValues);
export type AdjudicationVerdict = z.infer<typeof adjudicationVerdictSchema>;

export const retrievalQualityValues = ["high", "medium", "low"] as const;
export const retrievalQualitySchema = z.enum(retrievalQualityValues);
export type RetrievalQuality = z.infer<typeof retrievalQualitySchema>;

export const llmCallTelemetrySchema = z
  .object({
    model: z.string().min(1),
    inputTokens: undefinedable(z.number().int().nonnegative()),
    outputTokens: undefinedable(z.number().int().nonnegative()),
    reasoningTokens: undefinedable(z.number().int().nonnegative()),
    totalTokens: undefinedable(z.number().int().nonnegative()),
    cacheReadTokens: undefinedable(z.number().int().nonnegative()),
    cacheWriteTokens: undefinedable(z.number().int().nonnegative()),
    latencyMs: z.number().int().nonnegative(),
    finishReason: z.string().min(1),
    timestamp: z.string().min(1),
  })
  .passthrough();
export type LLMCallTelemetry = z.infer<typeof llmCallTelemetrySchema>;

export const runTelemetrySchema = z
  .object({
    model: z.string().min(1),
    useExtendedThinking: z.boolean(),
    totalCalls: z.number().int().nonnegative(),
    successfulCalls: z.number().int().nonnegative(),
    failedCalls: z.number().int().nonnegative(),
    totalInputTokens: z.number().int().nonnegative(),
    totalOutputTokens: z.number().int().nonnegative(),
    totalReasoningTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    totalLatencyMs: z.number().int().nonnegative(),
    averageLatencyMs: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    calls: z.array(llmCallTelemetrySchema),
  })
  .passthrough();
export type RunTelemetry = z.infer<typeof runTelemetrySchema>;

export const adjudicationRecordSchema = z
  .object({
    recordId: z.string().min(1),
    taskId: z.string().min(1),
    evaluationMode: evaluationModeSchema,
    citationRole: citationRoleSchema,
    modifiers: transmissionModifiersSchema,
    citingPaperTitle: z.string().min(1),
    citedPaperTitle: z.string().min(1),
    citingSpan: z.string(),
    citingSpanSection: undefinedable(z.string()),
    citingMarker: z.string(),
    rubricQuestion: z.string(),
    evidenceSpans: z.array(evidenceSpanSchema),
    evidenceRetrievalStatus: taskEvidenceRetrievalStatusSchema,
    verdict: undefinedable(adjudicationVerdictSchema),
    rationale: undefinedable(z.string()),
    retrievalQuality: undefinedable(retrievalQualitySchema),
    judgeConfidence: undefinedable(confidenceSchema),
    adjudicator: undefinedable(z.string()),
    adjudicatedAt: undefinedable(z.string()),
    excluded: undefinedable(z.boolean()),
    excludeReason: undefinedable(z.string()),
    telemetry: undefinedable(llmCallTelemetrySchema),
  })
  .passthrough();
export type AdjudicationRecord = z.infer<typeof adjudicationRecordSchema>;

export const calibrationSetSchema = z
  .object({
    seed: seedPaperInputSchema,
    resolvedSeedPaperTitle: z.string().min(1),
    studyMode: z.enum([
      "substantive_only",
      "all_functions_census",
      "background_and_bundled_focus",
      "methods_focus",
      "review_transmission_focus",
    ]),
    createdAt: z.string().min(1),
    targetSize: z.number().int().nonnegative(),
    records: z.array(adjudicationRecordSchema),
    samplingStrategy: z
      .object({
        targetByMode: z.partialRecord(evaluationModeSchema, z.number().int()),
        oversampled: z.array(z.string()),
      })
      .passthrough(),
    runTelemetry: undefinedable(runTelemetrySchema),
    version: z.string().optional(),
    revisionNote: z.string().optional(),
  })
  .passthrough();
export type CalibrationSet = z.infer<typeof calibrationSetSchema>;
