/**
 * Centralized LLM client for all Anthropic API calls.
 *
 * Every LLM interaction in the pipeline goes through this module so that:
 *   - A single `createAnthropic()` client is reused per session.
 *   - Every call is tagged with a `purpose` for per-stage cost attribution.
 *   - Token usage, latency, and estimated cost are captured automatically.
 */

import { createHash } from "node:crypto";

import { generateObject, generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";

import { estimateAnthropicUsd } from "../shared/anthropic-token-cost.js";
import type { StageKey } from "../ui-contract/run-types.js";
import type { DatabaseConnection } from "../storage/database.js";
import {
  computeLLMCacheKey,
  getCachedLLMResult,
  storeLLMResult,
} from "../storage/llm-result-cache.js";

// ---------------------------------------------------------------------------
// Purpose tags — every call site declares why it is calling the LLM.
// ---------------------------------------------------------------------------

export const llmPurposeValues = [
  "claim-discovery",
  "seed-grounding",
  "claim-family-filter",
  "adjudication",
  "evidence-rerank",
  "attributed-claim-extraction",
  "family-consolidation",
] as const;

export type LLMPurpose = (typeof llmPurposeValues)[number];

export const llmProviderErrorClassValues = [
  "billing_or_quota",
  "authentication",
  "authorization",
  "rate_limit",
  "network_or_transport",
  "unknown",
] as const;

export type LLMProviderErrorClass =
  (typeof llmProviderErrorClassValues)[number];

export type LLMCallContext = {
  stageKey?: StageKey;
  familyIndex?: number;
};

// ---------------------------------------------------------------------------
// Per-call telemetry returned from every invocation.
// ---------------------------------------------------------------------------

export type LLMCallRecord = {
  purpose: LLMPurpose;
  model: string;
  stageKey?: StageKey;
  familyIndex?: number;
  attempted: true;
  successful: boolean;
  failed: boolean;
  billable: boolean;
  thinkingEnabled: boolean;
  thinkingBudgetTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** True when the response came from the persistent exact-result cache. */
  exactCacheHit?: boolean;
  /** True when the LLM stopped due to max tokens (output truncated). */
  truncated?: boolean;
  latencyMs: number;
  finishReason: string;
  timestamp: string;
  estimatedCostUsd: number;
  providerErrorClass?: LLMProviderErrorClass;
  errorMessage?: string;
};

// ---------------------------------------------------------------------------
// Run-level ledger aggregated across all purposes.
// ---------------------------------------------------------------------------

export type LLMPurposeSummary = {
  attempted: number;
  successful: number;
  failed: number;
  billable: number;
  exactCacheHits: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
};

export type LLMRunLedger = {
  totalCalls: number;
  totalAttemptedCalls: number;
  totalSuccessfulCalls: number;
  totalFailedCalls: number;
  totalBillableCalls: number;
  totalExactCacheHits: number;
  totalEstimatedCostUsd: number;
  byPurpose: Partial<Record<LLMPurpose, LLMPurposeSummary>>;
  calls: LLMCallRecord[];
};

export type LLMTelemetryCollector = {
  recordCall: (record: LLMCallRecord) => void;
  getLedger: () => LLMRunLedger;
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

export type PromptCacheControl = {
  type: "ephemeral";
  ttl?: "5m" | "1h";
};

export type PromptCachePolicy = {
  minPromptChars: number;
  cacheControl: PromptCacheControl;
};

export type PromptCachingOptions = {
  enabled?: boolean;
  byPurpose?: Partial<Record<LLMPurpose, PromptCachePolicy | false>>;
};

/**
 * Opt-in exact-result cache config.  Call sites declare a `keyVersion` that
 * must be bumped when the prompt template or output schema changes.
 */
export type ExactCacheConfig = {
  keyVersion: string;
};

export type GenerateTextParams =
  | {
      purpose: LLMPurpose;
      model?: string;
      prompt: string;
      promptPrefix?: never;
      promptSuffix?: never;
      thinking?: ThinkingConfig;
      context?: LLMCallContext;
      /** Opt in to persistent exact-result caching. */
      exactCache?: ExactCacheConfig;
    }
  | {
      purpose: LLMPurpose;
      model?: string;
      prompt?: never;
      /**
       * Shared prompt prefix that can be cached independently from the
       * request-specific suffix.
       */
      promptPrefix: string;
      /** Request-specific tail appended after the cached prefix. */
      promptSuffix: string;
      thinking?: ThinkingConfig;
      context?: LLMCallContext;
      /** Opt in to persistent exact-result caching. */
      exactCache?: ExactCacheConfig;
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
  context?: LLMCallContext;
  /** Opt in to persistent exact-result caching. */
  exactCache?: ExactCacheConfig;
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
  collector?: LLMTelemetryCollector;
  defaultContext?: LLMCallContext;
  promptCaching?: PromptCachingOptions;
  /** SQLite connection for persistent exact-result caching (optional). */
  database?: DatabaseConnection;
  /** When true, bypass exact-result cache reads and writes. */
  forceRefresh?: boolean;
};

export class LLMProviderError extends Error {
  readonly provider = "anthropic";
  readonly classification: LLMProviderErrorClass;
  readonly fatal: boolean;

  constructor(
    message: string,
    classification: LLMProviderErrorClass,
    fatal: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LLMProviderError";
    this.classification = classification;
    this.fatal = fatal;
  }
}

/**
 * Produce a short hash of a Zod schema for cache-key differentiation.
 * Uses JSON.stringify on the schema's internal definition so that two
 * structurally identical schemas yield the same fingerprint.
 */
export function schemaFingerprint(schema: z.ZodType): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const raw = JSON.stringify((schema as any)._zod_def ?? (schema as any)._def ?? schema.description ?? "");
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

export function classifyProviderError(error: unknown): {
  classification: LLMProviderErrorClass;
  fatal: boolean;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    /credit balance|insufficient credit|insufficient funds|billing|quota|payment required|usage limit/i.test(
      normalized,
    )
  ) {
    return {
      classification: "billing_or_quota",
      fatal: true,
      message,
    };
  }

  if (
    /unauthorized|authentication|invalid api key|api key|401/i.test(normalized)
  ) {
    return {
      classification: "authentication",
      fatal: true,
      message,
    };
  }

  if (/forbidden|permission|access denied|403/i.test(normalized)) {
    return {
      classification: "authorization",
      fatal: true,
      message,
    };
  }

  if (/rate limit|too many requests|429|overloaded/i.test(normalized)) {
    return {
      classification: "rate_limit",
      fatal: false,
      message,
    };
  }

  if (
    /network|socket|econn|etimedout|timed out|connection reset|transport/i.test(
      normalized,
    )
  ) {
    return {
      classification: "network_or_transport",
      fatal: false,
      message,
    };
  }

  return {
    classification: "unknown",
    fatal: false,
    message,
  };
}

export function isFatalProviderError(
  error: unknown,
): error is LLMProviderError {
  return error instanceof LLMProviderError && error.fatal;
}

export function createLLMTelemetryCollector(): LLMTelemetryCollector {
  const calls: LLMCallRecord[] = [];

  return {
    recordCall(record) {
      calls.push(record);
    },
    getLedger() {
      return buildLedger(calls);
    },
  };
}

const DEFAULT_PROMPT_CACHE_POLICIES: Partial<
  Record<LLMPurpose, PromptCachePolicy>
> = {
  "seed-grounding": {
    minPromptChars: 4_000,
    cacheControl: { type: "ephemeral", ttl: "5m" },
  },
  "attributed-claim-extraction": {
    minPromptChars: 2_000,
    cacheControl: { type: "ephemeral", ttl: "5m" },
  },
  "claim-family-filter": {
    minPromptChars: 2_000,
    cacheControl: { type: "ephemeral", ttl: "5m" },
  },
  adjudication: {
    minPromptChars: 5_000,
    cacheControl: { type: "ephemeral", ttl: "5m" },
  },
  "evidence-rerank": {
    minPromptChars: 2_000,
    cacheControl: { type: "ephemeral", ttl: "5m" },
  },
};

export function resolvePromptCacheControl(params: {
  purpose: LLMPurpose;
  prompt: string;
  options?: PromptCachingOptions | undefined;
}): PromptCacheControl | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }

  const override = params.options?.byPurpose?.[params.purpose];
  if (override === false) {
    return undefined;
  }

  const policy = override ?? DEFAULT_PROMPT_CACHE_POLICIES[params.purpose];
  if (!policy) {
    return undefined;
  }

  if (params.prompt.length < policy.minPromptChars) {
    return undefined;
  }

  return policy.cacheControl;
}

