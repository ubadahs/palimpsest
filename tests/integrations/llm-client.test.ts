import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

import { generateText } from "ai";
import {
  buildAnthropicThinkingProviderOptions,
  buildNormalizedLLMCallProvenance,
  createLLMClient,
  modelSupportsAdaptiveThinking,
  resolvePromptCacheControl,
  resolveThinkingConfig,
  schemaFingerprint,
  thinkingConfigKey,
  type LLMRunLedger,
} from "../../src/integrations/llm-client.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import {
  computeLLMCacheKey,
  storeLLMResult,
} from "../../src/storage/llm-result-cache.js";

const generateTextMock = vi.mocked(generateText);

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

  it("caches evidence reranking prompts over 2KB by default", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "evidence-rerank",
      prompt: "x".repeat(10_000),
    });

    expect(cacheControl).toBeDefined();
  });

  it("caches adjudication prompts over 5KB by default", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "adjudication",
      prompt: "x".repeat(10_000),
    });

    expect(cacheControl).toBeDefined();
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

describe("adaptive vs legacy thinking helpers", () => {
  it("detects Sonnet/Opus 4.6+ adaptive support", () => {
    expect(modelSupportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
    expect(modelSupportsAdaptiveThinking("claude-opus-4-6")).toBe(true);
    expect(modelSupportsAdaptiveThinking("claude-opus-4-7")).toBe(true);
    expect(modelSupportsAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
    expect(modelSupportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
  });

  it("resolves adaptive+effort for 4.6+ and fixed budget for older models", () => {
    expect(
      resolveThinkingConfig({
        model: "claude-sonnet-4-6",
        enabled: true,
        budgetTokens: 10_000,
      }),
    ).toEqual({ type: "adaptive", effort: "high" });

    expect(
      resolveThinkingConfig({
        model: "claude-opus-4-6",
        enabled: true,
        effort: "medium",
        budgetTokens: 12_000,
      }),
    ).toEqual({ type: "adaptive", effort: "medium" });

    expect(
      resolveThinkingConfig({
        model: "claude-haiku-4-5",
        enabled: true,
        budgetTokens: 8_000,
      }),
    ).toEqual({ type: "enabled", budgetTokens: 8_000 });

    expect(
      resolveThinkingConfig({
        model: "claude-sonnet-4-6",
        enabled: false,
        budgetTokens: 10_000,
      }),
    ).toBeUndefined();
  });

  it("builds Anthropic provider options for adaptive and legacy modes", () => {
    expect(
      buildAnthropicThinkingProviderOptions({
        type: "adaptive",
        effort: "high",
      }),
    ).toEqual({
      thinking: { type: "adaptive" },
      effort: "high",
    });

    expect(
      buildAnthropicThinkingProviderOptions({
        type: "enabled",
        budgetTokens: 8_000,
      }),
    ).toEqual({
      thinking: { type: "enabled", budgetTokens: 8_000 },
    });

    expect(buildAnthropicThinkingProviderOptions(undefined)).toEqual({});
  });

  it("encodes thinking into distinct cache-key material", () => {
    expect(thinkingConfigKey({ type: "adaptive", effort: "high" })).toBe(
      "adaptive:high",
    );
    expect(thinkingConfigKey({ type: "enabled", budgetTokens: 10_000 })).toBe(
      "enabled:10000",
    );
    expect(thinkingConfigKey(undefined)).toBe("");

    const base = {
      purpose: "seed-grounding" as const,
      model: "claude-sonnet-4-6",
      prompt: "ground this claim",
      keyVersion: "grounding-2026-07-17-v1",
      promptCachePolicy: "ephemeral:5m",
      cachePolicy: "allow",
    };
    const adaptiveKey = computeLLMCacheKey({
      ...base,
      thinkingConfig: "adaptive:high",
    });
    const legacyKey = computeLLMCacheKey({
      ...base,
      thinkingConfig: "enabled:10000",
    });
    const bypassKey = computeLLMCacheKey({
      ...base,
      thinkingConfig: "adaptive:high",
      cachePolicy: "bypass",
    });

    expect(adaptiveKey).not.toBe(legacyKey);
    expect(adaptiveKey).not.toBe(bypassKey);
  });

  it("records complete normalized request provenance", () => {
    const provenance = buildNormalizedLLMCallProvenance({
      purpose: "seed-grounding",
      model: "claude-sonnet-4-6",
      promptVersion: "2026-07-17-v1",
      thinking: { type: "adaptive", effort: "high" },
      exactCacheKeyVersion: "grounding-2026-07-17-v1",
      forceRefresh: false,
      promptCacheControl: { type: "ephemeral", ttl: "5m" },
    });

    expect(provenance).toEqual({
      purpose: "seed-grounding",
      model: "claude-sonnet-4-6",
      promptVersion: "2026-07-17-v1",
      thinking: { mode: "adaptive", effort: "high" },
      exactCacheKeyVersion: "grounding-2026-07-17-v1",
      cachePolicy: "allow",
      promptCachePolicy: "ephemeral:5m",
    });

    expect(
      buildNormalizedLLMCallProvenance({
        purpose: "attributed-claim-extraction",
        model: "claude-haiku-4-5",
        promptVersion: "2026-07-17-v2",
        thinking: { type: "enabled", budgetTokens: 8_000 },
        exactCacheKeyVersion: "extraction-2026-07-17-v2",
        forceRefresh: true,
      }),
    ).toMatchObject({
      thinking: { mode: "enabled", budgetTokens: 8_000 },
      cachePolicy: "bypass",
      promptCachePolicy: "",
    });
  });
});

describe("provider options and telemetry through generateText", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        outputTokenDetails: { reasoningTokens: 3 },
      },
    } as never);
  });

  it("passes adaptive thinking + effort in Anthropic providerOptions", async () => {
    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: "claude-sonnet-4-6",
    });

    const result = await client.generateText({
      purpose: "seed-grounding",
      prompt: "short",
      thinking: { type: "adaptive", effort: "high" },
    });

    expect(generateTextMock).toHaveBeenCalledOnce();
    const call = generateTextMock.mock.calls[0]![0] as {
      providerOptions?: {
        anthropic?: {
          thinking?: { type: string; budgetTokens?: number };
          effort?: string;
        };
      };
    };
    expect(call.providerOptions?.anthropic).toEqual({
      thinking: { type: "adaptive" },
      effort: "high",
    });
    expect(result.record.thinkingEnabled).toBe(true);
    expect(result.record.thinkingType).toBe("adaptive");
    expect(result.record.thinkingEffort).toBe("high");
    expect(result.record.thinkingBudgetTokens).toBeUndefined();
    expect(result.record.reasoningTokens).toBe(3);
  });

  it("passes legacy fixed-budget thinking for older models", async () => {
    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: "claude-haiku-4-5",
    });

    const result = await client.generateText({
      purpose: "attributed-claim-extraction",
      prompt: "short",
      thinking: { type: "enabled", budgetTokens: 8_000 },
    });

    const call = generateTextMock.mock.calls[0]![0] as {
      providerOptions?: {
        anthropic?: {
          thinking?: { type: string; budgetTokens?: number };
          effort?: string;
        };
      };
    };
    expect(call.providerOptions?.anthropic).toEqual({
      thinking: { type: "enabled", budgetTokens: 8_000 },
    });
    expect(result.record.thinkingType).toBe("enabled");
    expect(result.record.thinkingBudgetTokens).toBe(8_000);
    expect(result.record.thinkingEffort).toBeUndefined();
  });

  it("includes thinking mode in exact-cache key material", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const adaptiveKey = computeLLMCacheKey({
      purpose: "seed-grounding",
      model: "claude-sonnet-4-6",
      prompt: "ground",
      thinkingConfig: "adaptive:high",
      keyVersion: "v1",
      promptCachePolicy: "",
      cachePolicy: "allow",
    });
    storeLLMResult(db, {
      cacheKey: adaptiveKey,
      purpose: "seed-grounding",
      model: "claude-sonnet-4-6",
      keyVersion: "v1",
      responseText: "from-adaptive-cache",
      createdAt: "2026-07-17T00:00:00Z",
    });

    const client = createLLMClient({
      apiKey: "unused",
      defaultModel: "claude-sonnet-4-6",
      database: db,
    });

    const hit = await client.generateText({
      purpose: "seed-grounding",
      prompt: "ground",
      thinking: { type: "adaptive", effort: "high" },
      exactCache: { keyVersion: "v1" },
    });
    expect(hit.text).toBe("from-adaptive-cache");
    expect(hit.record.exactCacheHit).toBe(true);
    expect(hit.record.thinkingType).toBe("adaptive");
    expect(generateTextMock).not.toHaveBeenCalled();

    // Legacy budget must miss the adaptive entry and call the provider.
    await client.generateText({
      purpose: "seed-grounding",
      prompt: "ground",
      thinking: { type: "enabled", budgetTokens: 10_000 },
      exactCache: { keyVersion: "v1" },
    });
    expect(generateTextMock).toHaveBeenCalledOnce();

    db.close();
  });
});

