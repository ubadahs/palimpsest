import { describe, expect, it } from "vitest";
import { providerConfigSchema } from "../../src/evaluation/config.js";
import { callCostUsd } from "../../src/evaluation/cost.js";
import { estimateAnthropicUsd } from "../../src/shared/anthropic-token-cost.js";

describe("call pricing", () => {
  const usage = {
    inputTokens: 1_200_000,
    promptCacheReadTokens: 1_000_000,
    promptCacheWriteTokens: 100_000,
    outputTokens: 100_000,
  };
  const prices = {
    id: "p",
    kind: "anthropic",
    model: "m",
    pricePerMillionInputTokensUsd: 4,
    pricePerMillionOutputTokensUsd: 20,
  };

  it("charges cache reads at the provider's own rate when it states one", () => {
    const stated = providerConfigSchema.parse({
      ...prices,
      pricePerMillionCacheReadTokensUsd: 0.2,
    });
    expect(callCostUsd(usage, stated)).toBeCloseTo(0.4 + 0.2 + 0.5 + 2);
    expect(callCostUsd(usage, providerConfigSchema.parse(prices))).toBeCloseTo(
      0.4 + 0.4 + 0.5 + 2,
    );
  });

  it("prices an Anthropic provider that states none from the shared table", () => {
    const sonnet = providerConfigSchema.parse({
      id: "p",
      kind: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(callCostUsd(usage, sonnet)).toBeCloseTo(
      estimateAnthropicUsd("claude-sonnet-5-5", {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.promptCacheReadTokens,
        cacheWriteTokens: usage.promptCacheWriteTokens,
      }),
    );
  });

  it("gives no cost when prices or usage are unknown", () => {
    for (const unpriced of [
      { id: "p", kind: "anthropic", model: "m" },
      { id: "p", kind: "jev", model: "claude-sonnet-5-5" },
    ])
      expect(
        callCostUsd(usage, providerConfigSchema.parse(unpriced)),
      ).toBeNull();
    expect(
      callCostUsd({ latencyMs: 5 }, providerConfigSchema.parse(prices)),
    ).toBeNull();
  });
});
