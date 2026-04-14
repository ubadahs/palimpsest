import { z } from "zod";

import { fullTextAcquisitionSchema } from "./common.js";
import { claimGroundingSchema, seedPaperInputSchema } from "./pre-screen.js";

/** Increment when the trace envelope or required fields change. */
export const PRE_SCREEN_GROUNDING_TRACE_SCHEMA_VERSION = 2;

/**
 * Structured JSON the model is instructed to return (parsed from raw text).
 */
export const claimGroundingLlmParsedResponseSchema = z.object({
  status: z.enum(["grounded", "ambiguous", "not_found"]),
  normalizedClaim: z.string().min(1),
  supportSpans: z.array(
    z.object({
      verbatimQuote: z.string().min(1),
      sectionHint: z.string().optional(),
    }),
  ),
  detailReason: z.string().min(1),
});
export type ClaimGroundingLlmParsedResponse = z.infer<
  typeof claimGroundingLlmParsedResponseSchema
>;

export const quoteVerificationFailureSchema = z
  .object({
    quote: z.string().min(1),
    reason: z.string().min(1),
  })
  .passthrough();
export type QuoteVerificationFailure = z.infer<
  typeof quoteVerificationFailureSchema
>;

export const quoteVerificationResultSchema = z
  .object({
    overallOk: z.boolean(),
    failures: z.array(quoteVerificationFailureSchema),
  })
  .passthrough();
export type QuoteVerificationResult = z.infer<
  typeof quoteVerificationResultSchema
>;

export const groundingTraceLlmCallSchema = z
  .object({
    modelId: z.string().min(1),
    promptTemplateVersion: z.string().min(1),
    promptText: z.string().min(1),
    manuscriptCharCount: z.number().int().nonnegative(),
    manuscriptSha256: z.string().length(64),
    rawResponseText: z.string(),
    parsedResponse: claimGroundingLlmParsedResponseSchema.optional(),
    parseError: z.string().optional(),
    quoteVerification: quoteVerificationResultSchema.optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    latencyMs: z.number().int().nonnegative(),
    finishReason: z.string().optional(),
    estimatedCostUsd: z.number().optional(),
  })
  .passthrough();
export type GroundingTraceLlmCall = z.infer<typeof groundingTraceLlmCallSchema>;

/**
 * One seed's end-to-end grounding trace (resolution → materialization → optional LLM).
 */
export const preScreenGroundingTraceRecordSchema = z
  .object({
    seed: seedPaperInputSchema.pick({ doi: true, trackedClaim: true }),
    seedResolutionOk: z.boolean(),
    seedResolutionError: z.string().optional(),
    resolvedSeedPaperId: z.string().optional(),
    resolvedSeedTitle: z.string().optional(),
    materialization: fullTextAcquisitionSchema.optional(),
    materializationError: z.string().optional(),
    llmCall: groundingTraceLlmCallSchema.optional(),
    finalClaimGrounding: claimGroundingSchema,
  })
  .passthrough();
export type PreScreenGroundingTraceRecord = z.infer<
  typeof preScreenGroundingTraceRecordSchema
>;

export const preScreenGroundingTraceEntrySchema = z
  .object({
    seedDoiKey: z.string().min(1),
    record: preScreenGroundingTraceRecordSchema,
  })
  .passthrough();
export type PreScreenGroundingTraceEntry = z.infer<
  typeof preScreenGroundingTraceEntrySchema
>;

function migrateTraceFileShape(val: unknown): unknown {
  if (typeof val !== "object" || val === null) {
    return val;
  }
  const obj = val as Record<string, unknown>;
  if (Array.isArray(obj["records"])) {
    return obj;
  }
  const legacy = obj["recordsBySeedDoi"];
  if (typeof legacy !== "object" || legacy === null) {
    return obj;
  }

  const records = Object.entries(legacy as Record<string, unknown>).map(
    ([seedDoiKey, record]) => ({
      seedDoiKey,
      record,
    }),
  );
  return {
    ...obj,
    schemaVersion:
      typeof obj["schemaVersion"] === "number"
        ? obj["schemaVersion"]
        : PRE_SCREEN_GROUNDING_TRACE_SCHEMA_VERSION,
    records,
  };
}

export const preScreenGroundingTraceFileSchema = z.preprocess(
  migrateTraceFileShape,
  z
    .object({
      artifactKind: z.literal("pre-screen-grounding-trace"),
      schemaVersion: z.number().int().positive(),
      generatedAt: z.string().min(1),
      records: z.array(preScreenGroundingTraceEntrySchema),
    })
    .passthrough(),
);
export type PreScreenGroundingTraceFile = z.infer<
  typeof preScreenGroundingTraceFileSchema
>;

export function normalizeSeedDoiForTraceKey(doi: string): string {
  return doi.trim().toLowerCase();
}

export function groupTraceRecordsBySeedDoi(
  trace: PreScreenGroundingTraceFile,
): Record<string, PreScreenGroundingTraceRecord[]> {
  const grouped: Record<string, PreScreenGroundingTraceRecord[]> = {};
  for (const entry of trace.records) {
    const existing = grouped[entry.seedDoiKey];
    if (existing) {
      existing.push(entry.record);
    } else {
      grouped[entry.seedDoiKey] = [entry.record];
    }
  }
  return grouped;
}
