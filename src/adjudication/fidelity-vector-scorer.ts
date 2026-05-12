import { z } from "zod";

import type {
  AdjudicationRecord,
  FidelityVectorCallTelemetry,
  FidelityVectorTelemetrySummary,
  FidelityVectorTrace,
} from "../domain/types.js";
import { fidelityVectorSampleSchema } from "../domain/types.js";
import type { LLMCallRecord, LLMClient } from "../integrations/llm-client.js";
import {
  buildAdjudicationPacket,
  renderAdjudicationPacket,
} from "./adjudication-packet.js";
import { aggregateFidelityVectorSamples } from "./fidelity-vector-stats.js";

const looseAxisScoreSchema = z
  .object({
    score: z.number(),
    rationale: z.string().min(1),
  })
  .strict();

// Anthropic structured output rejects JSON Schema numeric min/max constraints.
// Use a provider-compatible schema for generation, then validate strict bounds
// with the domain schema after adding code-owned fields.
const fidelityVectorSampleResponseSchema = z
  .object({
    axes: z
      .object({
        support: looseAxisScoreSchema,
        evidenceGrounding: looseAxisScoreSchema,
        claimIdentity: looseAxisScoreSchema,
        directionalAlignment: looseAxisScoreSchema,
        scopeMatch: looseAxisScoreSchema,
        certaintyMatch: looseAxisScoreSchema,
        attributionDirectness: looseAxisScoreSchema,
        uncertainty: looseAxisScoreSchema,
      })
      .strict(),
    scopeDirection: z.enum([
      "none",
      "expansion",
      "contraction",
      "shift",
      "unclear",
    ]),
    certaintyDirection: z.enum([
      "none",
      "escalation",
      "deflation",
      "shift",
      "unclear",
    ]),
    suggestedVerdict: z.enum([
      "supported",
      "partially_supported",
      "overstated_or_generalized",
      "not_supported",
      "cannot_determine",
    ]),
    rationale: z.string().min(1),
  })
  .strict();

export const DEFAULT_FIDELITY_VECTOR_MODEL = "claude-sonnet-4-6";

export type GenerateFidelityVectorTraceParams = {
  record: AdjudicationRecord;
  canonicalVerdict?: NonNullable<AdjudicationRecord["verdict"]>;
  client: LLMClient;
  model: string;
  temperature: number;
  sampleCount: number;
};

export function toFidelityVectorCallTelemetry(
  record: LLMCallRecord,
): FidelityVectorCallTelemetry {
  const telemetry: FidelityVectorCallTelemetry = {
    purpose: "fidelity-vector",
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalTokens: record.totalTokens,
    latencyMs: record.latencyMs,
    finishReason: record.finishReason,
    timestamp: record.timestamp,
    estimatedCostUsd: record.estimatedCostUsd,
  };
  if (record.reasoningTokens != null) {
    telemetry.reasoningTokens = record.reasoningTokens;
  }
  if (record.cacheReadTokens != null) {
    telemetry.cacheReadTokens = record.cacheReadTokens;
  }
  if (record.cacheWriteTokens != null) {
    telemetry.cacheWriteTokens = record.cacheWriteTokens;
  }
  return telemetry;
}

export function summarizeFidelityVectorTelemetry(
  calls: FidelityVectorCallTelemetry[],
): FidelityVectorTelemetrySummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalTokens = 0;
  let totalLatencyMs = 0;
  let estimatedCostUsd = 0;

  for (const call of calls) {
    totalInputTokens += call.inputTokens ?? 0;
    totalOutputTokens += call.outputTokens ?? 0;
    totalReasoningTokens += call.reasoningTokens ?? 0;
    totalTokens += call.totalTokens ?? 0;
    totalLatencyMs += call.latencyMs;
    estimatedCostUsd += call.estimatedCostUsd;
  }

  return {
    totalCalls: calls.length,
    successfulCalls: calls.length,
    failedCalls: 0,
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    totalTokens,
    totalLatencyMs,
    estimatedCostUsd,
    calls,
  };
}

