import { describe, expect, it } from "vitest";

import { estimateAnthropicUsd } from "../../src/shared/anthropic-token-cost.js";

describe("estimateAnthropicUsd", () => {
  it("uses opus-4-6 list rates", () => {
    const usd = estimateAnthropicUsd("claude-opus-4-6", 1_000_000, 100_000);
    expect(usd).toBe(5 * 1 + 25 * 0.1);
  });
});
