/**
 * Centralized LLM client for all Anthropic API calls.
 *
 * Every LLM interaction in the pipeline goes through this module so that:
 *   - A single `createAnthropic()` client is reused per session.
 *   - Every call is tagged with a `purpose` for per-stage cost attribution.
 *   - Token usage, latency, and estimated cost are captured automatically.
 */

import { createHash } from "node:crypto";

import {
  generateObject,
  jsonSchema,
  NoObjectGeneratedError,
  type JSONSchema7,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

import { estimateAnthropicUsd } from "../shared/anthropic-token-cost.js";
import {
  createBatchTransport,
  TRANSPORT_HEADER,
  type BatchTransportSettings,
  type FetchFunction,
} from "./batch-transport.js";
import type { StageKey } from "../contract/lean-stages.js";
import type { ThinkingEffort } from "../contract/model-execution.js";
import type { DatabaseConnection } from "../storage/database.js";
import { createSqliteBatchRequestStore } from "../storage/llm-batch-requests.js";
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
  | "seed-codebook"
  | "codebook-tagging"
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
  | "malformed_output"
  /** The run's spend limit was reached, so no request was sent. */
  | "spend_limit"
  | "unknown";

type LLMCallContext = {
  stageKey?: StageKey;
};

// ---------------------------------------------------------------------------
// Per-call telemetry returned from every invocation.
// ---------------------------------------------------------------------------

type LLMTransport = "direct" | "batch";

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
  thinkingEffort?: ThinkingEffort;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** True when the response came from the persistent exact-result cache. */
  exactCacheHit?: boolean;
  /**
   * How a provider reply arrived: one direct request, or a Message Batches
   * result billed at half price. How the answer was obtained, never what it
   * was, so it stays out of result identity like `servedModel`.
   */
  transport?: LLMTransport;
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

  /** Structured JSON output via a Zod schema; the path every stage uses. */
  generateObject: <T extends z.ZodType>(
    params: GenerateObjectParams<T>,
  ) => Promise<GenerateObjectResult<z.infer<T>>>;

  /** Snapshot of all calls made through this client so far. */
  getLedger: () => LLMRunLedger;

  /** True when requests go through the Message Batches API (`--batch`). */
  readonly batching?: boolean;
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
 * Opt-in exact-result cache config. Call sites pass their prompt version as
 * `keyVersion`, so a changed prompt or output schema misses the cache.
 */
type ExactCacheConfig = {
  keyVersion: string;
  /**
   * Skip the read but still write: the call is answered by the provider and
   * its reply replaces the cached one. For a caller that asks for a fresh
   * answer on purpose (`--regenerate-codebook`).
   */
  refresh?: boolean;
};

/**
 * Every canonical purpose returns a few hundred visible tokens plus thinking.
 * The SDK default for Opus is 128k on a non-streaming request, which invites
 * HTTP timeouts and unbounded spend on a runaway completion.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export type GenerateObjectParams<T extends z.ZodType = z.ZodType> = (
  | { prompt: string; promptPrefix?: never; promptSuffix?: never }
  | { prompt?: never; promptPrefix: string; promptSuffix: string }
) & {
  purpose: LLMPurpose;
  model?: string;
  schema: T;
  /** Thinking effort; absent, the model's default. */
  effort?: ThinkingEffort;
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
  /**
   * Refuse to send a request once estimated spend reaches `maxUsd`. It is
   * checked before each request, so requests already in flight still finish
   * and are billed: concurrency bounds how far past the limit a run can go.
   * Exact-cache hits cost nothing and are still served.
   */
  spendLimit?: { maxUsd: number; spentUsd: () => number };
  /**
   * Send Messages requests through the Message Batches API at half price
   * (see `batch-transport.ts`). With a `database`, submitted requests are
   * recorded so a later run takes a batch's result instead of paying again.
   */
  batch?: BatchTransportSettings;
  /** Network fetch under the provider; tests replace it. */
  fetch?: FetchFunction;
};

export class LLMProviderError extends Error {
  readonly provider = "anthropic";
  readonly classification: LLMProviderErrorClass;
  readonly fatal: boolean;
  /** Raw model text when the provider answered but the reply was unusable. */
  readonly responseText: string | undefined;
  /** True when the reply was cut off at the output-token cap. */
  readonly truncated: boolean;

