/**
 * Centralized LLM client for all Anthropic API calls.
 *
 * Every LLM interaction in the pipeline goes through this module so that:
 *   - A single `createAnthropic()` client is reused per session.
 *   - Every call is tagged with a `purpose` for per-stage cost attribution.
 *   - Token usage, latency, and estimated cost are captured automatically.
 */

import { createHash } from "node:crypto";

import { generateObject, generateText, jsonSchema, type JSONSchema7 } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

import { estimateAnthropicUsd } from "../shared/anthropic-token-cost.js";
import type { StageKey } from "../contract/lean-stages.js";
import type { DatabaseConnection } from "../storage/database.js";
import {
  computeLLMCacheKey,
  getCachedLLMResult,
  storeLLMResult,
} from "../storage/llm-result-cache.js";

// ---------------------------------------------------------------------------
// Purpose tags — every call site declares why it is calling the LLM.
// ---------------------------------------------------------------------------

export type LLMPurpose =
  | "attributed-claim-extraction"
  | "claim-canonicalization"
  | "citation-role-classification"
  | "seed-grounding"
  | "evidence-rerank"
  | "adjudication";

export type LLMProviderErrorClass =
  | "billing_or_quota"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "network_or_transport"
  /** The request itself was rejected (bad schema, bad parameter); retrying cannot help. */
  | "invalid_request"
  | "unknown";

type LLMCallContext = {
  stageKey?: StageKey;
};

// ---------------------------------------------------------------------------
// Per-call telemetry returned from every invocation.
// ---------------------------------------------------------------------------

export type ThinkingEffort = "low" | "medium" | "high" | "max";

/**
 * Extended thinking configuration.
 *
 * - `adaptive` + `effort`: preferred for Sonnet/Opus 4.6+ (and newer).
 * - `enabled` + `budgetTokens`: legacy fixed-budget mode for older models
 *   that do not support adaptive thinking (e.g. Haiku 4.5, Sonnet 4.5).
 */
export type ThinkingConfig =
  | { type: "adaptive"; effort: ThinkingEffort }
  | { type: "enabled"; budgetTokens: number };

