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

/**
 * Rough USD cost from token usage (unknown models default to Sonnet-like rates).
 */
export function estimateAnthropicUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING_USD_PER_MILLION[model] ?? { input: 3, output: 15 };
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