type CachedPrefixTextPart = {
  type: "text";
  text: string;
  providerOptions?: {
    anthropic: {
      cacheControl: PromptCacheControl;
    };
  };
};

function hasPromptPrefix(
  request: GenerateTextParams,
): request is Extract<
  GenerateTextParams,
  { promptPrefix: string; promptSuffix: string }
> {
  return typeof request.promptPrefix === "string";
}

function buildGenerateTextCallInput(params: {
  request: GenerateTextParams;
  promptCaching?: PromptCachingOptions | undefined;
}):
  | {
      prompt: string;
      messages?: never;
      cacheControl?: PromptCacheControl | undefined;
    }
  | {
      prompt?: never;
      messages: [
        {
          role: "user";
          content: [CachedPrefixTextPart, CachedPrefixTextPart];
        },
      ];
      cacheControl?: never;
    } {
  const request = params.request;
  if (hasPromptPrefix(request)) {
    const cacheControl = resolvePromptCacheControl({
      purpose: request.purpose,
      prompt: request.promptPrefix,
      options: params.promptCaching,
    });
    const prefixPart: CachedPrefixTextPart = cacheControl
      ? {
          type: "text",
          text: request.promptPrefix,
          providerOptions: { anthropic: { cacheControl } },
        }
      : {
          type: "text",
          text: request.promptPrefix,
        };

    return {
      messages: [
        {
          role: "user",
          content: [
            prefixPart,
            {
              type: "text",
              text: request.promptSuffix,
            },
          ],
        },
      ],
    };
  }

  const cacheControl = resolvePromptCacheControl({
    purpose: request.purpose,
    prompt: request.prompt,
    options: params.promptCaching,
  });

  return { prompt: request.prompt, cacheControl };
}

