/**
 * Centralized LLM client for all Anthropic API calls.
 *
 * Every LLM interaction in the pipeline goes through this module so that:
 *   - A single `createAnthropic()` client is reused per session.
 *   - Every call is tagged with a `purpose` for per-stage cost attribution.
 *   - Token usage, latency, and estimated cost are captured automatically.
 */

import { generateObject, generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";

import { estimateAnthropicUsd } from "../shared/anthropic-token-cost.js";

// ---------------------------------------------------------------------------
// Purpose tags — every call site declares why it is calling the LLM.
// ---------------------------------------------------------------------------

export const llmPurposeValues = [
  "seed-grounding",
  "adjudication",
  "evidence-rerank",
] as const;

export type LLMPurpose = (typeof llmPurposeValues)[number];

// ---------------------------------------------------------------------------
// Per-call telemetry returned from every invocation.
// ---------------------------------------------------------------------------

export type LLMCallRecord = {
  purpose: LLMPurpose;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs: number;
  finishReason: string;
  timestamp: string;
  estimatedCostUsd: number;
};

// ---------------------------------------------------------------------------
// Run-level ledger aggregated across all purposes.
// ---------------------------------------------------------------------------

export type LLMPurposeSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
};

export type LLMRunLedger = {
  totalCalls: number;
  totalEstimatedCostUsd: number;
  byPurpose: Partial<Record<LLMPurpose, LLMPurposeSummary>>;
  calls: LLMCallRecord[];
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type LLMClient = {
  /** Free-form text generation. */
  generateText: (params: GenerateTextParams) => Promise<GenerateTextResult>;

  /** Structured JSON output via a Zod schema. */
  generateObject: <T extends z.ZodType>(
    params: GenerateObjectParams<T>,
  ) => Promise<GenerateObjectResult<z.infer<T>>>;

  /** Snapshot of all calls made through this client so far. */
  getLedger: () => LLMRunLedger;
};

export type ThinkingConfig = {
  type: "enabled";
  budgetTokens: number;
};

export type GenerateTextParams = {
  purpose: LLMPurpose;
  model?: string;
  prompt: string;
  thinking?: ThinkingConfig;
};

export type GenerateTextResult = {
  text: string;
  record: LLMCallRecord;
};

export type GenerateObjectParams<T extends z.ZodType> = {
  purpose: LLMPurpose;
  model?: string;
  prompt: string;
  schema: T;
};

export type GenerateObjectResult<T> = {
  object: T;
  record: LLMCallRecord;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type CreateLLMClientOptions = {
  apiKey: string;
  /** Default model when individual calls don't specify one. */
  defaultModel?: string;
};

export function createLLMClient(options: CreateLLMClientOptions): LLMClient {
  const anthropic = createAnthropic({ apiKey: options.apiKey });
  const defaultModel = options.defaultModel ?? "claude-sonnet-4-6";
  const calls: LLMCallRecord[] = [];

  function buildRecord(
    purpose: LLMPurpose,
    modelId: string,
    usage: {
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      totalTokens?: number | undefined;
      inputTokenDetails?:
        | {
            cacheReadTokens?: number | undefined;
            cacheWriteTokens?: number | undefined;
          }
        | undefined;
      outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
    },
    latencyMs: number,
    finishReason: string,
  ): LLMCallRecord {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const record: LLMCallRecord = {
      purpose,
      model: modelId,
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
      latencyMs,
      finishReason,
      timestamp: new Date().toISOString(),
      estimatedCostUsd: estimateAnthropicUsd(
        modelId,
        inputTokens,
        outputTokens,
      ),
    };
    if (usage.outputTokenDetails?.reasoningTokens != null) {
      record.reasoningTokens = usage.outputTokenDetails.reasoningTokens;
    }
    if (usage.inputTokenDetails?.cacheReadTokens != null) {
      record.cacheReadTokens = usage.inputTokenDetails.cacheReadTokens;
    }
    if (usage.inputTokenDetails?.cacheWriteTokens != null) {
      record.cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens;
    }
    calls.push(record);
    return record;
  }

  function buildLedger(): LLMRunLedger {
    const byPurpose: Partial<Record<LLMPurpose, LLMPurposeSummary>> = {};
    let totalCost = 0;

    for (const call of calls) {
      totalCost += call.estimatedCostUsd;
      const existing = byPurpose[call.purpose];
      if (existing) {
        existing.calls += 1;
        existing.inputTokens += call.inputTokens;
        existing.outputTokens += call.outputTokens;
        existing.reasoningTokens += call.reasoningTokens ?? 0;
        existing.estimatedCostUsd += call.estimatedCostUsd;
      } else {
        byPurpose[call.purpose] = {
          calls: 1,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          reasoningTokens: call.reasoningTokens ?? 0,
          estimatedCostUsd: call.estimatedCostUsd,
        };
      }
    }

    return {
      totalCalls: calls.length,
      totalEstimatedCostUsd: totalCost,
      byPurpose,
      calls: [...calls],
    };
  }

  return {
    async generateText(params) {
      const modelId = params.model ?? defaultModel;
      const startMs = Date.now();

      const providerOptions = params.thinking
        ? { anthropic: { thinking: params.thinking } }
        : undefined;

      const result = await generateText({
        model: anthropic(modelId),
        prompt: params.prompt,
        ...(providerOptions ? { providerOptions } : {}),
      });

      const record = buildRecord(
        params.purpose,
        modelId,
        result.usage,
        Date.now() - startMs,
        result.finishReason,
      );

      return { text: result.text, record };
    },

    async generateObject<T extends z.ZodType>(
      params: GenerateObjectParams<T>,
    ): Promise<GenerateObjectResult<z.infer<T>>> {
      const modelId = params.model ?? defaultModel;
      const startMs = Date.now();

      const result = await generateObject({
        model: anthropic(modelId),
        schema: params.schema,
        prompt: params.prompt,
      });

      const record = buildRecord(
        params.purpose,
        modelId,
        result.usage,
        Date.now() - startMs,
        result.finishReason,
      );

      return { object: result.object as z.infer<T>, record };
    },

    getLedger: buildLedger,
  };
}
