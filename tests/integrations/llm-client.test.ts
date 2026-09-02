import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof AiModule>()),
  generateObject: vi.fn(),
  // Passthrough: the client wraps the provider schema and a local validator.
  jsonSchema: (schema: unknown, options?: { validate?: unknown }) => ({
    jsonSchema: schema,
    validate: options?.validate,
  }),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

import { generateObject, NoObjectGeneratedError } from "ai";
import type * as AiModule from "ai";
import { z } from "zod";
import {
  buildAnthropicThinkingProviderOptions,
  buildNormalizedLLMCallProvenance,
  classifyProviderError,
  toProviderJsonSchema,
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

const generateObjectMock = vi.mocked(generateObject);

/** Minimal reply shape for tests that exercise transport, not the schema. */
const anySchema = z.object({ ok: z.boolean() });

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

  it("does not cache per-record prompts that share no reusable prefix", () => {
    for (const purpose of [
      "evidence-rerank",
      "adjudication",
      "attributed-claim-extraction",
    ] as const) {
      expect(
        resolvePromptCacheControl({ purpose, prompt: "x".repeat(10_000) }),
      ).toBeUndefined();
    }
  });

  it("respects custom per-purpose overrides", () => {
    const cacheControl = resolvePromptCacheControl({
      purpose: "evidence-rerank",
      prompt: "x".repeat(600),
      options: {
        byPurpose: {
          "evidence-rerank": {
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

describe("provider options and telemetry through generateObject", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: { ok: true },
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

    const result = await client.generateObject({
      schema: anySchema,
      purpose: "seed-grounding",
      prompt: "short",
      thinking: { type: "adaptive", effort: "high" },
    });

    expect(generateObjectMock).toHaveBeenCalledOnce();
    const call = generateObjectMock.mock.calls[0]![0] as {
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

    const result = await client.generateObject({
      schema: anySchema,
      purpose: "attributed-claim-extraction",
      prompt: "short",
      thinking: { type: "enabled", budgetTokens: 8_000 },
    });

    const call = generateObjectMock.mock.calls[0]![0] as {
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

  it("sums prompt-cache reads and writes into the ledger", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: { ok: true },
      finishReason: "stop",
      response: { modelId: "claude-sonnet-4-6-20260214" },
      usage: {
        inputTokens: 1_200,
        outputTokens: 40,
        totalTokens: 1_240,
        inputTokenDetails: {
          noCacheTokens: 200,
          cacheReadTokens: 900,
          cacheWriteTokens: 100,
        },
      },
      providerMetadata: {
        anthropic: {
          usage: { cache_read_input_tokens: 900 },
        },
      },
    } as never);

    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: "claude-sonnet-4-6",
    });
    await client.generateObject({
      schema: anySchema,
      purpose: "seed-grounding",
      prompt: "x".repeat(5_000),
    });
    await client.generateObject({
      schema: anySchema,
      purpose: "seed-grounding",
      prompt: "x".repeat(5_000),
    });

    const ledger = client.getLedger();
    expect(ledger.totalCacheReadTokens).toBe(1_800);
    expect(ledger.totalCacheWriteTokens).toBe(200);
    expect(ledger.byPurpose["seed-grounding"]).toMatchObject({
      attempted: 2,
      cacheReadTokens: 1_800,
      cacheWriteTokens: 200,
    });
    // A cache read must not be billed as a fresh input token.
    expect(ledger.byPurpose["seed-grounding"]!.estimatedCostUsd).toBeLessThan(
      ledger.byPurpose["seed-grounding"]!.inputTokens * 2 * 3e-6,
    );
  });

  it("records the served model snapshot alongside the requested alias", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: { ok: true },
      finishReason: "stop",
      response: { modelId: "claude-opus-4-6-20260214" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);

    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: "claude-opus-4-6",
    });
    const result = await client.generateObject({
      schema: anySchema,
      purpose: "adjudication",
      prompt: "short",
    });

    expect(result.record.model).toBe("claude-opus-4-6");
    expect(result.record.servedModel).toBe("claude-opus-4-6-20260214");
  });

  it("passes thinking, a cached prefix, and a token cap through generateObject", async () => {
    const { z } = await import("zod");
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: { verdict: "F" },
      finishReason: "stop",
      response: { modelId: "claude-opus-4-6-20260214" },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as never);

    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: "claude-opus-4-6",
    });
    const result = await client.generateObject({
      purpose: "seed-grounding",
      promptPrefix: "x".repeat(5_000),
      promptSuffix: "which claim?",
      schema: z.object({ verdict: z.string() }),
      thinking: { type: "adaptive", effort: "medium" },
    });

    const call = generateObjectMock.mock.calls[0]![0] as {
      maxOutputTokens?: number;
      messages?: [{ content: { providerOptions?: unknown }[] }];
      providerOptions?: {
        anthropic?: { thinking?: { type: string }; effort?: string };
      };
    };
    expect(call.maxOutputTokens).toBe(16_000);
    // The seed text stays a cacheable prefix.
    expect(call.messages?.[0]?.content[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
    });
    expect(call.providerOptions?.anthropic).toMatchObject({
      thinking: { type: "adaptive" },
      effort: "medium",
    });
    expect(result.object).toEqual({ verdict: "F" });
    expect(result.record.thinkingEffort).toBe("medium");
    expect(result.record.servedModel).toBe("claude-opus-4-6-20260214");
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
      schemaFingerprint: schemaFingerprint(anySchema),
      promptCachePolicy: "",
      cachePolicy: "allow",
    });
    storeLLMResult(db, {
      cacheKey: adaptiveKey,
      responseText: '{"ok":true}',
      createdAt: "2026-07-17T00:00:00Z",
    });

    const client = createLLMClient({
      apiKey: "unused",
      defaultModel: "claude-sonnet-4-6",
      database: db,
    });

    const hit = await client.generateObject({
      schema: anySchema,
      purpose: "seed-grounding",
      prompt: "ground",
      thinking: { type: "adaptive", effort: "high" },
      exactCache: { keyVersion: "v1" },
    });
    expect(hit.object).toEqual({ ok: true });
    expect(hit.record.exactCacheHit).toBe(true);
    expect(hit.record.thinkingType).toBe("adaptive");
    expect(generateObjectMock).not.toHaveBeenCalled();

    // Legacy budget must miss the adaptive entry and call the provider.
    await client.generateObject({
      schema: anySchema,
      purpose: "seed-grounding",
      prompt: "ground",
      thinking: { type: "enabled", budgetTokens: 10_000 },
      exactCache: { keyVersion: "v1" },
    });
    expect(generateObjectMock).toHaveBeenCalledOnce();

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
    generateObjectMock.mockReset();
  });

  afterEach(() => {
    db.close();
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
      schemaFingerprint: schemaFingerprint(anySchema),
    });
    storeLLMResult(db, {
      cacheKey,
      responseText: '{"ok":true}',
      createdAt: "2026-04-11T00:00:00Z",
    });

    // Fatal auth errors skip retries; proves cache was bypassed.
    generateObjectMock.mockRejectedValue(
      new Error("Unauthorized: invalid API key"),
    );

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
      forceRefresh: true,
    });

    await expect(
      client.generateObject({
        schema: anySchema,
        purpose: "evidence-rerank",
        prompt: "test prompt",
        exactCache: { keyVersion: "v1" },
      }),
    ).rejects.toThrow(/invalid API key/i);
    expect(generateObjectMock).toHaveBeenCalled();
  });

  it("skips cache when no exactCache config is provided", async () => {
    const cacheKey = computeLLMCacheKey({
      purpose: "evidence-rerank",
      model: "claude-haiku-4-5",
      prompt: "test prompt",
      thinkingConfig: "",
      keyVersion: "v1",
      schemaFingerprint: schemaFingerprint(anySchema),
    });
    storeLLMResult(db, {
      cacheKey,
      responseText: '{"ok":true}',
      createdAt: "2026-04-11T00:00:00Z",
    });

    generateObjectMock.mockRejectedValue(
      new Error("Unauthorized: invalid API key"),
    );

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    await expect(
      client.generateObject({
        schema: anySchema,
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
      schemaFingerprint: schemaFingerprint(anySchema),
    });
    storeLLMResult(db, {
      cacheKey,
      responseText: '{"ok":true}',
      createdAt: "2026-04-11T00:00:00Z",
    });

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-opus-4-6",
      database: db,
    });

    await client.generateObject({
      schema: anySchema,
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
      schemaFingerprint: schemaFingerprint(anySchema),
    });
    storeLLMResult(db, {
      cacheKey,
      responseText: '{"ok":true}',
      createdAt: "2026-04-11T00:00:00Z",
    });

    generateObjectMock.mockRejectedValue(
      new Error("Unauthorized: invalid API key"),
    );

    const client = createLLMClient({
      apiKey: "test-key-not-used",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    await expect(
      client.generateObject({
        schema: anySchema,
        purpose: "evidence-rerank",
        prompt: "test prompt",
        exactCache: { keyVersion: "v2" },
      }),
    ).rejects.toThrow(/invalid API key/i);
  });
});

