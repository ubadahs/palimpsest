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
import { pMap } from "../shared/p-map.js";

const verdictSchema = z.object({
  // comparison comes first to anchor reasoning before the verdict is assigned
  comparison: z.string(),
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

/**
 * Returns a warning note when retrieval did not produce full-text evidence,
 * so the adjudicator knows why the evidence block is empty or weak.
 */
function retrievalStatusNote(status: string): string {
  switch (status) {
    case "no_fulltext":
      return "Note: The cited paper's full text was not available — evidence is abstract-only or absent. Default to cannot_determine unless the abstract alone is sufficient to judge.";
    case "abstract_only_matches":
      return "Note: Only abstract-level passages were retrieved; body text was unavailable or yielded no matches. Abstract evidence is weaker — rate retrievalQuality as medium or low.";
    case "unresolved_cited_paper":
      return "Note: The cited paper metadata could not be resolved. No full-text evidence was retrieved. Verdict should be cannot_determine.";
    case "no_matches":
      return "Note: No matching passages were found in the cited paper. This may indicate a retrieval gap or a mismatch between the citation and the paper's content.";
    default:
      return "";
  }
}

const EVIDENCE_LEGEND =
  "Evidence legend: llm_reranked = LLM-curated key sentences (score 0–100); bm25 / bm25_reranked = lexical keyword match.";

function buildPrompt(record: AdjudicationRecord): string {
  const spansText =
    record.evidenceSpans.length > 0
      ? EVIDENCE_LEGEND +
        "\n\n" +
        record.evidenceSpans
          .slice(0, 3)
          .map((s, i) => {
            // Only show score for llm_reranked — the 0–100 scale is meaningful;
            // BM25 scores are not comparable and would be noise.
            const scoreLabel =
              s.matchMethod === "llm_reranked"
                ? `, relevance ${String(s.relevanceScore)}/100`
                : "";
            const sectionLabel = s.sectionTitle
              ? ` (section: "${s.sectionTitle}")`
              : "";
            return `Evidence span ${String(i + 1)} [${s.matchMethod}${scoreLabel}]${sectionLabel}:\n"${s.text}"`;
          })
          .join("\n\n")
      : "No evidence spans retrieved.";

  const statusNote = retrievalStatusNote(record.evidenceRetrievalStatus);
  const evidenceBlock = statusNote
    ? `${statusNote}\n\n${spansText}`
    : spansText;

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

1. In the "comparison" field, write one sentence stating what the citing context claims
   the cited paper shows, and one sentence summarizing what the evidence spans actually
   contain. This anchors your reasoning before you assign a verdict.

2. Determine your verdict using ONLY these options:
   - supported: The cited paper clearly and specifically supports the claim/use as stated.
     Use this only when the evidence directly contains the asserted fact, finding, or method.
   - partially_supported: The cited paper provides some support, but the citing paper
     compresses, sharpens, or expands it in a way that may mislead. Common patterns:
       • A qualified finding is cited as if unqualified ("under condition X" dropped).
       • A relative or probabilistic claim is cited as absolute ("often" becomes "always").
       • A specific result is generalized beyond its scope in the citing paper.
     Compression or simplification counts as partial support even if it reads as acceptable
     shorthand — this project's goal is detecting latent distortion, not exonerating it.
   - overstated_or_generalized: The citing paper makes a claim that is broader, stronger,
     or more universal than anything the cited paper states or implies. The gap is large
     enough that a reader relying on the citing paper would form a materially wrong impression.
     Common patterns:
       • A finding in one cell type / model / condition is cited as a general mechanism.
       • A dose-dependent or conditional effect becomes a clean causal statement.
       • A preliminary or single-study result is cited as established fact.
   - not_supported: The cited paper does not address the claim being made, or directly
     contradicts it.
   - cannot_determine: The retrieved evidence is insufficient to judge. Use this when
     retrieval clearly failed (wrong section, missing full text) — not as a hedge when
     evidence is merely ambiguous. If evidence is ambiguous, reason through it and choose
     the most defensible label with lower judgeConfidence.

3. Write a concise rationale (2-3 sentences) explaining your reasoning.

4. Rate the retrieval quality (how well the evidence spans match what the citing context
   is actually citing):
   - high: At least one span directly contains the specific fact, finding, or method
     being cited. A human reviewer could verify the verdict from the span alone without
     returning to the full paper.
   - medium: The spans are topically relevant but do not contain the specific assertion
     being evaluated. A reviewer would need to read more of the paper to reach a confident
     conclusion.
   - low: The spans are from the wrong section, do not substantively relate to the citing
     context, or are abstract-only. The verdict is based on partial or indirect evidence.

5. Rate your confidence in the verdict.`;
}

export type AdjudicatorOptions = {
  apiKey: string;
  model?: string;
  useExtendedThinking?: boolean;
  /** Optional pre-existing LLM client for shared ledger tracking. */
  llmClient?: LLMClient;
  /** Max concurrent adjudication LLM calls. Default 5. */
  concurrency?: number;
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
  "comparison": "Citing paper claims X. Evidence shows Y.",
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

  let completed = 0;
  const concurrency = options.concurrency ?? 5;

  const adjudicated = await pMap(
    active,
    async (record) => {
      try {
        const { verdict, telemetry } = await callLLM(record, options, client);
        completed++;
        onProgress?.(completed, active.length);
        return {
          record: {
            ...record,
            comparison: verdict.comparison,
            verdict: verdict.verdict,
            rationale: verdict.rationale,
            retrievalQuality: verdict.retrievalQuality,
            judgeConfidence: verdict.judgeConfidence,
            adjudicator: adjudicatorLabel,
            adjudicatedAt: ts,
            telemetry,
          } satisfies AdjudicationRecord,
          telemetry,
          failed: false as const,
        };
      } catch (err) {
        completed++;
        onProgress?.(completed, active.length);
        return {
          record: {
            ...record,
            comparison: undefined,
            verdict: "cannot_determine",
            rationale: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
            retrievalQuality: undefined,
            judgeConfidence: undefined,
            adjudicator: `${adjudicatorLabel}:error`,
            adjudicatedAt: ts,
            telemetry: undefined,
          } satisfies AdjudicationRecord,
          telemetry: undefined,
          failed: true as const,
        };
      }
    },
    { concurrency },
  );

  const telemetryCalls: LLMCallTelemetry[] = [];
  let failedCount = 0;
  for (const entry of adjudicated) {
    records.push(entry.record);
    if (entry.failed) {
      failedCount++;
    } else if (entry.telemetry) {
      telemetryCalls.push(entry.telemetry);
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