describe("exact-result cache integration via LLM client", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    generateTextMock.mockReset();
  });

  afterEach(() => {
    db.close();
  });

  it("returns cached generateText response and records a non-billable cache hit", async () => {
    // Pre-seed a cached result
    const cacheKey = computeLLMCacheKey({
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      prompt: "test prompt",
      thinkingConfig: "",
      keyVersion: "v1",
    });
    storeLLMResult(db, {
      cacheKey,
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      keyVersion: "v1",
      responseText: "cached response text",
      createdAt: "2026-04-11T00:00:00Z",
    });

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    const result = await client.generateText({
      purpose: "evidence-rerank",
      prompt: "test prompt",
      exactCache: { keyVersion: "v1" },
    });

    expect(result.text).toBe("cached response text");
    expect(result.record.exactCacheHit).toBe(true);
    expect(result.record.billable).toBe(false);
    expect(result.record.estimatedCostUsd).toBe(0);
    expect(result.record.finishReason).toBe("cached");
    expect(result.record.inputTokens).toBe(0);
  });

  it("returns cached generateObject response and records a non-billable cache hit", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      results: z.array(
        z.object({
          blockId: z.string(),
          relevanceScore: z.number(),
          extractedSentences: z.string(),
        }),
      ),
    });

    // Pre-seed a cached JSON result (include schemaFingerprint to match generateObject key)
    const cacheKey = computeLLMCacheKey({
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      prompt: "test prompt",
      thinkingConfig: "",
      keyVersion: "v1",
      schemaFingerprint: schemaFingerprint(schema),
    });
    const cachedObject = {
      results: [
        { blockId: "b1", relevanceScore: 90, extractedSentences: "test" },
      ],
    };
    storeLLMResult(db, {
      cacheKey,
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      keyVersion: "v1",
      responseText: JSON.stringify(cachedObject),
      createdAt: "2026-04-11T00:00:00Z",
    });

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    const result = await client.generateObject({
      purpose: "evidence-rerank",
      prompt: "test prompt",
      schema,
      exactCache: { keyVersion: "v1" },
    });

    expect(result.object).toEqual(cachedObject);
    expect(result.record.exactCacheHit).toBe(true);
    expect(result.record.billable).toBe(false);
  });

  it("skips cache when forceRefresh is true", async () => {
    const cacheKey = computeLLMCacheKey({
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      prompt: "test prompt",
      thinkingConfig: "",
      keyVersion: "v1",
    });
    storeLLMResult(db, {
      cacheKey,
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      keyVersion: "v1",
      responseText: "should not be returned",
      createdAt: "2026-04-11T00:00:00Z",
    });

    // Fatal auth errors skip retries; proves cache was bypassed.
    generateTextMock.mockRejectedValue(
      new Error("Unauthorized: invalid API key"),
    );

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
      forceRefresh: true,
    });

    await expect(
      client.generateText({
        purpose: "evidence-rerank",
        prompt: "test prompt",
        exactCache: { keyVersion: "v1" },
      }),
    ).rejects.toThrow(/invalid API key/i);
    expect(generateTextMock).toHaveBeenCalled();
  });

  it("skips cache when no exactCache config is provided", async () => {
    const cacheKey = computeLLMCacheKey({
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      prompt: "test prompt",
      thinkingConfig: "",
      keyVersion: "v1",
    });
    storeLLMResult(db, {
      cacheKey,
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      keyVersion: "v1",
      responseText: "should not be returned",
      createdAt: "2026-04-11T00:00:00Z",
    });

    generateTextMock.mockRejectedValue(
      new Error("Unauthorized: invalid API key"),
    );

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    await expect(
      client.generateText({
        purpose: "evidence-rerank",
        prompt: "test prompt",
      }),
    ).rejects.toThrow(/invalid API key/i);
  });

  it("tracks exactCacheHits in ledger aggregation", async () => {
    const cacheKey = computeLLMCacheKey({
      purpose: "adjudication",
      model: "claude-opus-4-6",
      prompt: "adjudication prompt",
      thinkingConfig: "",
      keyVersion: "v1",
    });
    storeLLMResult(db, {
      cacheKey,
      purpose: "adjudication",
      model: "claude-opus-4-6",
      keyVersion: "v1",
      responseText: "cached",
      createdAt: "2026-04-11T00:00:00Z",
    });

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-opus-4-6",
      database: db,
    });

    await client.generateText({
      purpose: "adjudication",
      prompt: "adjudication prompt",
      exactCache: { keyVersion: "v1" },
    });

    const ledger: LLMRunLedger = client.getLedger();
    expect(ledger.totalExactCacheHits).toBe(1);
    expect(ledger.totalBillableCalls).toBe(0);
    expect(ledger.byPurpose["adjudication"]?.exactCacheHits).toBe(1);
    expect(ledger.byPurpose["adjudication"]?.billable).toBe(0);
  });

  it("misses cache when key version differs", async () => {
    const cacheKey = computeLLMCacheKey({
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      prompt: "test prompt",
      thinkingConfig: "",
      keyVersion: "v1",
    });
    storeLLMResult(db, {
      cacheKey,
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      keyVersion: "v1",
      responseText: "old cached",
      createdAt: "2026-04-11T00:00:00Z",
    });

    generateTextMock.mockRejectedValue(
      new Error("Unauthorized: invalid API key"),
    );

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    await expect(
      client.generateText({
        purpose: "evidence-rerank",
        prompt: "test prompt",
        exactCache: { keyVersion: "v2" },
      }),
    ).rejects.toThrow(/invalid API key/i);
  });
});
