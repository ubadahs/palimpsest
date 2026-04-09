import { describe, expect, it } from "vitest";

import { estimateAnthropicUsd } from "../../src/shared/anthropic-token-cost.js";

describe("estimateAnthropicUsd", () => {
  it("uses opus-4-6 list rates", () => {
    const usd = estimateAnthropicUsd("claude-opus-4-6", 1_000_000, 100_000);
    expect(usd).toBe(5 * 1 + 25 * 0.1);
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
