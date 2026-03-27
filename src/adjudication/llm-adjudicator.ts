import { generateObject, generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

import type {
  AdjudicationRecord,
  CalibrationSet,
  LLMCallTelemetry,
  RunTelemetry,
} from "../domain/types.js";

const verdictSchema = z.object({
  verdict: z.enum([
    "supported",
    "partially_supported",
    "overstated_or_generalized",
    "not_supported",
    "cannot_determine",
  ]),
  rationale: z.string(),
  retrievalQuality: z.enum(["high", "medium", "low"]),
  judgeConfidence: z.enum(["high", "medium", "low"]),
});

function buildPrompt(record: AdjudicationRecord): string {
  const evidenceBlock =
    record.evidenceSpans.length > 0
      ? record.evidenceSpans
          .slice(0, 3)
          .map(
            (s, i) =>
              `Evidence span ${String(i + 1)} [${s.matchMethod}, relevance ${String(s.relevanceScore)}]:\n"${s.text.substring(0, 500)}"`,
          )
          .join("\n\n")
      : "No evidence spans retrieved.";

  const modifiers: string[] = [];
  if (record.modifiers.isBundled) modifiers.push("bundled citation");
  if (record.modifiers.isReviewMediated) modifiers.push("review-mediated");
  const modifierStr =
    modifiers.length > 0 ? `\nModifiers: ${modifiers.join(", ")}` : "";

  return `You are a citation fidelity adjudicator for a metascience project.

Your task: determine whether a citing paper's use of a cited paper is faithful to what the cited paper actually says.

## Context

Citation role: ${record.citationRole}
Evaluation mode: ${record.evaluationMode}${modifierStr}
Citing paper: "${record.citingPaperTitle}"
Cited paper: "${record.citedPaperTitle}"

## Rubric question

${record.rubricQuestion}

## Citing context

Section: ${record.citingSpanSection ?? "unknown"}
Marker: "${record.citingMarker}"

"${record.citingSpan.substring(0, 800)}"

## Evidence from cited paper

${evidenceBlock}

## Instructions

1. Compare the citing context against the evidence from the cited paper.
2. Determine your verdict using ONLY these options:
   - supported: The cited paper clearly supports the claim/use as stated
   - partially_supported: The cited paper partly supports it, but there is compression, scope expansion, or simplification
   - overstated_or_generalized: The citing paper makes a stronger or broader claim than the cited paper warrants
   - not_supported: The cited paper does not support this use
   - cannot_determine: Insufficient evidence to judge

3. Write a concise rationale (2-3 sentences) explaining your reasoning.
4. Rate the retrieval quality (how well the evidence spans match the citing context).
5. Rate your confidence in the verdict.

Be precise. Do not collapse "partially supported" into "supported." Partial support often means compression, mechanistic sharpening, or scope expansion — these are real phenomena worth tracking.`;
}

export type AdjudicatorOptions = {
  apiKey: string;
  model?: string;
  useExtendedThinking?: boolean;
};

// --- Pricing per million tokens (approximate, Anthropic 2025) ---

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING[model] ?? { input: 3, output: 15 };
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();

  const braced = text.match(/\{[\s\S]*\}/);
  if (braced?.[0]) return braced[0];

  return text;
}

async function callLLMWithThinking(
  record: AdjudicationRecord,
  _options: AdjudicatorOptions,
  anthropic: ReturnType<typeof createAnthropic>,
  modelId: string,
): Promise<{
  verdict: z.infer<typeof verdictSchema>;
  telemetry: LLMCallTelemetry;
}> {
  const startMs = Date.now();

  const thinkingPrompt =
    buildPrompt(record) +
    `

## Response format

Respond with a JSON object (no markdown fencing needed) with exactly these fields:
{
  "verdict": "supported" | "partially_supported" | "overstated_or_generalized" | "not_supported" | "cannot_determine",
  "rationale": "your 2-3 sentence rationale",
  "retrievalQuality": "high" | "medium" | "low",
  "judgeConfidence": "high" | "medium" | "low"
}`;

  const result = await generateText({
    model: anthropic(modelId),
    prompt: thinkingPrompt,
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled" as const, budgetTokens: 10000 },
      },
    },
  });

  const latencyMs = Date.now() - startMs;
  const parsed = verdictSchema.parse(JSON.parse(extractJson(result.text)));

  const telemetry: LLMCallTelemetry = {
    model: modelId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
    totalTokens: result.usage.totalTokens,
    cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: result.usage.inputTokenDetails?.cacheWriteTokens,
    latencyMs,
    finishReason: result.finishReason,
    timestamp: new Date().toISOString(),
  };

  return { verdict: parsed, telemetry };
}