function buildLedger(calls: LLMCallRecord[]): LLMRunLedger {
  const byPurpose: Partial<Record<LLMPurpose, LLMPurposeSummary>> = {};
  let totalCost = 0;
  let totalAttempted = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;
  let totalBillable = 0;
  let totalExactCacheHits = 0;

  for (const call of calls) {
    totalCost += call.estimatedCostUsd;
    totalAttempted += 1;
    if (call.successful) {
      totalSuccessful += 1;
    }
    if (call.failed) {
      totalFailed += 1;
    }
    if (call.billable) {
      totalBillable += 1;
    }
    if (call.exactCacheHit) {
      totalExactCacheHits += 1;
    }

    const existing = byPurpose[call.purpose];
    if (existing) {
      existing.attempted += 1;
      if (call.successful) {
        existing.successful += 1;
      }
      if (call.failed) {
        existing.failed += 1;
      }
      if (call.billable) {
        existing.billable += 1;
      }
      if (call.exactCacheHit) {
        existing.exactCacheHits += 1;
      }
      existing.inputTokens += call.inputTokens;
      existing.outputTokens += call.outputTokens;
      existing.reasoningTokens += call.reasoningTokens ?? 0;
      existing.estimatedCostUsd += call.estimatedCostUsd;
    } else {
      byPurpose[call.purpose] = {
        attempted: 1,
        successful: call.successful ? 1 : 0,
        failed: call.failed ? 1 : 0,
        billable: call.billable ? 1 : 0,
        exactCacheHits: call.exactCacheHit ? 1 : 0,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        reasoningTokens: call.reasoningTokens ?? 0,
        estimatedCostUsd: call.estimatedCostUsd,
      };
    }
  }

  return {
    totalCalls: totalAttempted,
    totalAttemptedCalls: totalAttempted,
    totalSuccessfulCalls: totalSuccessful,
    totalFailedCalls: totalFailed,
    totalBillableCalls: totalBillable,
    totalExactCacheHits,
    totalEstimatedCostUsd: totalCost,
    byPurpose,
    calls: [...calls],
  };
}

