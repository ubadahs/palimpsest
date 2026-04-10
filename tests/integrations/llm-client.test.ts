import { describe, expect, it } from "vitest";

import { resolvePromptCacheControl } from "../../src/integrations/llm-client.js";

describe("resolvePromptCacheControl", () => {
  it("enables default caching for large seed-grounding prompts", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "seed-grounding",
      prompt: "x".repeat(5_000),
    });

    expect(cacheControl).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("skips caching for short prompts even on cacheable purposes", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "seed-grounding",
      prompt: "short prompt",
    });

    expect(cacheControl).toBeUndefined();
  });

  it("does not cache purposes without a default policy", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "claim-discovery",
      prompt: "x".repeat(10_000),
    });

    expect(cacheControl).toBeUndefined();
  });

  it("leaves evidence reranking uncached by default", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "evidence-rerank",
      prompt: "x".repeat(10_000),
    });

    expect(cacheControl).toBeUndefined();
  });

  it("leaves adjudication uncached by default", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "adjudication",
      prompt: "x".repeat(10_000),
    });

    expect(cacheControl).toBeUndefined();
  });

  it("respects custom per-purpose overrides", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "claim-discovery",
      prompt: "x".repeat(600),
      options: {
        byPurpose: {
          "claim-discovery": {
            minPromptChars: 500,
            cacheControl: { type: "ephemeral", ttl: "1h" },
          },
        },
      },
    });

    expect(cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