async function callLLMStructured(
  record: AdjudicationRecord,
  anthropic: ReturnType<typeof createAnthropic>,
  modelId: string,
): Promise<{
  verdict: z.infer<typeof verdictSchema>;
  telemetry: LLMCallTelemetry;
}> {
  const startMs = Date.now();

  const result = await generateObject({
    model: anthropic(modelId),
    schema: verdictSchema,
    prompt: buildPrompt(record),
  });

  const latencyMs = Date.now() - startMs;

  const telemetry: LLMCallTelemetry = {
    model: modelId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
    totalTokens: result.usage.totalTokens,
    cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: result.usage.inputTokenDetails?.cacheWriteTokens,
    latencyMs,
    finishReason: result.finishReason,
    timestamp: new Date().toISOString(),
  };

  return { verdict: result.object, telemetry };
}

async function callLLM(
  record: AdjudicationRecord,
  options: AdjudicatorOptions,
): Promise<{
  verdict: z.infer<typeof verdictSchema>;
  telemetry: LLMCallTelemetry;
}> {
  const anthropic = createAnthropic({ apiKey: options.apiKey });
  const modelId = options.model ?? "claude-sonnet-4-6";

  if (options.useExtendedThinking) {
    return callLLMWithThinking(record, options, anthropic, modelId);
  }

  return callLLMStructured(record, anthropic, modelId);
}

function buildRunTelemetry(
  model: string,
  useExtendedThinking: boolean,
  calls: LLMCallTelemetry[],
  failedCount: number,
): RunTelemetry {
  let totalInput = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalAll = 0;
  let totalLatency = 0;

  for (const c of calls) {
    totalInput += c.inputTokens ?? 0;
    totalOutput += c.outputTokens ?? 0;
    totalReasoning += c.reasoningTokens ?? 0;
    totalAll += c.totalTokens ?? 0;
    totalLatency += c.latencyMs;
  }

  return {
    model,
    useExtendedThinking,
    totalCalls: calls.length + failedCount,
    successfulCalls: calls.length,
    failedCalls: failedCount,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalReasoningTokens: totalReasoning,
    totalTokens: totalAll,
    totalLatencyMs: totalLatency,
    averageLatencyMs:
      calls.length > 0 ? Math.round(totalLatency / calls.length) : 0,
    estimatedCostUsd: estimateCost(model, totalInput, totalOutput),
    calls,
  };
}

export async function adjudicateCalibrationSet(
  set: CalibrationSet,
  options: AdjudicatorOptions,
  onProgress?: (index: number, total: number) => void,
): Promise<CalibrationSet> {
  const modelId = options.model ?? "claude-sonnet-4-20250514";
  const records: AdjudicationRecord[] = [];
  const active = set.records.filter((r) => !r.excluded);
  const excluded = set.records.filter((r) => r.excluded);
  const ts = new Date().toISOString();
  const adjudicatorLabel = `llm:${modelId}${options.useExtendedThinking ? ":thinking" : ""}`;

  const telemetryCalls: LLMCallTelemetry[] = [];
  let failedCount = 0;

  for (let i = 0; i < active.length; i++) {
    const record = active[i]!;
    onProgress?.(i + 1, active.length);

    try {
      const { verdict, telemetry } = await callLLM(record, options);

      records.push({
        ...record,
        verdict: verdict.verdict,
        rationale: verdict.rationale,
        retrievalQuality: verdict.retrievalQuality,
        judgeConfidence: verdict.judgeConfidence,
        adjudicator: adjudicatorLabel,
        adjudicatedAt: ts,
        telemetry,
      });

      telemetryCalls.push(telemetry);
    } catch (err) {
      failedCount++;
      records.push({
        ...record,
        verdict: "cannot_determine",
        rationale: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
        retrievalQuality: undefined,
        judgeConfidence: undefined,
        adjudicator: `${adjudicatorLabel}:error`,
        adjudicatedAt: ts,
        telemetry: undefined,
      });
    }
  }

  const runTelemetry = buildRunTelemetry(
    modelId,
    options.useExtendedThinking ?? false,
    telemetryCalls,
    failedCount,
  );

  return {
    ...set,
    records: [...records, ...excluded],
    createdAt: ts,
    runTelemetry,
  };
}
