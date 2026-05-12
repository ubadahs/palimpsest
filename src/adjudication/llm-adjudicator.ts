import { z } from "zod";

import type {
  AdjudicationRecord,
  AuditSample,
  LLMCallTelemetry,
  RunTelemetry,
} from "../domain/types.js";
import type {
  ExactCacheConfig,
  LLMClient,
  LLMCallRecord,
} from "../integrations/llm-client.js";
import { createLLMClient } from "../integrations/llm-client.js";
import { estimateAnthropicUsd } from "../shared/anthropic-token-cost.js";
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";
import { pMap } from "../shared/p-map.js";

import { LLM_CACHE_VERSIONS } from "../config/llm-versions.js";
import {
  buildAdjudicationPacket,
  renderAdjudicationPacket,
} from "./adjudication-packet.js";
import {
  DEFAULT_FIDELITY_VECTOR_MODEL,
  generateFidelityVectorTrace,
} from "./fidelity-vector-scorer.js";
import { runVectorFirstAdjudication } from "./vector-first-adjudicator.js";

const ADJUDICATION_CACHE_KEY_VERSION = LLM_CACHE_VERSIONS.adjudication;

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

function buildPrompt(record: AdjudicationRecord): string {
  const packet = buildAdjudicationPacket(record);

  const fullPrompt = `You are a citation fidelity adjudicator for a metascience project.

Your task: determine whether a citing paper's use of a cited paper is faithful to what the cited paper actually says.

${renderAdjudicationPacket(packet)}

## Instructions

1. In the "comparison" field, write exactly two sentences:
   - First: "The citing paper attributes to the cited paper: [specific claim]."
   - Second: "The cited paper's evidence shows: [what the evidence actually contains]."
   Always refer to "the citing paper" and "the cited paper" — never use raw citation
   markers (like "[59]" or "2009") or author names to refer to them, since those vary
   across papers and are meaningless to downstream readers.

2. In the "rationale" field, follow the same convention: always say "the citing paper"
   and "the cited paper." Explain the gap (or alignment) between what is attributed
   and what the evidence supports in 2-3 sentences.

3. Determine your verdict using ONLY these options:
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

  // Warn if prompt is unusually large (> ~25K tokens, roughly 100K chars).
  if (fullPrompt.length > 100_000) {
    console.error(
      `[adjudicator] WARNING: prompt for record ${record.recordId} is ${String(fullPrompt.length)} chars (~${String(Math.round(fullPrompt.length / 4))} tokens). May approach context limits.`,
    );
  }

  return fullPrompt;
}

export type AdjudicatorOptions = {
  apiKey: string;
  model?: string;
  useExtendedThinking?: boolean;
  adjudicationMode?: "categorical" | "vector_first";
  /** Optional pre-existing LLM client for shared ledger tracking. */
  llmClient?: LLMClient;
  /** Max concurrent adjudication LLM calls. Default 5. */
  concurrency?: number;
  /** Enable persistent exact-result caching. */
  enableExactCache?: boolean;
  /**
   * Advisor mode (two-pass): run a cheap first pass on all records, then
   * escalate only `judgeConfidence === "low"` or `verdict === "cannot_determine"`
   * records to the main model (`model` + `useExtendedThinking`).
   * Expected savings: 50-70% of adjudication cost on well-grounded families.
   */
  advisor?: {
    /** Model for the cheap first pass (e.g. "claude-sonnet-4-6"). */
    firstPassModel: string;
  };
  /** Optional diagnostic vector tracing. Runs only after final adjudication. */
  fidelityVectorTrace?: {
    enabled: boolean;
    sampleCount: number;
    model?: string;
    temperature: number;
    /** Max concurrent vector traces. Defaults to 2. */
    concurrency?: number;
  };
  /** Opt-in vector-first adjudication. Does not run post-hoc traces. */
  vectorFirst?: {
    initialSamples: number;
    maxSamples: number;
    model?: string;
    temperature: number;
    /** Max concurrent vector-first record workers. Defaults to 2. */
    concurrency?: number;
  };
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
  exactCache?: ExactCacheConfig,
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
    ...(exactCache ? { exactCache } : {}),
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
  exactCache?: ExactCacheConfig,
): Promise<{
  verdict: z.infer<typeof verdictSchema>;
  telemetry: LLMCallTelemetry;
}> {
  const result = await client.generateObject({
    purpose: "adjudication",
    model: modelId,
    prompt: buildPrompt(record),
    schema: verdictSchema,
    ...(exactCache ? { exactCache } : {}),
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
  const exactCache: ExactCacheConfig | undefined = options.enableExactCache
    ? { keyVersion: ADJUDICATION_CACHE_KEY_VERSION }
    : undefined;

  if (options.useExtendedThinking) {
    return callLLMWithThinking(record, client, modelId, exactCache);
  }

  return callLLMStructured(record, client, modelId, exactCache);
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
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalAll = 0;
  let totalLatency = 0;

  for (const c of calls) {
    totalInput += c.inputTokens ?? 0;
    totalOutput += c.outputTokens ?? 0;
    totalReasoning += c.reasoningTokens ?? 0;
    totalCacheRead += c.cacheReadTokens ?? 0;
    totalCacheWrite += c.cacheWriteTokens ?? 0;
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
    estimatedCostUsd: estimateAnthropicUsd(model, {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      reasoningTokens: totalReasoning,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
    }),
    calls,
  };
}

/**
 * Single-pass adjudication: run all active records through `callLLM` with
 * the given model and options. Used directly (no advisor) and internally by
 * the advisor implementation.
 */
async function runPass(
  set: AuditSample,
  options: AdjudicatorOptions,
  client: LLMClient,
  modelId: string,
  onProgress?: (index: number, total: number) => void,
): Promise<AuditSample> {
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

/**
 * Two-pass advisor adjudication.
 *
 * Pass 1: Run all active records through the cheap first-pass model (Sonnet,
 *   structured, no thinking).
 * Pass 2: Re-run records where `judgeConfidence === "low"` or
 *   `verdict === "cannot_determine"` through the main model
 *   (`options.model` + `options.useExtendedThinking`).
 *
 * Merged telemetry from both passes is returned in `runTelemetry`.
 * Per-pass telemetry is attached via passthrough (`firstPassTelemetry`,
 * `escalationTelemetry`, `escalationCount`) for UI transparency.
 */
async function runAdvisorAdjudication(
  set: AuditSample,
  options: AdjudicatorOptions,
  client: LLMClient,
  mainModelId: string,
): Promise<AuditSample> {
  const firstPassModelId = options.advisor!.firstPassModel;

  // Pass 1: Sonnet with thinking — reasons through each record before verdict.
  const firstPassResult = await runPass(
    set,
    { ...options, model: firstPassModelId, useExtendedThinking: true },
    client,
    firstPassModelId,
  );

  // Identify records that need escalation.
  // Bundled citations get a lower threshold (medium confidence also escalates)
  // because multi-reference contexts are harder to adjudicate — the first-pass
  // model may misjudge which claims are attributed to which marker.
  const escalationIds = new Set(
    firstPassResult.records
      .filter((r) => {
        if (r.excluded) return false;
        if (r.judgeConfidence === "low" || r.verdict === "cannot_determine") {
          return true;
        }
        if (r.modifiers.isBundled && r.judgeConfidence === "medium") {
          return true;
        }
        return false;
      })
      .map((r) => r.recordId),
  );

  if (escalationIds.size === 0) {
    // First pass was definitive — skip escalation entirely.
    return firstPassResult;
  }

  // Build a subset with only the escalation candidates (all active for runPass).
  // Use original pre-adjudication records so the prompt is built from clean data.
  const originalByRecordId = new Map(set.records.map((r) => [r.recordId, r]));
  const escalationSubset: AuditSample = {
    ...set,
    records: [...escalationIds].flatMap((id) => {
      const r = originalByRecordId.get(id);
      return r ? [r] : [];
    }),
  };

  // Pass 2: main model (Opus) + thinking on escalation candidates.
  const escalationResult = await runPass(
    escalationSubset,
    { ...options, model: mainModelId },
    client,
    mainModelId,
  );

  // Merge: escalated records replace first-pass records; excluded stay.
  const escalatedById = new Map(
    escalationResult.records.map((r) => [r.recordId, r]),
  );
  const mergedRecords = firstPassResult.records.map(
    (r) => escalatedById.get(r.recordId) ?? r,
  );

  // Combined telemetry — sum both passes.
  const combinedCalls = [
    ...(firstPassResult.runTelemetry?.calls ?? []),
    ...(escalationResult.runTelemetry?.calls ?? []),
  ];
  const combinedTelemetry = buildRunTelemetry(
    mainModelId,
    options.useExtendedThinking ?? false,
    combinedCalls,
    (firstPassResult.runTelemetry?.failedCalls ?? 0) +
      (escalationResult.runTelemetry?.failedCalls ?? 0),
  );

  return {
    ...firstPassResult,
    records: mergedRecords,
    runTelemetry: combinedTelemetry,
    // Passthrough fields — preserved by AuditSample's .passthrough() schema.
    firstPassTelemetry: firstPassResult.runTelemetry,
    escalationTelemetry: escalationResult.runTelemetry,
    escalationCount: escalationIds.size,
  };
}

async function attachFidelityVectorTraces(
  set: AuditSample,
  options: AdjudicatorOptions,
  client: LLMClient,
): Promise<AuditSample> {
  const traceOptions = options.fidelityVectorTrace;
  if (!traceOptions?.enabled) {
    return set;
  }

  const concurrency = traceOptions.concurrency ?? 2;
  const model = traceOptions.model ?? DEFAULT_FIDELITY_VECTOR_MODEL;
  const records = await pMap(
    set.records,
    async (record) => {
      if (record.excluded) {
        return record;
      }

      try {
        return {
          ...record,
          fidelityVectorTrace: await generateFidelityVectorTrace({
            record,
            ...(record.verdict != null
              ? { canonicalVerdict: record.verdict }
              : {}),
            client,
            model,
            temperature: traceOptions.temperature,
            sampleCount: traceOptions.sampleCount,
          }),
        } satisfies AdjudicationRecord;
      } catch (error) {
        console.error(
          `[adjudicator] fidelity vector trace failed for record ${record.recordId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return record;
      }
    },
    { concurrency },
  );

  return {
    ...set,
    records,
  };
}

