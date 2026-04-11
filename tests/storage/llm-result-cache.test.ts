import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { runMigrations } from "../../src/storage/migration-service.js";
import {
  computeLLMCacheKey,
  getCachedLLMResult,
  storeLLMResult,
} from "../../src/storage/llm-result-cache.js";

describe("llm-result-cache", () => {
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

  // -----------------------------------------------------------------------
  // Key computation
  // -----------------------------------------------------------------------

  it("produces deterministic cache keys for identical inputs", () => {
    const input = {
      purpose: "adjudication" as const,
      model: "claude-opus-4-6",
      prompt: "What is the verdict?",
      thinkingConfig: "enabled:10000",
      keyVersion: "v1",
    };
    expect(computeLLMCacheKey(input)).toBe(computeLLMCacheKey(input));
  });

  it("produces different keys when any field changes", () => {
    const base = {
      purpose: "adjudication" as const,
      model: "claude-opus-4-6",
      prompt: "prompt",
      thinkingConfig: "",
      keyVersion: "v1",
    };

    const keys = new Set([
      computeLLMCacheKey(base),
      computeLLMCacheKey({ ...base, purpose: "evidence-rerank" }),
      computeLLMCacheKey({ ...base, model: "claude-haiku-4-5" }),
      computeLLMCacheKey({ ...base, prompt: "different" }),
      computeLLMCacheKey({ ...base, thinkingConfig: "enabled:8000" }),
      computeLLMCacheKey({ ...base, keyVersion: "v2" }),
    ]);

    expect(keys.size).toBe(6);
  });

  // -----------------------------------------------------------------------
  // Round-trip storage
  // -----------------------------------------------------------------------

  it("round-trips a cached result through store and get", () => {
    const key = computeLLMCacheKey({
      purpose: "adjudication",
      model: "claude-opus-4-6",
      prompt: "prompt text",
      thinkingConfig: "",
      keyVersion: "v1",
    });

    storeLLMResult(db, {
      cacheKey: key,
      purpose: "adjudication",
      model: "claude-opus-4-6",
      keyVersion: "v1",
      responseText: '{"verdict":"supported"}',
      createdAt: "2026-04-11T00:00:00Z",
    });

    const cached = getCachedLLMResult(db, key);
    expect(cached).toBeDefined();
    expect(cached!.responseText).toBe('{"verdict":"supported"}');
    expect(cached!.purpose).toBe("adjudication");
    expect(cached!.model).toBe("claude-opus-4-6");
    expect(cached!.keyVersion).toBe("v1");
    expect(cached!.createdAt).toBe("2026-04-11T00:00:00Z");
    // lastHitAt is set on read
    expect(cached!.lastHitAt).toBeDefined();
  });

  it("returns undefined for a cache miss", () => {
    const result = getCachedLLMResult(db, "nonexistent-key");
    expect(result).toBeUndefined();
  });

  it("upserts on key collision (overwrites response)", () => {
    const key = "fixed-key";

    storeLLMResult(db, {
      cacheKey: key,
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      keyVersion: "v1",
      responseText: "first",
      createdAt: "2026-04-11T00:00:00Z",
    });

    storeLLMResult(db, {
      cacheKey: key,
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      keyVersion: "v1",
      responseText: "second",
      createdAt: "2026-04-11T01:00:00Z",
    });

    const cached = getCachedLLMResult(db, key);
    expect(cached!.responseText).toBe("second");
  });

  // -----------------------------------------------------------------------
  // Key version invalidation
  // -----------------------------------------------------------------------

  it("misses when key version changes (prompt/schema update)", () => {
    const baseInput = {
      purpose: "seed-grounding" as const,
      model: "claude-sonnet-4-6",
      prompt: "same prompt",
      thinkingConfig: "enabled:8000",
    };

    const keyV1 = computeLLMCacheKey({ ...baseInput, keyVersion: "v1" });
    const keyV2 = computeLLMCacheKey({ ...baseInput, keyVersion: "v2" });

    storeLLMResult(db, {
      cacheKey: keyV1,
      purpose: "seed-grounding",
      model: "claude-sonnet-4-6",
      keyVersion: "v1",
      responseText: "old response",
      createdAt: "2026-04-11T00:00:00Z",
    });

    // Different key version → different cache key → miss
    expect(keyV1).not.toBe(keyV2);
    expect(getCachedLLMResult(db, keyV2)).toBeUndefined();
    // Original still available
    expect(getCachedLLMResult(db, keyV1)).toBeDefined();
  });
});
