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
import {
  annotateCitingContext,
  extractCitingWindow,
} from "../shared/citation-context-window.js";
import { pMap } from "../shared/p-map.js";

/** Bump when the adjudication prompt template or verdict schema changes. */
const ADJUDICATION_CACHE_KEY_VERSION = "adjudication-2026-04-14-v8";

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
  if (record.modifiers.isBundled) {
    const size = record.modifiers.bundleSize;
    modifiers.push(
      size != null && size > 1
        ? `bundled citation (${String(size)} references share this marker group)`
        : "bundled citation",
    );
  }
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
Citation marker for the paper under evaluation: "${record.citingMarker}"

"${annotateCitingContext(extractCitingWindow(record.citingSpan, record.seedRefLabel ?? record.citingMarker, 800), record.citingMarker, record.seedRefLabel)}"

Sentences wrapped in ▶ ... ◀ are the ones that directly cite the paper under evaluation. Unmarked sentences cite other papers and are provided as surrounding context only.

## Citation scope

- If ▶ ... ◀ markers are present: only evaluate claims within the marked sentences. Unmarked sentences reference different papers — they provide context but are NOT attributed to the cited paper.
- If no ▶ ... ◀ markers appear AND the citation marker "${record.citingMarker}" is visible in the text: the entire context is attributed to the cited paper.
- If no ▶ ... ◀ markers appear AND the citation marker is NOT visible in the text: the context window may not contain the attributed sentence. Default to cannot_determine.

## Evidence from cited paper

${evidenceBlock}

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
}

export type AdjudicatorOptions = {
  apiKey: string;
  model?: string;
  useExtendedThinking?: boolean;
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

export async function adjudicateAuditSample(
  set: AuditSample,
  options: AdjudicatorOptions,
  onProgress?: (index: number, total: number) => void,
): Promise<AuditSample> {
  const modelId = options.model ?? "claude-opus-4-6";
  const client =
    options.llmClient ??
    createLLMClient({ apiKey: options.apiKey, defaultModel: modelId });

  if (options.advisor) {
    const result = await runAdvisorAdjudication(set, options, client, modelId);
    // Fire a single completion progress event.
    const total = set.records.filter((r) => !r.excluded).length;
    onProgress?.(total, total);
    return result;
  }

  return runPass(set, options, client, modelId, onProgress);
}