describe("classifyProviderError", () => {
  it("treats a rate-limit message that mentions quota as transient", () => {
    const result = classifyProviderError(
      new Error("429 rate limit quota exceeded, retry later"),
    );
    expect(result.classification).toBe("rate_limit");
    expect(result.fatal).toBe(false);
  });

  it("still treats genuine billing failures as fatal", () => {
    const result = classifyProviderError(
      new Error("Your credit balance is too low to access the API"),
    );
    expect(result.classification).toBe("billing_or_quota");
    expect(result.fatal).toBe(true);
  });
});

describe("toProviderJsonSchema", () => {
  it("strips bounds and defaults the provider rejects and keeps the shape", () => {
    const schema = z
      .object({
        verdict: z.enum(["F", "D"]),
        mutationKinds: z.array(z.string()).max(3).default([]),
        citedChunks: z.array(z.number().int().positive()).min(1),
        rationale: z.string().min(1),
        score: z.number().min(0).max(100),
      })
      .strict();
    const json = JSON.stringify(toProviderJsonSchema(schema));
    for (const keyword of [
      "maxItems",
      "minItems",
      "minLength",
      "minimum",
      "maximum",
      "default",
      "$schema",
    ]) {
      expect(json).not.toContain(`"${keyword}"`);
    }
    expect(json).toContain('"additionalProperties":false');
    expect(json).toContain('"enum":["F","D"]');
    expect(json).toContain('"type":"integer"');
  });

  it("turns discriminated unions into anyOf and drops never-typed items", () => {
    const schema = z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("grounded"),
          spans: z.array(z.object({ quote: z.string() })).min(1),
        })
        .strict(),
      z
        .object({
          status: z.literal("not_found"),
          spans: z.array(z.never()).length(0),
        })
        .strict(),
    ]);
    const json = JSON.stringify(toProviderJsonSchema(schema));
    expect(json).toContain('"anyOf"');
    expect(json).not.toContain('"oneOf"');
    expect(json).not.toContain('"not"');
  });
});