function extractCacheCreationFromRawUsage(rawUsage: unknown):
  | {
      ephemeral5mInputTokens?: number;
      ephemeral1hInputTokens?: number;
    }
  | undefined {
  if (typeof rawUsage !== "object" || rawUsage === null) {
    return undefined;
  }

  const raw = rawUsage as {
    cache_creation?: {
      ephemeral_5m_input_tokens?: unknown;
      ephemeral_1h_input_tokens?: unknown;
    };
  };

  const cacheCreation = raw.cache_creation;
  if (typeof cacheCreation !== "object" || cacheCreation === null) {
    return undefined;
  }

  const ephemeral5mInputTokens =
    typeof cacheCreation.ephemeral_5m_input_tokens === "number"
      ? cacheCreation.ephemeral_5m_input_tokens
      : undefined;
  const ephemeral1hInputTokens =
    typeof cacheCreation.ephemeral_1h_input_tokens === "number"
      ? cacheCreation.ephemeral_1h_input_tokens
      : undefined;

  if (ephemeral5mInputTokens == null && ephemeral1hInputTokens == null) {
    return undefined;
  }

  return {
    ...(ephemeral5mInputTokens != null ? { ephemeral5mInputTokens } : {}),
    ...(ephemeral1hInputTokens != null ? { ephemeral1hInputTokens } : {}),
  };
}

function resolveFullPrompt(params: GenerateTextParams): string {
  if (typeof params.promptPrefix === "string") {
    return params.promptPrefix + params.promptSuffix;
  }
  return params.prompt;
}

function thinkingConfigString(thinking?: ThinkingConfig): string {
  return thinking ? `${thinking.type}:${String(thinking.budgetTokens)}` : "";
}

