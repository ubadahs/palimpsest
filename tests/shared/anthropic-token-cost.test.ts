import { describe, expect, it } from "vitest";

import { estimateAnthropicUsd } from "../../src/shared/anthropic-token-cost.js";

describe("estimateAnthropicUsd", () => {
  it("uses opus-4-6 list rates", () => {
    const usd = estimateAnthropicUsd("claude-opus-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    expect(usd).toBe(5 * 1 + 25 * 0.1);
  });

  it("uses the current list rates, including each model's cache-read rate", () => {
    const usage = {
      inputTokens: 2_000_000,
      noCacheInputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 100_000,
    };
    expect(estimateAnthropicUsd("claude-opus-5-5", usage)).toBeCloseTo(
      4 + 0.2 + 20 * 0.1,
    );
    expect(estimateAnthropicUsd("claude-fable-5-2", usage)).toBeCloseTo(
      8 + 0.2 + 40 * 0.1,
    );
    expect(estimateAnthropicUsd("claude-sonnet-5-5", usage)).toBeCloseTo(
      2 + 0.1 + 10 * 0.1,
    );
    expect(estimateAnthropicUsd("claude-haiku-5-5", usage)).toBeCloseTo(
      0.1 + 0.01 + 0.5 * 0.1,
    );
  });

  it("prices cache reads and writes separately from uncached input", () => {
    const usd = estimateAnthropicUsd("claude-sonnet-4-6", {
      inputTokens: 1_000,
      noCacheInputTokens: 700,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      outputTokens: 300,
    });

    expect(usd).toBe(
      (700 * 3 + 200 * 3 * 0.1 + 100 * 3 * 1.25 + 300 * 15) / 1_000_000,
    );
  });

  it("uses explicit cache creation ttl breakdown when available", () => {
    const usd = estimateAnthropicUsd("claude-haiku-4-5", {
      inputTokens: 1_000,
      noCacheInputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
      cacheCreation: {
        ephemeral5mInputTokens: 100,
        ephemeral1hInputTokens: 200,
      },
      outputTokens: 50,
    });

    expect(usd).toBe(
      (500 * 1 + 200 * 1 * 0.1 + 100 * 1 * 1.25 + 200 * 1 * 2 + 50 * 5) /
        1_000_000,
    );
  });

  it("does not double count reasoning tokens when total output is already provided", () => {
    const usd = estimateAnthropicUsd("claude-opus-4-6", {
      inputTokens: 100,
      outputTokens: 400,
      reasoningTokens: 250,
    });

    expect(usd).toBe((100 * 5 + 400 * 25) / 1_000_000);
  });
});
