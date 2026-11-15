export const ANTHROPIC_PRICING_VERSION = "palimpsest-anthropic-rates-v1";
/** The models a run can name. Each supports adaptive thinking with an effort. */
export const claudeModelValues = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;
export type ClaudeModel = (typeof claudeModelValues)[number];

/** USD per 1M tokens; cache reads default to a tenth of input. */
export type ModelPrice = { input: number; output: number; cacheRead?: number };

/**
 * USD per 1M tokens (approximate list pricing; treat as estimates only). From
 * the 5.5 models on, cache reads cost less than a tenth of input.
 */
const PRICING_USD_PER_MILLION: Record<ClaudeModel, ModelPrice> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  // Haiku 5.5 rates for prompts up to 100K tokens.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/** The table's price for a model, if the table names it. */
export function listedClaudePrice(model: string): ModelPrice | undefined {
  return (PRICING_USD_PER_MILLION as Record<string, ModelPrice | undefined>)[
    model.replace(/-\d{8}$/, "")
  ];
}

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
/** The Message Batches API bills every token class at half the list price. */
const BATCH_MULTIPLIER = 0.5;

export type AnthropicTokenCostUsage = {
  /** Total billed input tokens, including uncached, cache reads, and cache writes. */
  inputTokens: number;
  /** Optional uncached input token count when available from the provider. */
  noCacheInputTokens?: number;
  /** Total billed output tokens. If reasoning is included, do not add it again. */
  outputTokens: number;
  /** Optional separate reasoning token count for telemetry/fallback calculations. */
  reasoningTokens?: number;
  /** Cache-hit input tokens. */
  cacheReadTokens?: number;
  /**
   * Aggregate cache-write tokens when detailed TTL breakdown is unavailable.
   * We conservatively assume Anthropic's default 5-minute TTL pricing.
   */
  cacheWriteTokens?: number;
  /**
   * Optional detailed cache-write breakdown from Anthropic usage when
   * available. These take precedence over the aggregate cacheWriteTokens.
   */
  cacheCreation?: {
    ephemeral5mInputTokens?: number;
    ephemeral1hInputTokens?: number;
  };
};

/**
 * Rough USD cost from Anthropic token usage. Accepts cache and reasoning breakdown fields. With
 * `batch`, the call was answered through the Message Batches API. Unknown model prices are excluded from the known subtotal.
 */
export function estimateAnthropicUsd(
  model: string,
  usage: AnthropicTokenCostUsage,
  options?: { batch?: boolean },
): number {
  const price = listedClaudePrice(model);
  // Unknown prices contribute nothing to the known subtotal; the call's
  // billingStatus must remain unknown, never "free".
  if (!price) return 0;
  return costAtPriceUsd(price, usage, options);
}

/** USD cost of token usage at the given price, cache and batch rules included. */
export function costAtPriceUsd(
  price: ModelPrice,
  usage: AnthropicTokenCostUsage,
  options?: { batch?: boolean },
): number {
  const reasoningTokens = usage.reasoningTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const cacheWrite5mTokens = usage.cacheCreation?.ephemeral5mInputTokens ?? 0;
  const cacheWrite1hTokens = usage.cacheCreation?.ephemeral1hInputTokens ?? 0;

  // If Anthropic provides a TTL-specific write breakdown, prefer it and treat
  // any remaining aggregate write tokens as default 5-minute cache writes.
  const remainingAggregateWriteTokens = Math.max(
    0,
    cacheWriteTokens - cacheWrite5mTokens - cacheWrite1hTokens,
  );

  const totalCacheWriteTokens =
    cacheWrite5mTokens + cacheWrite1hTokens + remainingAggregateWriteTokens;
  const uncachedInputTokens =
    usage.noCacheInputTokens ??
    Math.max(0, usage.inputTokens - cacheReadTokens - totalCacheWriteTokens);
  const billedOutputTokens =
    usage.outputTokens > 0 ? usage.outputTokens : reasoningTokens;

  const inputCost =
    uncachedInputTokens * price.input +
    cacheReadTokens * (price.cacheRead ?? price.input * CACHE_READ_MULTIPLIER) +
    (cacheWrite5mTokens + remainingAggregateWriteTokens) *
      price.input *
      CACHE_WRITE_5M_MULTIPLIER +
    cacheWrite1hTokens * price.input * CACHE_WRITE_1H_MULTIPLIER;

  const outputCost = billedOutputTokens * price.output;

  const multiplier = options?.batch === true ? BATCH_MULTIPLIER : 1;
  return ((inputCost + outputCost) * multiplier) / 1_000_000;
}
