/** USD per 1M tokens (approximate list pricing; treat as estimates only). */
const PRICING_USD_PER_MILLION: Record<
  string,
  { input: number; output: number }
> = {
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

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
 * Rough USD cost from token usage (unknown models default to Sonnet-like rates).
 *
 * Supports both the legacy `(model, inputTokens, outputTokens)` call shape and a
 * richer Anthropic-aware token breakdown with cache and reasoning fields.
 */
export function estimateAnthropicUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number;
export function estimateAnthropicUsd(
  model: string,
  usage: AnthropicTokenCostUsage,
): number;

export function estimateAnthropicUsd(
  model: string,
  inputTokensOrUsage: number | AnthropicTokenCostUsage,
  outputTokens = 0,
): number {
  const price = PRICING_USD_PER_MILLION[model] ?? { input: 3, output: 15 };

  if (typeof inputTokensOrUsage === "number") {
    return (
      (inputTokensOrUsage * price.input + outputTokens * price.output) /
      1_000_000
    );
  }

  const usage = inputTokensOrUsage;
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
    cacheReadTokens * price.input * CACHE_READ_MULTIPLIER +
    (cacheWrite5mTokens + remainingAggregateWriteTokens) *
      price.input *
      CACHE_WRITE_5M_MULTIPLIER +
    cacheWrite1hTokens * price.input * CACHE_WRITE_1H_MULTIPLIER;

  const outputCost = billedOutputTokens * price.output;

  return (inputCost + outputCost) / 1_000_000;
}
