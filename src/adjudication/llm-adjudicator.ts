import { z } from "zod";

import type {
  AdjudicationRecord,
  CalibrationSet,
  LLMCallTelemetry,
  RunTelemetry,
} from "../domain/types.js";
import type { LLMClient, LLMCallRecord } from "../integrations/llm-client.js";
import { createLLMClient } from "../integrations/llm-client.js";
import { estimateAnthropicUsd } from "../shared/anthropic-token-cost.js";
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";
import { extractCitingWindow } from "../shared/citation-context-window.js";

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

  const seedClaimBlock = record.groundedSeedClaimText
    ? `\nTracked seed claim (grounded in the cited/seed paper during pre-screen): "${record.groundedSeedClaimText}"\nUse this as the analyst's anchor for what the citation family is about, while still judging the citing span on its own terms.\n`
    : "";

  return `You are a citation fidelity adjudicator for a metascience project.

Your task: determine whether a citing paper's use of a cited paper is faithful to what the cited paper actually says.

## Context

Citation role: ${record.citationRole}
Evaluation mode: ${record.evaluationMode}${modifierStr}
Citing paper: "${record.citingPaperTitle}"
Cited paper: "${record.citedPaperTitle}"
${seedClaimBlock}

## Rubric question

${record.rubricQuestion}

## Citing context

Section: ${record.citingSpanSection ?? "unknown"}
Marker: "${record.citingMarker}"

"${extractCitingWindow(record.citingSpan, record.citingMarker, 800)}"

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
  /** Optional pre-existing LLM client for shared ledger tracking. */
  llmClient?: LLMClient;
};

function toLLMCallTelemetry(record: LLMCallRecord): LLMCallTelemetry {
  const telemetry: LLMCallTelemetry = {
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalTokens: record.totalTokens,
    latencyMs: record.latencyMs,
    finishReason: record.finishReason,
    timestamp: record.timestamp,
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

async function callLLMWithThinking(
  record: AdjudicationRecord,
  client: LLMClient,
  modelId: string,
): Promise<{
  verdict: z.infer<typeof verdictSchema>;
  telemetry: LLMCallTelemetry;
}> {
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

  const result = await client.generateText({
    purpose: "adjudication",
    model: modelId,
    prompt: thinkingPrompt,
    thinking: { type: "enabled", budgetTokens: 10000 },
  });

  const parsed = verdictSchema.parse(
    JSON.parse(extractJsonFromModelText(result.text)),
  );

  return { verdict: parsed, telemetry: toLLMCallTelemetry(result.record) };
}

async function callLLMStructured(
  record: AdjudicationRecord,
  client: LLMClient,
  modelId: string,
): Promise<{
  verdict: z.infer<typeof verdictSchema>;
  telemetry: LLMCallTelemetry;
}> {
  const result = await client.generateObject({
    purpose: "adjudication",
    model: modelId,
    prompt: buildPrompt(record),
    schema: verdictSchema,
  });

  return {
    verdict: result.object,
    telemetry: toLLMCallTelemetry(result.record),
  };
}

async function callLLM(
  record: AdjudicationRecord,
  options: AdjudicatorOptions,
  client: LLMClient,
): Promise<{
  verdict: z.infer<typeof verdictSchema>;
  telemetry: LLMCallTelemetry;
}> {
  const modelId = options.model ?? "claude-opus-4-6";

  if (options.useExtendedThinking) {
    return callLLMWithThinking(record, client, modelId);
  }

  return callLLMStructured(record, client, modelId);
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
    estimatedCostUsd: estimateAnthropicUsd(model, totalInput, totalOutput),
    calls,
  };
}

export async function adjudicateCalibrationSet(
  set: CalibrationSet,
  options: AdjudicatorOptions,
  onProgress?: (index: number, total: number) => void,
): Promise<CalibrationSet> {
  const modelId = options.model ?? "claude-opus-4-6";
  const client =
    options.llmClient ??
    createLLMClient({ apiKey: options.apiKey, defaultModel: modelId });

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
      const { verdict, telemetry } = await callLLM(record, options, client);

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