export function createLLMClient(options: CreateLLMClientOptions): LLMClient {
  const anthropic = createAnthropic({ apiKey: options.apiKey });
  const defaultModel = options.defaultModel ?? "claude-sonnet-4-6";
  const calls: LLMCallRecord[] = [];
  const db = options.database;
  const forceRefresh = options.forceRefresh ?? false;

  const MAX_RETRIES = 2;
  const RETRY_BASE_MS = 1_000;

  async function withRetry<T>(fn: () => Promise<T>, purpose: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= MAX_RETRIES) throw error;
        const classification = classifyProviderError(error);
        if (classification.fatal) throw error;
        const delayMs = RETRY_BASE_MS * 2 ** attempt + Math.random() * 500;
        console.error(
          `[llm-client] ${purpose} transient error (${classification.classification}), retry ${String(attempt + 1)}/${String(MAX_RETRIES)} in ${String(Math.round(delayMs))}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  function registerRecord(record: LLMCallRecord): void {
    calls.push(record);
    options.collector?.recordCall(record);
  }

  function buildCacheHitRecord(
    purpose: LLMPurpose,
    modelId: string,
    context: LLMCallContext,
    thinking?: ThinkingConfig,
  ): LLMCallRecord {
    const record: LLMCallRecord = {
      purpose,
      model: modelId,
      ...(context.stageKey != null ? { stageKey: context.stageKey } : {}),
      ...(context.familyIndex != null
        ? { familyIndex: context.familyIndex }
        : {}),
      attempted: true,
      successful: true,
      failed: false,
      billable: false,
      thinkingEnabled: thinking != null,
      ...(thinking?.budgetTokens != null
        ? { thinkingBudgetTokens: thinking.budgetTokens }
        : {}),
      exactCacheHit: true,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      finishReason: "cached",
      timestamp: new Date().toISOString(),
      estimatedCostUsd: 0,
    };
    registerRecord(record);
    return record;
  }

  function buildRecord(
    purpose: LLMPurpose,
    modelId: string,
    context: LLMCallContext,
    usage: {
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      totalTokens?: number | undefined;
      inputTokenDetails?:
        | {
            noCacheTokens?: number | undefined;
            cacheReadTokens?: number | undefined;
            cacheWriteTokens?: number | undefined;
          }
        | undefined;
      outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
      raw?: unknown;
    },
    latencyMs: number,
    finishReason: string,
    thinking?: ThinkingConfig,
  ): LLMCallRecord {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
    const noCacheInputTokens = usage.inputTokenDetails?.noCacheTokens;
    const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    const cacheCreation = extractCacheCreationFromRawUsage(usage.raw);
    const totalBillableTokens = inputTokens + outputTokens;
    const record: LLMCallRecord = {
      purpose,
      model: modelId,
      ...(context.stageKey != null ? { stageKey: context.stageKey } : {}),
      ...(context.familyIndex != null
        ? { familyIndex: context.familyIndex }
        : {}),
      attempted: true,
      successful: true,
      failed: false,
      billable: totalBillableTokens > 0,
      thinkingEnabled: thinking != null,
      ...(thinking?.budgetTokens != null
        ? { thinkingBudgetTokens: thinking.budgetTokens }
        : {}),
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokens ?? totalBillableTokens,
      latencyMs,
      finishReason,
      ...(finishReason === "length" ? { truncated: true } : {}),
      timestamp: new Date().toISOString(),
      estimatedCostUsd: estimateAnthropicUsd(modelId, {
        inputTokens,
        ...(noCacheInputTokens != null ? { noCacheInputTokens } : {}),
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
        ...(cacheCreation ? { cacheCreation } : {}),
      }),
    };
    if (usage.outputTokenDetails?.reasoningTokens != null) {
      record.reasoningTokens = reasoningTokens;
    }
    if (usage.inputTokenDetails?.cacheReadTokens != null) {
      record.cacheReadTokens = cacheReadTokens;
    }
    if (usage.inputTokenDetails?.cacheWriteTokens != null) {
      record.cacheWriteTokens = cacheWriteTokens;
    }
    registerRecord(record);
    return record;
  }

  function buildFailureRecord(params: {
    purpose: LLMPurpose;
    modelId: string;
    context: LLMCallContext;
    latencyMs: number;
    thinking?: ThinkingConfig;
    error: unknown;
  }): LLMCallRecord {
    const provider = classifyProviderError(params.error);
    const record: LLMCallRecord = {
      purpose: params.purpose,
      model: params.modelId,
      ...(params.context.stageKey != null
        ? { stageKey: params.context.stageKey }
        : {}),
      ...(params.context.familyIndex != null
        ? { familyIndex: params.context.familyIndex }
        : {}),
      attempted: true,
      successful: false,
      failed: true,
      billable: false,
      thinkingEnabled: params.thinking != null,
      ...(params.thinking?.budgetTokens != null
        ? { thinkingBudgetTokens: params.thinking.budgetTokens }
        : {}),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: params.latencyMs,
      finishReason: "error",
      timestamp: new Date().toISOString(),
      estimatedCostUsd: 0,
      providerErrorClass: provider.classification,
      errorMessage: provider.message,
    };
    registerRecord(record);
    return record;
  }

  return {
    async generateText(params) {
      const modelId = params.model ?? defaultModel;
      const context = { ...options.defaultContext, ...params.context };

      // --- Exact-result cache lookup ---
      if (db && params.exactCache && !forceRefresh) {
        const cacheKey = computeLLMCacheKey({
          purpose: params.purpose,
          model: modelId,
          prompt: resolveFullPrompt(params),
          thinkingConfig: thinkingConfigString(params.thinking),
          keyVersion: params.exactCache.keyVersion,
        });
        const cached = getCachedLLMResult(db, cacheKey);
        if (cached) {
          const record = buildCacheHitRecord(
            params.purpose,
            modelId,
            context,
            params.thinking,
          );
          return { text: cached.responseText, record };
        }
      }

      const startMs = Date.now();
      const promptInput = buildGenerateTextCallInput({
        request: params,
        promptCaching: options.promptCaching,
      });

      const anthropicProviderOptions = {
        ...(params.thinking ? { thinking: params.thinking } : {}),
        ...(promptInput.cacheControl
          ? { cacheControl: promptInput.cacheControl }
          : {}),
      };
      const providerOptions =
        Object.keys(anthropicProviderOptions).length > 0
          ? { anthropic: anthropicProviderOptions }
          : undefined;
      try {
        const result = await withRetry(
          () =>
            generateText({
              model: anthropic(modelId),
              ...(promptInput.prompt != null
                ? { prompt: promptInput.prompt }
                : { messages: promptInput.messages }),
              ...(providerOptions ? { providerOptions } : {}),
            }),
          params.purpose,
        );

        const record = buildRecord(
          params.purpose,
          modelId,
          context,
          result.usage,
          Date.now() - startMs,
          result.finishReason,
          params.thinking,
        );

        if (record.truncated) {
          console.error(
            `[llm-client] WARNING: ${params.purpose} response truncated (finish_reason=length, model=${modelId}). Output may be incomplete.`,
          );
        }

        // --- Exact-result cache store ---
        if (db && params.exactCache && !forceRefresh && !record.truncated) {
          storeLLMResult(db, {
            cacheKey: computeLLMCacheKey({
              purpose: params.purpose,
              model: modelId,
              prompt: resolveFullPrompt(params),
              thinkingConfig: thinkingConfigString(params.thinking),
              keyVersion: params.exactCache.keyVersion,
            }),
            purpose: params.purpose,
            model: modelId,
            keyVersion: params.exactCache.keyVersion,
            responseText: result.text,
            createdAt: new Date().toISOString(),
          });
        }

        return { text: result.text, record };
      } catch (error) {
        buildFailureRecord({
          purpose: params.purpose,
          modelId,
          context,
          latencyMs: Date.now() - startMs,
          ...(params.thinking != null ? { thinking: params.thinking } : {}),
          error,
        });
        const provider = classifyProviderError(error);
        throw new LLMProviderError(
          provider.message,
          provider.classification,
          provider.fatal,
          { cause: error },
        );
      }
    },

    async generateObject<T extends z.ZodType>(
      params: GenerateObjectParams<T>,
    ): Promise<GenerateObjectResult<z.infer<T>>> {
      const modelId = params.model ?? defaultModel;
      const context = { ...options.defaultContext, ...params.context };

      // --- Exact-result cache lookup ---
      const sf = schemaFingerprint(params.schema);
      if (db && params.exactCache && !forceRefresh) {
        const cacheKey = computeLLMCacheKey({
          purpose: params.purpose,
          model: modelId,
          prompt: params.prompt,
          thinkingConfig: "",
          keyVersion: params.exactCache.keyVersion,
          schemaFingerprint: sf,
        });
        const cached = getCachedLLMResult(db, cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached.responseText) as z.infer<T>;
          const record = buildCacheHitRecord(params.purpose, modelId, context);
          return { object: parsed, record };
        }
      }

      const startMs = Date.now();
      const cacheControl = resolvePromptCacheControl({
        purpose: params.purpose,
        prompt: params.prompt,
        options: options.promptCaching,
      });
      const providerOptions = cacheControl
        ? { anthropic: { cacheControl } }
        : undefined;

      try {
        const result = await withRetry(
          () =>
            generateObject({
              model: anthropic(modelId),
              schema: params.schema,
              prompt: params.prompt,
              ...(providerOptions ? { providerOptions } : {}),
            }),
          params.purpose,
        );

        const record = buildRecord(
          params.purpose,
          modelId,
          context,
          result.usage,
          Date.now() - startMs,
          result.finishReason,
        );

        if (record.truncated) {
          console.error(
            `[llm-client] WARNING: ${params.purpose} generateObject truncated (finish_reason=length, model=${modelId}). Output may be incomplete.`,
          );
        }

        // --- Exact-result cache store (skip truncated responses) ---
        if (db && params.exactCache && !forceRefresh && !record.truncated) {
          storeLLMResult(db, {
            cacheKey: computeLLMCacheKey({
              purpose: params.purpose,
              model: modelId,
              prompt: params.prompt,
              thinkingConfig: "",
              keyVersion: params.exactCache.keyVersion,
              schemaFingerprint: sf,
            }),
            purpose: params.purpose,
            model: modelId,
            keyVersion: params.exactCache.keyVersion,
            responseText: JSON.stringify(result.object),
            createdAt: new Date().toISOString(),
          });
        }

        return { object: result.object as z.infer<T>, record };
      } catch (error) {
        buildFailureRecord({
          purpose: params.purpose,
          modelId,
          context,
          latencyMs: Date.now() - startMs,
          error,
        });
        const provider = classifyProviderError(error);
        throw new LLMProviderError(
          provider.message,
          provider.classification,
          provider.fatal,
          { cause: error },
        );
      }
    },

    getLedger: () => buildLedger(calls),
  };
}
