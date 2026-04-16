import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  createLLMClient,
  resolvePromptCacheControl,
  schemaFingerprint,
  type LLMRunLedger,
} from "../../src/integrations/llm-client.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import {
  computeLLMCacheKey,
  storeLLMResult,
} from "../../src/storage/llm-result-cache.js";

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

describe("exact-result cache integration via LLM client", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    runMigrations(db);
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

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
      forceRefresh: true,
    });

    // Should NOT hit cache — will try to call Anthropic and fail since the
    // API key is fake. This proves the cache was bypassed.
    await expect(
      client.generateText({
        purpose: "evidence-rerank",
        prompt: "test prompt",
        exactCache: { keyVersion: "v1" },
      }),
    ).rejects.toThrow();
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

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    // No exactCache → bypasses cache → tries Anthropic → fails
    await expect(
      client.generateText({
        purpose: "evidence-rerank",
        prompt: "test prompt",
      }),
    ).rejects.toThrow();
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

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    // Different key version → cache miss → tries Anthropic → fails
    await expect(
      client.generateText({
        purpose: "evidence-rerank",
        prompt: "test prompt",
        exactCache: { keyVersion: "v2" },
      }),
    ).rejects.toThrow();
  });
});