export async function generateFidelityVectorTrace({
  record,
  canonicalVerdict,
  client,
  model,
  temperature,
  sampleCount,
}: GenerateFidelityVectorTraceParams): Promise<FidelityVectorTrace> {
  if (!Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new Error("fidelity vector sampleCount must be a positive integer");
  }

  const prompt = buildFidelityVectorPrompt(record);
  const samples: FidelityVectorTrace["samples"] = [];

  for (let i = 0; i < sampleCount; i++) {
    const result = await client.generateObject({
      purpose: "fidelity-vector",
      model,
      prompt,
      schema: fidelityVectorSampleResponseSchema,
      temperature,
    });
    samples.push(
      fidelityVectorSampleSchema.parse({
        ...result.object,
        sampleIndex: i,
        telemetry: toFidelityVectorCallTelemetry(result.record),
      }),
    );
  }

  const aggregate = aggregateFidelityVectorSamples(samples);
  const trace: FidelityVectorTrace = {
    version: "fidelity-vector-trace-v1",
    model,
    temperature,
    sampleCount,
    samples,
    aggregate,
    telemetry: summarizeFidelityVectorTelemetry(
      samples.flatMap((sample) => (sample.telemetry ? [sample.telemetry] : [])),
    ),
  };

  if (canonicalVerdict != null) {
    trace.canonicalVerdict = canonicalVerdict;
    trace.canonicalVerdictAgreement =
      canonicalVerdict === aggregate.verdictDistribution.modalVerdict;
  }

  return trace;
}

function buildFidelityVectorPrompt(record: AdjudicationRecord): string {
  const packet = buildAdjudicationPacket(record);
  return `You are producing a diagnostic citation-fidelity vector.

You are not replacing the canonical adjudication verdict. Use only the provided citing context and cited-paper evidence. Do not rely on outside knowledge. Scores are diagnostic estimates, not calibrated probabilities.

${renderAdjudicationPacket(packet)}

## Diagnostic axes

Use scores in [0, 1].

- 0.0 = clearly fails this axis
- 0.25 = mostly fails
- 0.5 = mixed, partial, or unclear
- 0.75 = mostly satisfies
- 1.0 = clearly satisfies

For uncertainty only:

- 0.0 = low uncertainty
- 0.5 = moderate uncertainty
- 1.0 = high uncertainty

Axes:

- support: Does the cited evidence support the citing claim?
- evidenceGrounding: Are the retrieved cited-paper spans usable for adjudication?
- claimIdentity: Is the citing claim the same claim as the cited finding or content?
- directionalAlignment: Does the citing claim preserve direction, polarity, or presence/absence?
- scopeMatch: Does the citing claim preserve the cited paper's scope, such as study setting, population, model/system, condition, dataset, intervention, or measurement?
- certaintyMatch: Does the citing claim preserve hedging and strength?
- attributionDirectness: Is the cited paper direct evidence for the claim rather than indirect or background support?
- uncertainty: How unstable, ambiguous, or underdetermined is this judgment? Higher means more uncertain.

Direction fields:

- scopeDirection: "none", "expansion", "contraction", "shift", or "unclear"
- certaintyDirection: "none", "escalation", "deflation", "shift", or "unclear"

Each rationale should refer to the provided text, not outside knowledge. If evidence is insufficient, lower evidenceGrounding and raise uncertainty.

Return only JSON matching this shape:

{
  "axes": {
    "support": { "score": 0.0, "rationale": "short rationale" },
    "evidenceGrounding": { "score": 0.0, "rationale": "short rationale" },
    "claimIdentity": { "score": 0.0, "rationale": "short rationale" },
    "directionalAlignment": { "score": 0.0, "rationale": "short rationale" },
    "scopeMatch": { "score": 0.0, "rationale": "short rationale" },
    "certaintyMatch": { "score": 0.0, "rationale": "short rationale" },
    "attributionDirectness": { "score": 0.0, "rationale": "short rationale" },
    "uncertainty": { "score": 0.0, "rationale": "short rationale" }
  },
  "scopeDirection": "none",
  "certaintyDirection": "none",
  "suggestedVerdict": "supported",
  "rationale": "short overall rationale"
}`;
}

export type FidelityVectorSampleResponse = z.infer<
  typeof fidelityVectorSampleResponseSchema
>;