async function runCategoricalAdjudication(
  set: AuditSample,
  options: AdjudicatorOptions,
  client: LLMClient,
  modelId: string,
  onProgress?: (index: number, total: number) => void,
): Promise<AuditSample> {
  if (options.advisor) {
    return runAdvisorAdjudication(set, options, client, modelId);
  }

  return runPass(set, options, client, modelId, onProgress);
}

export async function adjudicateAuditSample(
  set: AuditSample,
  options: AdjudicatorOptions,
  onProgress?: (index: number, total: number) => void,
): Promise<AuditSample> {
  const modelId = options.model ?? "claude-opus-4-6";
  const client =
    options.llmClient ??
    createLLMClient({ apiKey: options.apiKey, defaultModel: modelId });

  if (options.adjudicationMode === "vector_first") {
    const vectorFirstOptions = options.vectorFirst ?? {
      initialSamples: 1,
      maxSamples: 3,
      model: DEFAULT_FIDELITY_VECTOR_MODEL,
      temperature: 0.7,
      concurrency: 2,
    };

    return runVectorFirstAdjudication({
      set,
      client,
      options: vectorFirstOptions,
      runCategoricalAdjudication: (subset) =>
        runCategoricalAdjudication(subset, options, client, modelId),
      ...(onProgress ? { onProgress } : {}),
    });
  }

  if (options.advisor) {
    const result = await runAdvisorAdjudication(set, options, client, modelId);
    // Fire a single completion progress event.
    const total = set.records.filter((r) => !r.excluded).length;
    onProgress?.(total, total);
    return attachFidelityVectorTraces(result, options, client);
  }

  const result = await runPass(set, options, client, modelId, onProgress);
  return attachFidelityVectorTraces(result, options, client);
}
