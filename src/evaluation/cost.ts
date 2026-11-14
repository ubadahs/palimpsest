/**
 * What an evaluation call cost. A provider's stated prices win, so a saved
 * experiment keeps the prices it ran at; an Anthropic provider that states
 * none is priced from the shared table, as production is. Either way the
 * cache rules are production's.
 */
import { z } from "zod";
import {
  costAtPriceUsd,
  listedClaudePrice,
  type ModelPrice,
} from "../shared/anthropic-token-cost.js";
import type { ProviderConfig } from "./config.js";

const callUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  promptCacheReadTokens: z.number().optional(),
  promptCacheWriteTokens: z.number().optional(),
});

function providerPrice(provider: ProviderConfig): ModelPrice | undefined {
  const input = provider.pricePerMillionInputTokensUsd;
  const output = provider.pricePerMillionOutputTokensUsd;
  const cacheRead = provider.pricePerMillionCacheReadTokensUsd;
  if (input != null && output != null)
    return { input, output, ...(cacheRead != null ? { cacheRead } : {}) };
  return provider.kind === "anthropic"
    ? listedClaudePrice(provider.model)
    : undefined;
}

/** Null when the call's token usage or the provider's price is unknown. */
export function callCostUsd(
  call: unknown,
  provider: ProviderConfig,
): number | null {
  const usage = callUsageSchema.safeParse(call);
  const price = providerPrice(provider);
  if (!usage.success || !price) return null;
  return costAtPriceUsd(price, {
    inputTokens: usage.data.inputTokens,
    outputTokens: usage.data.outputTokens,
    cacheReadTokens: usage.data.promptCacheReadTokens ?? 0,
    cacheWriteTokens: usage.data.promptCacheWriteTokens ?? 0,
  });
}

export function priceCall<T extends object>(
  call: T,
  provider: ProviderConfig,
): T & { costUsd?: number } {
  const costUsd = callCostUsd(call, provider);
  return costUsd == null ? call : { ...call, costUsd };
}
