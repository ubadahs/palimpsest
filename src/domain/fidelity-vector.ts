import { z } from "zod";

import { undefinedable } from "./common.js";

export const fidelityAxisValues = [
  "support",
  "evidenceGrounding",
  "claimIdentity",
  "directionalAlignment",
  "scopeMatch",
  "certaintyMatch",
  "attributionDirectness",
  "uncertainty",
] as const;
export const fidelityAxisSchema = z.enum(fidelityAxisValues);
export type FidelityAxis = z.infer<typeof fidelityAxisSchema>;

export const fidelityVectorVerdictValues = [
  "supported",
  "partially_supported",
  "overstated_or_generalized",
  "not_supported",
  "cannot_determine",
] as const;
export const fidelityVectorVerdictSchema = z.enum(fidelityVectorVerdictValues);
export type FidelityVectorVerdict = z.infer<typeof fidelityVectorVerdictSchema>;

export const scopeDirectionValues = [
  "none",
  "expansion",
  "contraction",
  "shift",
  "unclear",
] as const;
export const scopeDirectionSchema = z.enum(scopeDirectionValues);
export type ScopeDirection = z.infer<typeof scopeDirectionSchema>;

export const certaintyDirectionValues = [
  "none",
  "escalation",
  "deflation",
  "shift",
  "unclear",
] as const;
export const certaintyDirectionSchema = z.enum(certaintyDirectionValues);
export type CertaintyDirection = z.infer<typeof certaintyDirectionSchema>;

export const fidelityAxisScoreSchema = z
  .object({
    score: z.number().min(0).max(1),
    rationale: z.string().min(1),
  })
  .strict();
export type FidelityAxisScore = z.infer<typeof fidelityAxisScoreSchema>;

export const fidelityVectorAxesSchema = z
  .object({
    support: fidelityAxisScoreSchema,
    evidenceGrounding: fidelityAxisScoreSchema,
    claimIdentity: fidelityAxisScoreSchema,
    directionalAlignment: fidelityAxisScoreSchema,
    scopeMatch: fidelityAxisScoreSchema,
    certaintyMatch: fidelityAxisScoreSchema,
    attributionDirectness: fidelityAxisScoreSchema,
    uncertainty: fidelityAxisScoreSchema,
  })
  .strict();
export type FidelityVectorAxes = z.infer<typeof fidelityVectorAxesSchema>;

export const fidelityVectorAxisValuesSchema = z
  .object({
    support: z.number().min(0).max(1),
    evidenceGrounding: z.number().min(0).max(1),
    claimIdentity: z.number().min(0).max(1),
    directionalAlignment: z.number().min(0).max(1),
    scopeMatch: z.number().min(0).max(1),
    certaintyMatch: z.number().min(0).max(1),
    attributionDirectness: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
  })
  .strict();
export type FidelityVectorAxisValues = z.infer<
  typeof fidelityVectorAxisValuesSchema
>;

export const fidelityVectorCallTelemetrySchema = z
  .object({
    purpose: z.literal("fidelity-vector"),
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
    estimatedCostUsd: z.number().nonnegative(),
  })
  .passthrough();
export type FidelityVectorCallTelemetry = z.infer<
  typeof fidelityVectorCallTelemetrySchema
>;

export const fidelityVectorTelemetrySummarySchema = z
  .object({
    totalCalls: z.number().int().nonnegative(),
    successfulCalls: z.number().int().nonnegative(),
    failedCalls: z.number().int().nonnegative(),
    totalInputTokens: z.number().int().nonnegative(),
    totalOutputTokens: z.number().int().nonnegative(),
    totalReasoningTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    totalLatencyMs: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    calls: z.array(fidelityVectorCallTelemetrySchema),
  })
  .passthrough();
export type FidelityVectorTelemetrySummary = z.infer<
  typeof fidelityVectorTelemetrySummarySchema
>;

export const fidelityVectorSampleSchema = z
  .object({
    sampleIndex: z.number().int().nonnegative(),
    axes: fidelityVectorAxesSchema,
    scopeDirection: scopeDirectionSchema,
    certaintyDirection: certaintyDirectionSchema,
    suggestedVerdict: fidelityVectorVerdictSchema,
    rationale: z.string().min(1),
    telemetry: undefinedable(fidelityVectorCallTelemetrySchema),
  })
  .strict();
export type FidelityVectorSample = z.infer<typeof fidelityVectorSampleSchema>;

export const fidelityVectorVerdictCountsSchema = z
  .object({
    supported: z.number().int().nonnegative(),
    partially_supported: z.number().int().nonnegative(),
    overstated_or_generalized: z.number().int().nonnegative(),
    not_supported: z.number().int().nonnegative(),
    cannot_determine: z.number().int().nonnegative(),
  })
  .strict();
export type FidelityVectorVerdictCounts = z.infer<
  typeof fidelityVectorVerdictCountsSchema
>;

export const scopeDirectionDistributionSchema = z
  .object({
    none: z.number().int().nonnegative(),
    expansion: z.number().int().nonnegative(),
    contraction: z.number().int().nonnegative(),
    shift: z.number().int().nonnegative(),
    unclear: z.number().int().nonnegative(),
  })
  .strict();
export type ScopeDirectionDistribution = z.infer<
  typeof scopeDirectionDistributionSchema
>;

export const certaintyDirectionDistributionSchema = z
  .object({
    none: z.number().int().nonnegative(),
    escalation: z.number().int().nonnegative(),
    deflation: z.number().int().nonnegative(),
    shift: z.number().int().nonnegative(),
    unclear: z.number().int().nonnegative(),
  })
  .strict();
export type CertaintyDirectionDistribution = z.infer<
  typeof certaintyDirectionDistributionSchema
>;

export const fidelityVectorAggregateSchema = z
  .object({
    meanAxes: fidelityVectorAxisValuesSchema,
    varianceAxes: fidelityVectorAxisValuesSchema,
    verdictDistribution: z
      .object({
        sampleCount: z.number().int().nonnegative(),
        counts: fidelityVectorVerdictCountsSchema,
        modalVerdict: fidelityVectorVerdictSchema,
        entropy: z.number().min(0).max(1),
      })
      .strict(),
    scopeDirectionDistribution: scopeDirectionDistributionSchema,
    certaintyDirectionDistribution: certaintyDirectionDistributionSchema,
    disagreementScore: z.number().min(0).max(1),
    overallUncertainty: z.number().min(0).max(1),
  })
  .strict();
export type FidelityVectorAggregate = z.infer<
  typeof fidelityVectorAggregateSchema
>;

export const fidelityVectorTraceSchema = z
  .object({
    version: z.literal("fidelity-vector-trace-v1"),
    model: z.string().min(1),
    temperature: z.number(),
    sampleCount: z.number().int().positive(),
    samples: z.array(fidelityVectorSampleSchema),
    aggregate: fidelityVectorAggregateSchema,
    canonicalVerdict: undefinedable(fidelityVectorVerdictSchema),
    canonicalVerdictAgreement: undefinedable(z.boolean()),
    telemetry: undefinedable(fidelityVectorTelemetrySummarySchema),
  })
  .strict();
export type FidelityVectorTrace = z.infer<typeof fidelityVectorTraceSchema>;