export type LLMCallRecord = {
  purpose: LLMPurpose;
  /** Model the call asked for. */
  model: string;
  /** Model the provider says answered; differs when an alias resolves. */
  servedModel?: string;
  stageKey?: StageKey;
  attempted: true;
  successful: boolean;
  failed: boolean;
  billable: boolean;
  thinkingEnabled: boolean;
  thinkingType?: ThinkingConfig["type"];
  thinkingEffort?: ThinkingEffort;
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

type LLMPurposeSummary = {
  attempted: number;
  successful: number;
  failed: number;
  billable: number;
  exactCacheHits: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Prompt-cache reads and writes: the only way to check a caching claim. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

export type LLMRunLedger = {
  totalCalls: number;
  totalAttemptedCalls: number;
  totalSuccessfulCalls: number;
  totalFailedCalls: number;
  totalBillableCalls: number;
  totalExactCacheHits: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
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
  /**
   * Free-form text generation. No canonical purpose uses it: every one moved
   * to provider-enforced structured output. It is kept deliberately as the
   * documented fallback, because that move is not yet proven on a run — if
   * adjudication reasons worse through a tool schema, this is the way back.
   */
  generateText: (params: GenerateTextParams) => Promise<GenerateTextResult>;

  /** Structured JSON output via a Zod schema; the path every stage uses. */
  generateObject: <T extends z.ZodType>(
    params: GenerateObjectParams<T>,
  ) => Promise<GenerateObjectResult<z.infer<T>>>;

  /** Snapshot of all calls made through this client so far. */
  getLedger: () => LLMRunLedger;
};

export type PromptCacheControl = {
  type: "ephemeral";
  ttl?: "5m" | "1h";
};

type PromptCachePolicy = {
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
type ExactCacheConfig = {
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
      /** Hard cap on generated tokens (thinking included); defaults to 16k. */
      maxOutputTokens?: number;
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
      /** Hard cap on generated tokens (thinking included); defaults to 16k. */
      maxOutputTokens?: number;
    };

/**
 * Every canonical purpose returns a few hundred visible tokens plus thinking.
 * The SDK default for Opus is 128k on a non-streaming request, which invites
 * HTTP timeouts and unbounded spend on a runaway completion.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

type GenerateTextResult = {
  text: string;
  record: LLMCallRecord;
};

export type GenerateObjectParams<T extends z.ZodType = z.ZodType> = (
  | { prompt: string; promptPrefix?: never; promptSuffix?: never }
  | { prompt?: never; promptPrefix: string; promptSuffix: string }
) & {
  purpose: LLMPurpose;
  model?: string;
  schema: T;
  /**
   * Structured output is enforced by the provider, so temperature is safe to
   * set: a lower value cannot produce an unparseable reply any more.
   */
  temperature?: number;
  thinking?: ThinkingConfig;
  context?: LLMCallContext;
  /** Opt in to persistent exact-result caching. */
  exactCache?: ExactCacheConfig;
  /** Hard cap on generated tokens (thinking included); defaults to 16k. */
  maxOutputTokens?: number;
};

type GenerateObjectResult<T> = {
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

class LLMProviderError extends Error {
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
 * Anthropic structured output accepts a subset of JSON Schema: no numeric,
 * string, or array bounds, no `oneOf`, no `not`, no `default`. Zod expresses
 * all of those, so the schema sent to the provider is the shape only and the
 * bounds are enforced by validating the reply against the Zod schema locally.
 */
export function toProviderJsonSchema(schema: z.ZodType): JSONSchema7 {
  const raw = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  return stripUnsupportedKeywords(raw) as JSONSchema7;
}

const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "default",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedKeywords);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    // `z.never()` becomes `{ not: {} }`; an empty items schema is the closest
    // thing the provider accepts, and local validation still rejects entries.
    if (key === "not") continue;
    if (key === "oneOf") {
      out["anyOf"] = stripUnsupportedKeywords(value);
      continue;
    }
    out[key] = stripUnsupportedKeywords(value);
  }
  return out;
}

/**
 * Produce a short hash of a Zod schema for cache-key differentiation.
 * Uses JSON.stringify on the schema's internal definition so that two
 * structurally identical schemas yield the same fingerprint.
 */
export function schemaFingerprint(schema: z.ZodType): string {
  try {
    const schemaInternals = schema as z.ZodType & {
      _zod_def?: unknown;
      _def?: unknown;
    };
    const raw = JSON.stringify(
      schemaInternals._zod_def ??
        schemaInternals._def ??
        schema.description ??
        "",
    );
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

  // Rate limiting is checked first: provider messages such as "rate limit
  // quota exceeded" are transient and must not abort the whole stage as a
  // billing failure.
  if (/rate limit|too many requests|429|overloaded/i.test(normalized)) {
    return {
      classification: "rate_limit",
      fatal: false,
      message,
    };
  }

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

  if (
    /invalid_request_error|output_config|is not supported|invalid schema|\b400\b/i.test(
      normalized,
    )
  ) {
    return {
      classification: "invalid_request",
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

/**
 * Provider prompt caching is prefix-based and charges a write premium on every
 * cached request. Only seed grounding reuses a large prefix (the whole seed
 * text, shared across every family of that seed); extraction, reranking, and
 * adjudication prompts are unique per record, so caching them only costs.
 */
const DEFAULT_PROMPT_CACHE_POLICIES: Partial<
  Record<LLMPurpose, PromptCachePolicy>
> = {
  "seed-grounding": {
    minPromptChars: 4_000,
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

/** True when the model prefers adaptive thinking (Sonnet/Opus 4.6+). */
export function modelSupportsAdaptiveThinking(modelId: string): boolean {
  const match = /claude-(?:sonnet|opus)(?:-(\d+))?(?:[.-](\d+))?/i.exec(
    modelId,
  );
  if (!match) {
    return false;
  }
  const major = Number(match[1] ?? "0");
  const minor = Number(match[2] ?? "0");
  if (!Number.isFinite(major) || major <= 0) {
    return false;
  }
  return major > 4 || (major === 4 && minor >= 6);
}

/**
 * Resolve thinking for a call site. Adaptive+effort for 4.6+ models;
 * fixed budget for older models that still require it.
 */
export function resolveThinkingConfig(params: {
  model: string;
  enabled: boolean;
  /** Soft guidance for adaptive mode. Defaults to `high`. */
  effort?: ThinkingEffort;
  /** Fixed budget for legacy models. Required when adaptive is unsupported. */
  budgetTokens: number;
}): ThinkingConfig | undefined {
  if (!params.enabled) {
    return undefined;
  }
  if (modelSupportsAdaptiveThinking(params.model)) {
    return {
      type: "adaptive",
      effort: params.effort ?? "high",
    };
  }
  return {
    type: "enabled",
    budgetTokens: params.budgetTokens,
  };
}

/** Stable cache-key / provenance encoding of thinking settings. */
export function thinkingConfigKey(thinking?: ThinkingConfig): string {
  if (!thinking) {
    return "";
  }
  if (thinking.type === "adaptive") {
    return `adaptive:${thinking.effort}`;
  }
  return `enabled:${String(thinking.budgetTokens)}`;
}

function promptCachePolicyKey(cacheControl?: PromptCacheControl): string {
  if (!cacheControl) {
    return "";
  }
  return cacheControl.ttl
    ? `${cacheControl.type}:${cacheControl.ttl}`
    : cacheControl.type;
}

type ExactCacheAccessPolicy = "allow" | "bypass";

/**
 * Anthropic providerOptions fragment for thinking (+ effort when adaptive).
 * Effort is a sibling of `thinking` per AI SDK / Anthropic Messages API.
 */
export function buildAnthropicThinkingProviderOptions(
  thinking?: ThinkingConfig,
):
  | {
      thinking: { type: "adaptive" };
      effort: ThinkingEffort;
    }
  | {
      thinking: { type: "enabled"; budgetTokens: number };
    }
  | Record<string, never> {
  if (!thinking) {
    return {};
  }
  if (thinking.type === "adaptive") {
    return {
      thinking: { type: "adaptive" },
      effort: thinking.effort,
    };
  }
  return {
    thinking: {
      type: "enabled",
      budgetTokens: thinking.budgetTokens,
    },
  };
}

export type NormalizedLLMCallProvenance = {
  purpose: LLMPurpose;
  model: string;
  promptVersion: string;
  thinking:
    | { mode: "adaptive"; effort: ThinkingEffort }
    | { mode: "enabled"; budgetTokens: number }
    | { mode: "disabled" };
  exactCacheKeyVersion: string;
  cachePolicy: ExactCacheAccessPolicy;
  promptCachePolicy: string;
};

/** Compact request provenance for adapter-normalized model executions. */
export function buildNormalizedLLMCallProvenance(params: {
  purpose: LLMPurpose;
  model: string;
  promptVersion: string;
  thinking?: ThinkingConfig | undefined;
  exactCacheKeyVersion: string;
  forceRefresh?: boolean | undefined;
  promptCacheControl?: PromptCacheControl | undefined;
}): NormalizedLLMCallProvenance {
  const thinking: NormalizedLLMCallProvenance["thinking"] = !params.thinking
    ? { mode: "disabled" }
    : params.thinking.type === "adaptive"
      ? { mode: "adaptive", effort: params.thinking.effort }
      : {
          mode: "enabled",
          budgetTokens: params.thinking.budgetTokens,
        };

  return {
    purpose: params.purpose,
    model: params.model,
    promptVersion: params.promptVersion,
    thinking,
    exactCacheKeyVersion: params.exactCacheKeyVersion,
    cachePolicy: params.forceRefresh === true ? "bypass" : "allow",
    promptCachePolicy: promptCachePolicyKey(params.promptCacheControl),
  };
}

function thinkingTelemetryFields(thinking?: ThinkingConfig): {
  thinkingEnabled: boolean;
  thinkingType?: ThinkingConfig["type"];
  thinkingEffort?: ThinkingEffort;
  thinkingBudgetTokens?: number;
} {
  if (!thinking) {
    return { thinkingEnabled: false };
  }
  if (thinking.type === "adaptive") {
    return {
      thinkingEnabled: true,
      thinkingType: "adaptive",
      thinkingEffort: thinking.effort,
    };
  }
  return {
    thinkingEnabled: true,
    thinkingType: "enabled",
    thinkingBudgetTokens: thinking.budgetTokens,
  };
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

type PromptShapedRequest = {
  purpose: LLMPurpose;
  prompt?: string | undefined;
  promptPrefix?: string | undefined;
  promptSuffix?: string | undefined;
};

function hasPromptPrefix(
  request: PromptShapedRequest,
): request is PromptShapedRequest & {
  promptPrefix: string;
  promptSuffix: string;
} {
  return typeof request.promptPrefix === "string";
}

function buildModelCallInput(params: {
  request: PromptShapedRequest;
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

  // Either shape is present by construction; the union that reaches here has
  // already been narrowed by `hasPromptPrefix`.
  const prompt = request.prompt ?? "";
  const cacheControl = resolvePromptCacheControl({
    purpose: request.purpose,
    prompt,
    options: params.promptCaching,
  });

  return { prompt, ...(cacheControl ? { cacheControl } : {}) };
}

function buildLedger(calls: LLMCallRecord[]): LLMRunLedger {
  const byPurpose: Partial<Record<LLMPurpose, LLMPurposeSummary>> = {};
  let totalCost = 0;
  let totalAttempted = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;
  let totalBillable = 0;
  let totalExactCacheHits = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;

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
    totalCacheReadTokens += call.cacheReadTokens ?? 0;
    totalCacheWriteTokens += call.cacheWriteTokens ?? 0;

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
      existing.cacheReadTokens += call.cacheReadTokens ?? 0;
      existing.cacheWriteTokens += call.cacheWriteTokens ?? 0;
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
        cacheReadTokens: call.cacheReadTokens ?? 0,
        cacheWriteTokens: call.cacheWriteTokens ?? 0,
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
    totalCacheReadTokens,
    totalCacheWriteTokens,
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

function resolveFullPrompt(params: PromptShapedRequest): string {
  if (typeof params.promptPrefix === "string") {
    return params.promptPrefix + (params.promptSuffix ?? "");
  }
  return params.prompt ?? "";
}

export function createLLMClient(options: CreateLLMClientOptions): LLMClient {
  const anthropic = createAnthropic({ apiKey: options.apiKey });
  const defaultModel = options.defaultModel ?? "claude-sonnet-4-6";
  const calls: LLMCallRecord[] = [];
  const db = options.database;
  const forceRefresh = options.forceRefresh ?? false;

  const MAX_RETRIES = 2;
  const RETRY_BASE_MS = 1_000;

  async function withRetry<T>(
    fn: () => Promise<T>,
    purpose: string,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= MAX_RETRIES) throw error;
        const classification = classifyProviderError(error);
        if (
          classification.fatal ||
          classification.classification === "invalid_request"
        ) {
          throw error;
        }
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
    const thinkingFields = thinkingTelemetryFields(thinking);
    const record: LLMCallRecord = {
      purpose,
      model: modelId,
      ...(context.stageKey != null ? { stageKey: context.stageKey } : {}),
      attempted: true,
      successful: true,
      failed: false,
      billable: false,
      ...thinkingFields,
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
    servedModel: string | undefined,
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
    const thinkingFields = thinkingTelemetryFields(thinking);
    const record: LLMCallRecord = {
      purpose,
      model: modelId,
      ...(servedModel != null && servedModel.length > 0 ? { servedModel } : {}),
      ...(context.stageKey != null ? { stageKey: context.stageKey } : {}),
      attempted: true,
      successful: true,
      failed: false,
      billable: totalBillableTokens > 0,
      ...thinkingFields,
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
    const thinkingFields = thinkingTelemetryFields(params.thinking);
    const record: LLMCallRecord = {
      purpose: params.purpose,
      model: params.modelId,
      ...(params.context.stageKey != null
        ? { stageKey: params.context.stageKey }
        : {}),
      attempted: true,
      successful: false,
      failed: true,
      billable: false,
      ...thinkingFields,
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

      const promptInput = buildModelCallInput({
        request: params,
        promptCaching: options.promptCaching,
      });
      const promptCachePolicy = promptCachePolicyKey(promptInput.cacheControl);
      const cacheAccessPolicy: ExactCacheAccessPolicy = forceRefresh
        ? "bypass"
        : "allow";

      // --- Exact-result cache lookup ---
      if (db && params.exactCache && !forceRefresh) {
        const cacheKey = computeLLMCacheKey({
          purpose: params.purpose,
          model: modelId,
          prompt: resolveFullPrompt(params),
          thinkingConfig: thinkingConfigKey(params.thinking),
          keyVersion: params.exactCache.keyVersion,
          promptCachePolicy,
          cachePolicy: cacheAccessPolicy,
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
      const thinkingProviderOptions = buildAnthropicThinkingProviderOptions(
        params.thinking,
      );
      const anthropicProviderOptions = {
        ...thinkingProviderOptions,
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
              maxOutputTokens:
                params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
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
          result.response?.modelId,
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
              thinkingConfig: thinkingConfigKey(params.thinking),
              keyVersion: params.exactCache.keyVersion,
              promptCachePolicy,
              cachePolicy: cacheAccessPolicy,
            }),
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

      const sf = schemaFingerprint(params.schema);
      const promptInput = buildModelCallInput({
        request: params,
        promptCaching: options.promptCaching,
      });
      const promptCachePolicy = promptCachePolicyKey(promptInput.cacheControl);
      const cacheAccessPolicy: ExactCacheAccessPolicy = forceRefresh
        ? "bypass"
        : "allow";
      const cacheKeyInput = {
        purpose: params.purpose,
        model: modelId,
        prompt: resolveFullPrompt(params),
        thinkingConfig: thinkingConfigKey(params.thinking),
        keyVersion: params.exactCache?.keyVersion ?? "",
        schemaFingerprint: sf,
        promptCachePolicy,
        cachePolicy: cacheAccessPolicy,
      };

      // --- Exact-result cache lookup ---
      if (db && params.exactCache && !forceRefresh) {
        const cached = getCachedLLMResult(
          db,
          computeLLMCacheKey(cacheKeyInput),
        );
        if (cached) {
          const parsed = JSON.parse(cached.responseText) as z.infer<T>;
          const record = buildCacheHitRecord(
            params.purpose,
            modelId,
            context,
            params.thinking,
          );
          return { object: parsed, record };
        }
      }

      const startMs = Date.now();
      const anthropicProviderOptions = {
        ...buildAnthropicThinkingProviderOptions(params.thinking),
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
            generateObject({
              model: anthropic(modelId),
              // The provider sees a constraint-free schema it can enforce;
              // the full Zod schema validates the reply locally.
              schema: jsonSchema<z.infer<T>>(
                toProviderJsonSchema(params.schema),
                {
                  validate: (value) => {
                    const parsed = params.schema.safeParse(value);
                    return parsed.success
                      ? { success: true, value: parsed.data as z.infer<T> }
                      : { success: false, error: parsed.error };
                  },
                },
              ),
              maxOutputTokens:
                params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              ...(promptInput.prompt != null
                ? { prompt: promptInput.prompt }
                : { messages: promptInput.messages }),
              ...(params.temperature != null
                ? { temperature: params.temperature }
                : {}),
              ...(providerOptions ? { providerOptions } : {}),
            }),
          params.purpose,
        );

        const record = buildRecord(
          params.purpose,
          modelId,
          context,
          result.response?.modelId,
          result.usage,
          Date.now() - startMs,
          result.finishReason,
          params.thinking,
        );

        if (record.truncated) {
          console.error(
            `[llm-client] WARNING: ${params.purpose} generateObject truncated (finish_reason=length, model=${modelId}). Output may be incomplete.`,
          );
        }

        // --- Exact-result cache store (skip truncated responses) ---
        if (db && params.exactCache && !forceRefresh && !record.truncated) {
          storeLLMResult(db, {
            cacheKey: computeLLMCacheKey(cacheKeyInput),
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

    getLedger: () => buildLedger(calls),
  };
}