  constructor(
    message: string,
    classification: LLMProviderErrorClass,
    fatal: boolean,
    options?: { cause?: unknown; responseText?: string; truncated?: boolean },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : {},
    );
    this.name = "LLMProviderError";
    this.classification = classification;
    this.fatal = fatal;
    this.responseText = options?.responseText;
    this.truncated = options?.truncated ?? false;
  }
}

/**
 * The provider answered, but the reply could not be turned into an object:
 * a schema mismatch, or a completion cut off at the token cap. Identical
 * requests are retried at full price for no gain, so these are never retried.
 */
function describeMalformedOutput(error: NoObjectGeneratedError): string {
  if (error.finishReason === "length") {
    return "Model output was truncated at the output-token cap before a complete object was produced";
  }
  return error.message;
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

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function classifyProviderError(error: unknown): {
  classification: LLMProviderErrorClass;
  fatal: boolean;
  message: string;
} {
  // Already classified when it was thrown; reading its message again could
  // only get the class wrong.
  if (error instanceof LLMProviderError) {
    return {
      classification: error.classification,
      fatal: error.fatal,
      message: error.message,
    };
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    return {
      classification: "malformed_output",
      fatal: false,
      message: describeMalformedOutput(error),
    };
  }

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
    // The request itself is wrong (a schema the provider rejects, a bad
    // parameter): every record in the stage would fail the same way.
    return {
      classification: "invalid_request",
      fatal: true,
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

const SHARED_SEED_TEXT_POLICY: PromptCachePolicy = {
  minPromptChars: 4_000,
  cacheControl: { type: "ephemeral", ttl: "5m" },
};

/**
 * Provider prompt caching is prefix-based and charges a write premium on every
 * cached request, so it pays only where many requests share a large prefix.
 * Seed grounding, the seed codebook procedure, and whole-paper adjudication
 * do: the seed text is the same for every family, codebook step, and record
 * of a seed. Codebook tagging shares the seed's codebook across its claims.
 * A request that names no prefix
 * is unique and is never cached.
 */
const DEFAULT_PROMPT_CACHE_POLICIES: Partial<
  Record<LLMPurpose, PromptCachePolicy>
> = {
  "seed-grounding": SHARED_SEED_TEXT_POLICY,
  // The three codebook calls share the seed text; every tagging request of a
  // seed shares its codebook.
  "seed-codebook": SHARED_SEED_TEXT_POLICY,
  "codebook-tagging": SHARED_SEED_TEXT_POLICY,
  adjudication: SHARED_SEED_TEXT_POLICY,
};

/** Cache control for a prefix shared across requests, if its purpose has a policy. */
export function resolvePromptCacheControl(params: {
  purpose: LLMPurpose;
  promptPrefix: string;
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

  if (params.promptPrefix.length < policy.minPromptChars) {
    return undefined;
  }

  return policy.cacheControl;
}

/**
 * Effort for a call site's thinking switch. Every supported model thinks by
 * default, and Opus 5.5 and Sonnet 5.5 cannot be told to stop, so "off" is
 * the lowest effort, which keeps thinking short and skips it on simple
 * requests.
 */
export function resolveThinkingEffort(params: {
  enabled: boolean;
  /** Effort when thinking is on. Defaults to `high`. */
  effort?: ThinkingEffort | undefined;
}): ThinkingEffort {
  return params.enabled ? (params.effort ?? "high") : "low";
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

/** Anthropic providerOptions for a thinking effort. */
export function buildAnthropicThinkingProviderOptions(
  effort?: ThinkingEffort,
):
  | { thinking: { type: "adaptive" }; effort: ThinkingEffort }
  | Record<string, never> {
  return effort ? { thinking: { type: "adaptive" }, effort } : {};
}

export type NormalizedLLMCallProvenance = {
  purpose: LLMPurpose;
  model: string;
  promptVersion: string;
  effort?: ThinkingEffort;
  cachePolicy: ExactCacheAccessPolicy;
  promptCachePolicy: string;
};

/** Compact request provenance for adapter-normalized model executions. */
export function buildNormalizedLLMCallProvenance(params: {
  purpose: LLMPurpose;
  model: string;
  promptVersion: string;
  effort?: ThinkingEffort | undefined;
  forceRefresh?: boolean | undefined;
  promptCacheControl?: PromptCacheControl | undefined;
}): NormalizedLLMCallProvenance {
  return {
    purpose: params.purpose,
    model: params.model,
    promptVersion: params.promptVersion,
    ...(params.effort != null ? { effort: params.effort } : {}),
    cachePolicy: params.forceRefresh === true ? "bypass" : "allow",
    promptCachePolicy: promptCachePolicyKey(params.promptCacheControl),
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

/**
 * A batch can sit in the queue longer than five minutes, so the cache entry a
 * seed's first request writes would expire before the rest of the seed's
 * requests run, and each would pay full input for the seed text. Batched
 * shared prefixes are therefore written with the one-hour TTL.
 */
const BATCH_PROMPT_CACHE_TTL = "1h" as const;

/**
 * The cache control a request with this shared prefix is actually sent with.
 * Call provenance uses it too, so the recorded TTL is the one the provider saw.
 */
export function resolveSentPromptCacheControl(params: {
  purpose: LLMPurpose;
  promptPrefix: string;
  options?: PromptCachingOptions | undefined;
  batching?: boolean | undefined;
}): PromptCacheControl | undefined {
  const policy = resolvePromptCacheControl({
    purpose: params.purpose,
    promptPrefix: params.promptPrefix,
    options: params.options,
  });
  return policy && params.batching === true
    ? { ...policy, ttl: BATCH_PROMPT_CACHE_TTL }
    : policy;
}

function buildModelCallInput(params: {
  request: PromptShapedRequest;
  promptCaching?: PromptCachingOptions | undefined;
  batching?: boolean;
}):
  | { prompt: string; messages?: never; cacheControl?: never }
  | {
      prompt?: never;
      messages: [
        {
          role: "user";
          content: [CachedPrefixTextPart, CachedPrefixTextPart];
        },
      ];
      /** Cache control on the shared prefix, if it is cached. */
      cacheControl: PromptCacheControl | undefined;
    } {
  const request = params.request;
  if (hasPromptPrefix(request)) {
    const cacheControl = resolveSentPromptCacheControl({
      purpose: request.purpose,
      promptPrefix: request.promptPrefix,
      options: params.promptCaching,
      batching: params.batching,
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
      cacheControl,
    };
  }

  // Either shape is present by construction; the union that reaches here has
  // already been narrowed by `hasPromptPrefix`.
  return { prompt: request.prompt ?? "" };
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

/** Characters per token for an expected, not worst-case, input estimate. */
const RESERVATION_CHARS_PER_TOKEN = 4;
/** Schema, framing, and system tokens a prompt's characters do not count. */
const RESERVATION_OVERHEAD_TOKENS = 300;
/**
 * Output reserved before any call of a purpose and model has finished, and
 * the least ever reserved after. Measured means are 345-540 tokens per call.
 */
const RESERVATION_MIN_OUTPUT_TOKENS = 2_000;
/** Output reserved as a multiple of the mean seen so far. */
const RESERVATION_OUTPUT_MEAN_MULTIPLIER = 2;

/**
 * What a batched request is expected to cost, reserved against the spend
 * limit when it is queued and released when its real cost is recorded. A
 * whole stage is queued before anything is billed, so without a reservation
 * the limit could not hold; a worst-case one (every output at its cap) would
 * stop a large stage far below its real cost.
 *
 * A shared prefix is priced as a cache read, except the first request seen
 * for it, which writes the cache. The rest of the prompt is uncached input.
 * Output is twice the mean of completed calls of the same purpose and model,
 * never under 2,000 tokens nor over the request's cap. The limit can still be
 * passed if real outputs average well above that.
 */
export function estimateExpectedRequestUsd(params: {
  model: string;
  /** Characters of a cached shared prefix; 0 when none is cached. */
  cachedPrefixChars: number;
  /** How the cached prefix is billed on this request. */
  prefixBilling: "read" | "write_5m" | "write_1h";
  /** Characters sent as uncached input. */
  uncachedChars: number;
  outputTokens: number;
  batch: boolean;
}): number {
  const prefixTokens = Math.ceil(
    params.cachedPrefixChars / RESERVATION_CHARS_PER_TOKEN,
  );
  const uncachedTokens =
    Math.ceil(params.uncachedChars / RESERVATION_CHARS_PER_TOKEN) +
    RESERVATION_OVERHEAD_TOKENS;
  return estimateAnthropicUsd(
    params.model,
    {
      inputTokens: prefixTokens + uncachedTokens,
      noCacheInputTokens: uncachedTokens,
      outputTokens: params.outputTokens,
      ...(params.prefixBilling === "read"
        ? { cacheReadTokens: prefixTokens }
        : params.prefixBilling === "write_1h"
          ? { cacheCreation: { ephemeral1hInputTokens: prefixTokens } }
          : { cacheCreation: { ephemeral5mInputTokens: prefixTokens } }),
    },
    { batch: params.batch },
  );
}

/** Output tokens to reserve, given the calls of a purpose and model so far. */
export function reservedOutputTokens(params: {
  maxOutputTokens: number;
  completedCalls: number;
  completedOutputTokens: number;
}): number {
  const mean =
    params.completedCalls > 0
      ? params.completedOutputTokens / params.completedCalls
      : 0;
  return Math.min(
    params.maxOutputTokens,
    Math.max(
      RESERVATION_MIN_OUTPUT_TOKENS,
      Math.ceil(RESERVATION_OUTPUT_MEAN_MULTIPLIER * mean),
    ),
  );
}

function transportFromHeaders(
  headers: Record<string, string> | undefined,
): LLMTransport {
  return headers?.[TRANSPORT_HEADER] === "batch" ? "batch" : "direct";
}

export function createLLMClient(options: CreateLLMClientOptions): LLMClient {
  const db = options.database;
  const batching = options.batch != null;
  const providerFetch = batching
    ? createBatchTransport({
        ...options.batch,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(db ? { store: createSqliteBatchRequestStore(db) } : {}),
      }).fetch
    : options.fetch;
  const anthropic = createAnthropic({
    apiKey: options.apiKey,
    ...(providerFetch ? { fetch: providerFetch } : {}),
  });
  const defaultModel = options.defaultModel ?? "claude-sonnet-5-5";
  const calls: LLMCallRecord[] = [];
  const forceRefresh = options.forceRefresh ?? false;
  /** Expected cost of batched requests sent but not yet recorded. */
  let reservedUsd = 0;
  /** Output of completed calls, per purpose and model, for reservations. */
  const outputSeen = new Map<string, { calls: number; tokens: number }>();
  /** Shared prefixes some request has already been reserved to write. */
  const prefixesSeen = new Set<string>();

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
          classification.classification === "malformed_output"
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
    effort?: ThinkingEffort,
  ): LLMCallRecord {
    const record: LLMCallRecord = {
      purpose,
      model: modelId,
      ...(context.stageKey != null ? { stageKey: context.stageKey } : {}),
      attempted: true,
      successful: true,
      failed: false,
      billable: false,
      ...(effort != null ? { thinkingEffort: effort } : {}),
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

  type ProviderUsage = {
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
  };

  /** Token counts and cost as the provider billed them, success or not. */
  function usageFields(
    modelId: string,
    usage: ProviderUsage | undefined,
    transport: LLMTransport,
  ): Pick<
    LLMCallRecord,
    | "billable"
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "estimatedCostUsd"
    | "reasoningTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
  > {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const reasoningTokens = usage?.outputTokenDetails?.reasoningTokens;
    const noCacheInputTokens = usage?.inputTokenDetails?.noCacheTokens;
    const cacheReadTokens = usage?.inputTokenDetails?.cacheReadTokens;
    const cacheWriteTokens = usage?.inputTokenDetails?.cacheWriteTokens;
    const cacheCreation = extractCacheCreationFromRawUsage(usage?.raw);
    const totalBillableTokens = inputTokens + outputTokens;
    return {
      billable: totalBillableTokens > 0,
      inputTokens,
      outputTokens,
      totalTokens: usage?.totalTokens ?? totalBillableTokens,
      estimatedCostUsd: estimateAnthropicUsd(
        modelId,
        {
          inputTokens,
          ...(noCacheInputTokens != null ? { noCacheInputTokens } : {}),
          outputTokens,
          reasoningTokens: reasoningTokens ?? 0,
          cacheReadTokens: cacheReadTokens ?? 0,
          cacheWriteTokens: cacheWriteTokens ?? 0,
          ...(cacheCreation ? { cacheCreation } : {}),
        },
        { batch: transport === "batch" },
      ),
      ...(reasoningTokens != null ? { reasoningTokens } : {}),
      ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens != null ? { cacheWriteTokens } : {}),
    };
  }

  function buildRecord(
    purpose: LLMPurpose,
    modelId: string,
    context: LLMCallContext,
    servedModel: string | undefined,
    usage: ProviderUsage,
    latencyMs: number,
    finishReason: string,
    transport: LLMTransport,
    effort?: ThinkingEffort,
  ): LLMCallRecord {
    const record: LLMCallRecord = {
      purpose,
      model: modelId,
      ...(servedModel != null && servedModel.length > 0 ? { servedModel } : {}),
      ...(context.stageKey != null ? { stageKey: context.stageKey } : {}),
      attempted: true,
      successful: true,
      failed: false,
      ...(effort != null ? { thinkingEffort: effort } : {}),
      ...usageFields(modelId, usage, transport),
      transport,
      latencyMs,
      finishReason,
      ...(finishReason === "length" ? { truncated: true } : {}),
      timestamp: new Date().toISOString(),
    };
    registerRecord(record);
    const key = `${purpose}\0${modelId}`;
    const seen = outputSeen.get(key) ?? { calls: 0, tokens: 0 };
    outputSeen.set(key, {
      calls: seen.calls + 1,
      tokens: seen.tokens + record.outputTokens,
    });
    return record;
  }

  function buildFailureRecord(params: {
    purpose: LLMPurpose;
    modelId: string;
    context: LLMCallContext;
    latencyMs: number;
    effort?: ThinkingEffort;
    error: unknown;
  }): LLMCallRecord {
    const provider = classifyProviderError(params.error);
    // A malformed reply was still generated and billed; record what it cost.
    const generated = NoObjectGeneratedError.isInstance(params.error)
      ? params.error
      : undefined;
    const servedModel = generated?.response?.modelId;
    const finishReason = generated?.finishReason ?? "error";
    // Only a reply that arrived says how it came; a refused request has no
    // usage to price either way.
    const transport = generated
      ? transportFromHeaders(generated.response?.headers)
      : undefined;
    const record: LLMCallRecord = {
      purpose: params.purpose,
      model: params.modelId,
      ...(servedModel != null && servedModel.length > 0 ? { servedModel } : {}),
      ...(params.context.stageKey != null
        ? { stageKey: params.context.stageKey }
        : {}),
      attempted: true,
      successful: false,
      failed: true,
      ...(params.effort != null ? { thinkingEffort: params.effort } : {}),
      ...usageFields(params.modelId, generated?.usage, transport ?? "direct"),
      ...(transport != null ? { transport } : {}),
      latencyMs: params.latencyMs,
      finishReason,
      ...(finishReason === "length" ? { truncated: true } : {}),
      timestamp: new Date().toISOString(),
      providerErrorClass: provider.classification,
      errorMessage: provider.message,
    };
    registerRecord(record);
    return record;
  }

  return {
    async generateObject<T extends z.ZodType>(
      params: GenerateObjectParams<T>,
    ): Promise<GenerateObjectResult<z.infer<T>>> {
      const modelId = params.model ?? defaultModel;
      const context = { ...options.defaultContext, ...params.context };

      const sf = schemaFingerprint(params.schema);
      const promptInput = buildModelCallInput({
        request: params,
        promptCaching: options.promptCaching,
        batching,
      });
      const cacheAccessPolicy: ExactCacheAccessPolicy = forceRefresh
        ? "bypass"
        : "allow";
      const cacheKeyInput = {
        purpose: params.purpose,
        model: modelId,
        prompt: resolveFullPrompt(params),
        effort: params.effort ?? "",
        keyVersion: params.exactCache?.keyVersion ?? "",
        schemaFingerprint: sf,
        cachePolicy: cacheAccessPolicy,
      };

      // --- Exact-result cache lookup ---
      if (
        db &&
        params.exactCache &&
        !forceRefresh &&
        !params.exactCache.refresh
      ) {
        const cached = getCachedLLMResult(
          db,
          computeLLMCacheKey(cacheKeyInput),
        );
        // A row written under an older schema, or a corrupt one, must not
        // pass as a fresh reply: re-validate and fall through on failure.
        const parsed = cached
          ? params.schema.safeParse(parseJsonOrUndefined(cached.responseText))
          : undefined;
        if (parsed?.success) {
          const record = buildCacheHitRecord(
            params.purpose,
            modelId,
            context,
            params.effort,
          );
          return { object: parsed.data as z.infer<T>, record };
        }
      }

      const maxOutputTokens =
        params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const limit = options.spendLimit;
      // Direct requests are checked against what has been billed. Batched
      // ones are all queued before any is billed, so each also reserves its
      // ceiling cost until its real cost is recorded.
      let reservation = 0;
      if (limit && batching) {
        const cachedPrefix =
          promptInput.cacheControl != null && params.promptPrefix != null
            ? params.promptPrefix
            : undefined;
        let prefixBilling: "read" | "write_5m" | "write_1h" = "read";
        if (cachedPrefix != null) {
          const prefixKey = createHash("sha256")
            .update(`${modelId}\0${cachedPrefix}`)
            .digest("hex");
          if (!prefixesSeen.has(prefixKey)) {
            prefixesSeen.add(prefixKey);
            prefixBilling =
              promptInput.cacheControl?.ttl === "1h" ? "write_1h" : "write_5m";
          }
        }
        const seen = outputSeen.get(`${params.purpose}\0${modelId}`);
        reservation = estimateExpectedRequestUsd({
          model: modelId,
          cachedPrefixChars: cachedPrefix?.length ?? 0,
          prefixBilling,
          uncachedChars:
            resolveFullPrompt(params).length - (cachedPrefix?.length ?? 0),
          outputTokens: reservedOutputTokens({
            maxOutputTokens,
            completedCalls: seen?.calls ?? 0,
            completedOutputTokens: seen?.tokens ?? 0,
          }),
          batch: true,
        });
      }
      if (limit) {
        const spent = limit.spentUsd();
        if (spent >= limit.maxUsd) {
          throw new LLMProviderError(
            `Spend limit reached: estimated $${spent.toFixed(2)} of $${limit.maxUsd.toFixed(2)}, so no further model requests are sent`,
            "spend_limit",
            true,
          );
        }
        if (spent + reservedUsd + reservation > limit.maxUsd) {
          throw new LLMProviderError(
            `Spend limit reached: estimated $${spent.toFixed(2)} spent and an expected $${(reservedUsd + reservation).toFixed(2)} queued in batches would pass $${limit.maxUsd.toFixed(2)}, so no further model requests are sent`,
            "spend_limit",
            true,
          );
        }
      }
      reservedUsd += reservation;

      const startMs = Date.now();
      const anthropicProviderOptions = buildAnthropicThinkingProviderOptions(
        params.effort,
      );
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
              maxOutputTokens,
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
          transportFromHeaders(result.response?.headers),
          params.effort,
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
          ...(params.effort != null ? { effort: params.effort } : {}),
          error,
        });
        const provider = classifyProviderError(error);
        const generated = NoObjectGeneratedError.isInstance(error)
          ? error
          : undefined;
        throw new LLMProviderError(
          provider.message,
          provider.classification,
          provider.fatal,
          {
            cause: error,
            ...(generated?.text != null
              ? { responseText: generated.text }
              : {}),
            truncated: generated?.finishReason === "length",
          },
        );
      } finally {
        reservedUsd -= reservation;
      }
    },

    getLedger: () => buildLedger(calls),
    batching,
  };
}