describe("malformed requests and malformed replies", () => {
  it("classifies a schema rejection as a fatal invalid request", () => {
    const result = classifyProviderError(
      new Error(
        "invalid_request_error: output_config.format.schema: For 'array' type, property 'maxItems' is not supported",
      ),
    );
    expect(result.classification).toBe("invalid_request");
    // Every record in the stage would fail the same way.
    expect(result.fatal).toBe(true);
  });

  function malformedReply(finishReason: "stop" | "length") {
    return new NoObjectGeneratedError({
      message: "No object generated: response did not match schema.",
      text: '{"verdict":"maybe"}',
      response: {
        id: "msg_1",
        modelId: "claude-opus-4-6-20260214",
        timestamp: new Date(0),
      },
      usage: {
        inputTokens: 900,
        outputTokens: 40,
        totalTokens: 940,
        inputTokenDetails: {
          noCacheTokens: 900,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: 40, reasoningTokens: 0 },
      },
      finishReason,
    });
  }

  it("does not retry a reply that fails the schema and records what it cost", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockRejectedValue(malformedReply("stop"));
    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: "claude-opus-4-6",
    });

    await expect(
      client.generateObject({
        purpose: "adjudication",
        prompt: "judge",
        schema: anySchema,
      }),
    ).rejects.toMatchObject({
      classification: "malformed_output",
      fatal: false,
      responseText: '{"verdict":"maybe"}',
      truncated: false,
    });
    expect(generateObjectMock).toHaveBeenCalledOnce();

    const purpose = client.getLedger().byPurpose["adjudication"]!;
    expect(purpose.attempted).toBe(1);
    expect(purpose.inputTokens).toBe(900);
    expect(purpose.outputTokens).toBe(40);
    expect(purpose.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("names truncation when the reply hit the output-token cap", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockRejectedValue(malformedReply("length"));
    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: "claude-opus-4-6",
    });

    await expect(
      client.generateObject({
        purpose: "adjudication",
        prompt: "judge",
        schema: anySchema,
      }),
    ).rejects.toMatchObject({
      classification: "malformed_output",
      truncated: true,
      message: expect.stringMatching(/truncated/i) as unknown,
    });
    expect(generateObjectMock).toHaveBeenCalledOnce();
  });

  it("treats a cached row that no longer fits the schema as a miss", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    storeLLMResult(db, {
      cacheKey: computeLLMCacheKey({
        purpose: "evidence-rerank",
        model: "claude-haiku-4-5",
        prompt: "rank",
        thinkingConfig: "",
        keyVersion: "v1",
        schemaFingerprint: schemaFingerprint(anySchema),
        promptCachePolicy: "",
        cachePolicy: "allow",
      }),
      responseText: '{"ok":"not a boolean"}',
      createdAt: "2026-04-11T00:00:00Z",
    });
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: { ok: true },
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);
    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: "claude-haiku-4-5",
      database: db,
    });

    const result = await client.generateObject({
      purpose: "evidence-rerank",
      prompt: "rank",
      schema: anySchema,
      exactCache: { keyVersion: "v1" },
    });

    expect(generateObjectMock).toHaveBeenCalledOnce();
    expect(result.object).toEqual({ ok: true });
    expect(result.record.exactCacheHit).toBeUndefined();
    db.close();
  });
});
