import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { FetchFunction } from "../../src/integrations/batch-transport.js";
import {
  createLLMClient,
  estimateExpectedRequestUsd,
  LLMProviderError,
  reservedOutputTokens,
  type CreateLLMClientOptions,
} from "../../src/integrations/llm-client.js";
import { estimateAnthropicUsd } from "../../src/shared/anthropic-token-cost.js";
import { runMigrations } from "../../src/storage/migration-service.js";

const MODEL = "claude-sonnet-5-5";
const API = "https://api.anthropic.com/v1";
const schema = z.object({ echo: z.string() });
const USAGE = { input_tokens: 1_000, output_tokens: 200 };

type BatchResult =
  | { type: "succeeded" }
  | { type: "errored"; errorType: string; message: string }
  | { type: "canceled" }
  | { type: "expired" };

type MessageParams = {
  messages: Array<{
    content:
      | Array<{ text: string; cache_control?: { type: string; ttl?: string } }>
      | string;
  }>;
};

type Usage = Record<string, unknown>;

/** The request's last text part: the whole prompt, or a prefixed suffix. */
function promptOf(params: MessageParams): string {
  const content = params.messages[0]!.content;
  return typeof content === "string" ? content : content.at(-1)!.text;
}

function message(prompt: string, usage: Usage = USAGE) {
  return {
    id: `msg_${prompt}`,
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: JSON.stringify({ echo: prompt }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stand-in for the Anthropic API: direct Messages calls, batch create,
 * retrieve, and results. `resultFor` decides each batch item's outcome, by
 * prompt and by how many times that prompt has been batched before.
 */
function createFakeApi(
  options: {
    resultFor?: (prompt: string, attempt: number) => BatchResult;
    /** Usage the API reports for a request; defaults to `USAGE`. */
    usageFor?: (params: MessageParams) => Usage;
    /** Batches stay in progress until this is set. */
    ended?: () => boolean;
  } = {},
) {
  const directPrompts: string[] = [];
  const directParams: MessageParams[] = [];
  const batches: Array<{
    id: string;
    prompts: string[];
    customIds: string[];
    params: MessageParams[];
  }> = [];
  const reply = (params: MessageParams) =>
    message(promptOf(params), options.usageFor?.(params) ?? USAGE);
  const attempts = new Map<string, number>();
  const results = new Map<string, string>();
  const calls: string[] = [];

  function handle(input: string | URL | Request, init?: RequestInit): Response {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = init?.method ?? "GET";
    const requestBody = typeof init?.body === "string" ? init.body : "";
    calls.push(`${method} ${url.replace(API, "")}`);
    if (method === "POST" && url === `${API}/messages`) {
      const params = JSON.parse(requestBody) as MessageParams;
      directPrompts.push(promptOf(params));
      directParams.push(params);
      return json(reply(params));
    }
    if (method === "POST" && url === `${API}/messages/batches`) {
      const body = JSON.parse(requestBody) as {
        requests: Array<{ custom_id: string; params: MessageParams }>;
      };
      const id = `msgbatch_${String(batches.length + 1)}`;
      const lines = body.requests.map(({ custom_id, params }) => {
        const prompt = promptOf(params);
        const attempt = attempts.get(prompt) ?? 0;
        attempts.set(prompt, attempt + 1);
        const outcome = options.resultFor?.(prompt, attempt) ?? {
          type: "succeeded",
        };
        const result =
          outcome.type === "succeeded"
            ? { type: "succeeded", message: reply(params) }
            : outcome.type === "errored"
              ? {
                  type: "errored",
                  error: {
                    type: "error",
                    error: {
                      type: outcome.errorType,
                      message: outcome.message,
                    },
                  },
                }
              : { type: outcome.type };
        return JSON.stringify({ custom_id, result });
      });
      results.set(id, lines.join("\n"));
      batches.push({
        id,
        prompts: body.requests.map(({ params }) => promptOf(params)),
        customIds: body.requests.map(({ custom_id }) => custom_id),
        params: body.requests.map(({ params }) => params),
      });
      return json({
        id,
        type: "message_batch",
        processing_status: "in_progress",
      });
    }
    const results_match = /\/messages\/batches\/([^/]+)\/results$/.exec(url);
    if (method === "GET" && results_match) {
      return new Response(results.get(results_match[1]!) ?? "", {
        status: 200,
        headers: { "content-type": "application/x-jsonl" },
      });
    }
    const batch_match = /\/messages\/batches\/([^/]+)$/.exec(url);
    if (method === "GET" && batch_match) {
      const id = batch_match[1]!;
      if (!results.has(id)) return json({ type: "error", error: {} }, 404);
      const ended = options.ended?.() ?? true;
      return json({
        id,
        processing_status: ended ? "ended" : "in_progress",
        results_url: ended ? `${API}/messages/batches/${id}/results` : null,
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }

  const fetch: FetchFunction = (input, init) => {
    try {
      return Promise.resolve(handle(input, init));
    } catch (error) {
      return Promise.reject(error as Error);
    }
  };

  return { fetch, directPrompts, directParams, batches, calls };
}

const FAST = {
  idleMs: 20,
  pollInitialMs: 5,
  pollMaxMs: 10,
};

function batchClient(
  fetch: FetchFunction,
  overrides: Partial<CreateLLMClientOptions> & {
    batch?: CreateLLMClientOptions["batch"];
  } = {},
) {
  return createLLMClient({
    apiKey: "test-key",
    defaultModel: MODEL,
    fetch,
    batch: { ...FAST, ...overrides.batch },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "batch"),
    ),
  });
}

function ask(client: ReturnType<typeof createLLMClient>, prompt: string) {
  return client.generateObject({
    purpose: "evidence-rerank",
    prompt,
    schema,
  });
}

const silence = () => {};

describe("batch transport", () => {
  let originalError: typeof console.error;
  beforeEach(() => {
    originalError = console.error;
    console.error = silence;
  });
  afterEach(() => {
    console.error = originalError;
  });

  it("puts concurrent requests in one batch and answers each caller with its own result", async () => {
    const api = createFakeApi();
    const client = batchClient(api.fetch);
    const prompts = ["a", "b", "c", "d", "e", "f"];

    const results = await Promise.all(prompts.map((p) => ask(client, p)));

    expect(api.batches).toHaveLength(1);
    expect([...api.batches[0]!.prompts].sort()).toEqual(prompts);
    expect(api.directPrompts).toEqual([]);
    expect(results.map((r) => r.object.echo)).toEqual(prompts);
    for (const { record } of results) {
      expect(record.transport).toBe("batch");
      expect(record.inputTokens).toBe(USAGE.input_tokens);
    }
    // custom_ids are content hashes the API accepts: [a-zA-Z0-9_-]{1,64}.
    for (const id of api.batches[0]!.customIds) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("bills a batched call at half the direct price", async () => {
    const api = createFakeApi();
    const batched = batchClient(api.fetch);
    const direct = createLLMClient({
      apiKey: "test-key",
      defaultModel: MODEL,
      fetch: api.fetch,
    });

    const [fromBatch] = await Promise.all(
      ["a", "b", "c", "d", "e"].map((p) => ask(batched, p)),
    );
    const fromDirect = await ask(direct, "z");

    const listPrice = estimateAnthropicUsd(MODEL, {
      inputTokens: USAGE.input_tokens,
      outputTokens: USAGE.output_tokens,
    });
    expect(fromDirect.record.estimatedCostUsd).toBeCloseTo(listPrice, 12);
    expect(fromBatch!.record.estimatedCostUsd).toBeCloseTo(listPrice / 2, 12);
    expect(batched.getLedger().totalEstimatedCostUsd).toBeCloseTo(
      (5 * listPrice) / 2,
      12,
    );
  });

  it("refuses to queue requests whose expected cost would pass the spend limit", async () => {
    const api = createFakeApi();
    let spent = 0;
    // A one-character prompt with nothing completed yet reserves the
    // 2,000-token output floor.
    const expected = estimateExpectedRequestUsd({
      model: MODEL,
      cachedPrefixChars: 0,
      prefixBilling: "read",
      uncachedChars: 1,
      outputTokens: 2_000,
      batch: true,
    });
    const client = batchClient(api.fetch, {
      batch: { directBelow: 1 },
      collector: {
        recordCall: (record) => {
          spent += record.estimatedCostUsd;
        },
        getLedger: () => {
          throw new Error("unused");
        },
      },
      spendLimit: { maxUsd: expected * 2.5, spentUsd: () => spent },
    });

    const settled = await Promise.allSettled(
      ["a", "b", "c", "d"].map((p) => ask(client, p)),
    );

    expect(settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    const refusal = (settled[2] as PromiseRejectedResult).reason as unknown;
    expect(refusal).toBeInstanceOf(LLMProviderError);
    expect((refusal as LLMProviderError).classification).toBe("spend_limit");
    expect(api.batches).toHaveLength(1);
    expect(api.batches[0]!.prompts).toHaveLength(2);
    // Reservations are released once real costs are recorded.
    expect(spent).toBeLessThan(expected);
    await expect(ask(client, "e")).resolves.toBeDefined();
  });

  it("reserves output at twice the observed mean, between 2,000 tokens and the cap", () => {
    const reserve = (calls: number, tokens: number) =>
      reservedOutputTokens({
        maxOutputTokens: 16_000,
        completedCalls: calls,
        completedOutputTokens: tokens,
      });
    expect(reserve(0, 0)).toBe(2_000);
    expect(reserve(10, 5_400)).toBe(2_000);
    expect(reserve(10, 30_000)).toBe(6_000);
    expect(reserve(10, 100_000)).toBe(16_000);
  });

  it("sends a queue that goes quiet with fewer than five requests directly", async () => {
    const api = createFakeApi();
    const client = batchClient(api.fetch, { batch: { idleMs: 20 } });

    const results = await Promise.all(["a", "b"].map((p) => ask(client, p)));

    expect(api.batches).toHaveLength(0);
    expect([...api.directPrompts].sort()).toEqual(["a", "b"]);
    for (const { record } of results) {
      expect(record.transport).toBe("direct");
    }

    await Promise.all(["c", "d", "e", "f", "g"].map((p) => ask(client, p)));
    expect(api.batches).toHaveLength(1);
    expect(api.batches[0]!.prompts).toHaveLength(5);
  });

  it("raises a non-retryable error for an errored item without resending it", async () => {
    const api = createFakeApi({
      resultFor: (prompt) =>
        prompt === "bad"
          ? {
              type: "errored",
              errorType: "invalid_request_error",
              message: "output_config.format: schema is not supported",
            }
          : { type: "succeeded" },
    });
    const client = batchClient(api.fetch, { batch: { directBelow: 1 } });

    const settled = await Promise.allSettled(
      ["ok", "bad"].map((p) => ask(client, p)),
    );

    expect(settled[0]!.status).toBe("fulfilled");
    const error = (settled[1] as PromiseRejectedResult).reason as unknown;
    expect(error).toBeInstanceOf(LLMProviderError);
    expect((error as LLMProviderError).classification).toBe("invalid_request");
    expect((error as LLMProviderError).fatal).toBe(true);
    expect(api.batches).toHaveLength(1);
  });

  it("resends expired, canceled and overloaded items, which then succeed", async () => {
    const outcomes: Record<string, BatchResult> = {
      late: { type: "expired" },
      dropped: { type: "canceled" },
      busy: {
        type: "errored",
        errorType: "overloaded_error",
        message: "Overloaded",
      },
    };
    const api = createFakeApi({
      resultFor: (prompt, attempt) =>
        attempt === 0 && outcomes[prompt]
          ? outcomes[prompt]
          : { type: "succeeded" },
    });
    const client = batchClient(api.fetch, { batch: { directBelow: 1 } });

    const results = await Promise.all(
      ["late", "dropped", "busy", "fine"].map((p) => ask(client, p)),
    );

    expect(results.map((r) => r.object.echo)).toEqual([
      "late",
      "dropped",
      "busy",
      "fine",
    ]);
    const resent = api.batches.slice(1).flatMap((batch) => batch.prompts);
    expect([...resent].sort()).toEqual(["busy", "dropped", "late"]);
    expect(api.directPrompts).toEqual([]);
  }, 20_000);

  it("is unchanged without --batch: one direct request at list price", async () => {
    const api = createFakeApi();
    const client = createLLMClient({
      apiKey: "test-key",
      defaultModel: MODEL,
      fetch: api.fetch,
    });

    const result = await ask(client, "plain");

    expect(api.calls).toEqual(["POST /messages"]);
    expect(result.object.echo).toBe("plain");
    expect(result.record.transport).toBe("direct");
    expect(result.record.estimatedCostUsd).toBeCloseTo(
      estimateAnthropicUsd(MODEL, {
        inputTokens: USAGE.input_tokens,
        outputTokens: USAGE.output_tokens,
      }),
      12,
    );
  });
});

/**
 * Whole-paper adjudication as measured on a real run: a ~22k-token seed text
 * shared as a cached prefix, ~1,800 uncached input tokens, and ~540 output
 * tokens per record, at Sonnet 5.5 batch prices.
 */
describe("whole-paper adjudication under --batch", () => {
  const SEED_TEXT = "s".repeat(88_000); // 22,000 tokens at 4 chars per token
  const suffix = (index: number) =>
    `record-${String(index)}`.padEnd(6_000, "x");
  const READ_USAGE = {
    input_tokens: 1_800,
    cache_read_input_tokens: 22_000,
    cache_creation_input_tokens: 0,
    output_tokens: 540,
  };
  const WRITE_USAGE = {
    input_tokens: 1_800,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 22_000,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 22_000,
    },
    output_tokens: 540,
  };
  /** $0.0056: 1,800 uncached, 22,000 cache-read, 540 output, at half price. */
  const REAL_COST_PER_RECORD =
    ((1_800 * 2 + 22_000 * 0.1 + 540 * 10) / 1_000_000) * 0.5;

  function adjudicate(client: ReturnType<typeof createLLMClient>, i: number) {
    return client.generateObject({
      purpose: "adjudication",
      promptPrefix: SEED_TEXT,
      promptSuffix: suffix(i),
      schema,
    });
  }

  function apiForSeed() {
    let wrote = false;
    return createFakeApi({
      usageFor: () => {
        if (wrote) return READ_USAGE;
        wrote = true;
        return WRITE_USAGE;
      },
    });
  }

  let originalError: typeof console.error;
  beforeEach(() => {
    originalError = console.error;
    console.error = silence;
  });
  afterEach(() => {
    console.error = originalError;
  });

  it("writes batched shared prefixes with the 1-hour cache TTL and prices that write", async () => {
    const api = apiForSeed();
    const batched = batchClient(api.fetch);

    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => adjudicate(batched, i)),
    );

    for (const params of api.batches[0]!.params) {
      const content = params.messages[0]!.content;
      expect(Array.isArray(content) && content[0]!.cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    }
    const costs = results.map((r) => r.record.estimatedCostUsd).sort();
    // One 1-hour write at 2x input, the rest cache reads, all at half price.
    expect(costs.at(-1)).toBeCloseTo(
      ((1_800 * 2 + 22_000 * 2 * 2 + 540 * 10) / 1_000_000) * 0.5,
      12,
    );
    expect(costs[0]).toBeCloseTo(REAL_COST_PER_RECORD, 12);

    // Direct calls keep the 5-minute TTL.
    const directApi = createFakeApi();
    const directClient = createLLMClient({
      apiKey: "test-key",
      defaultModel: MODEL,
      fetch: directApi.fetch,
    });
    await adjudicate(directClient, 0);
    const directContent = directApi.directParams[0]!.messages[0]!.content;
    expect(
      Array.isArray(directContent) && directContent[0]!.cache_control,
    ).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("fits a 2,500-record stage under a limit of about twice its real cost", () => {
    // The seed's first request writes the cache and finishes before the rest
    // are queued (the adapter holds them back); the other 2,499 are queued
    // at once, each reserving a cache read, its uncached input, and the
    // 2,000-token output floor.
    const firstReal =
      ((1_800 * 2 + 22_000 * 2 * 2 + 540 * 10) / 1_000_000) * 0.5;
    const queued = estimateExpectedRequestUsd({
      model: MODEL,
      cachedPrefixChars: SEED_TEXT.length,
      prefixBilling: "read",
      uncachedChars: suffix(1).length,
      outputTokens: reservedOutputTokens({
        maxOutputTokens: 16_000,
        completedCalls: 1,
        completedOutputTokens: 540,
      }),
      batch: true,
    });
    const peak = firstReal + 2_499 * queued;
    const realStage = firstReal + 2_499 * REAL_COST_PER_RECORD;

    expect(queued).toBeCloseTo(0.0129, 4);
    expect(realStage).toBeCloseTo(14.04, 2);
    expect(peak).toBeCloseTo(32.29, 2);
    expect(peak / realStage).toBeLessThan(2.35);
  });

  it("admits a whole seed's records at once under that limit and spends what they cost", async () => {
    const records = 200;
    const api = apiForSeed();
    let spent = 0;
    // The lone cache-writing request is under five, so it goes direct at
    // list price.
    const firstDirect = (1_800 * 2 + 22_000 * 2 * 2 + 540 * 10) / 1_000_000;
    const realStage = firstDirect + (records - 1) * REAL_COST_PER_RECORD;
    const client = batchClient(api.fetch, {
      collector: {
        recordCall: (record) => {
          spent += record.estimatedCostUsd;
        },
        getLedger: () => {
          throw new Error("unused");
        },
      },
      spendLimit: { maxUsd: realStage * 2.35, spentUsd: () => spent },
    });

    // As the adapter does: the first request alone, then the rest together.
    await adjudicate(client, 0);
    const rest = await Promise.allSettled(
      Array.from({ length: records - 1 }, (_, i) => adjudicate(client, i + 1)),
    );

    expect(rest.every((r) => r.status === "fulfilled")).toBe(true);
    expect(api.directPrompts).toHaveLength(1);
    expect(api.batches).toHaveLength(1);
    expect(api.batches[0]!.prompts).toHaveLength(records - 1);
    expect(spent).toBeCloseTo(realStage, 10);
  });
});

describe("batch transport across processes", () => {
  let db: Database.Database;
  let originalError: typeof console.error;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    originalError = console.error;
    console.error = silence;
  });
  afterEach(() => {
    console.error = originalError;
    db.close();
  });

  it("takes a pending batch's result on a later run instead of resubmitting", async () => {
    let ended = false;
    const api = createFakeApi({ ended: () => ended });

    // The first process submits, then dies: its polls never come back.
    const dying: FetchFunction = (input, init) =>
      (init?.method ?? "GET") === "GET"
        ? new Promise<Response>(() => {})
        : api.fetch(input, init);
    const first = batchClient(dying, {
      database: db,
      batch: { directBelow: 1 },
    });
    void ask(first, "kept");
    void ask(first, "unasked");
    await waitFor(() => api.batches.length === 1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM llm_batch_requests").get(),
    ).toEqual({ n: 2 });

    // A resume sends the same request; the batch has ended by now.
    ended = true;
    const second = batchClient(api.fetch, {
      database: db,
      batch: { directBelow: 1 },
    });
    const resumed = await ask(second, "kept");

    expect(resumed.object.echo).toBe("kept");
    expect(resumed.record.transport).toBe("batch");
    expect(api.batches).toHaveLength(1);
    expect(api.directPrompts).toEqual([]);

    // The other result was paid for too; a later run takes it from the store
    // without touching the network.
    const callsBefore = api.calls.length;
    const third = batchClient(api.fetch, { database: db });
    const stored = await ask(third, "unasked");
    expect(stored.object.echo).toBe("unasked");
    expect(api.calls.length).toBe(callsBefore);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM llm_batch_requests").get(),
    ).toEqual({ n: 0 });
  });

  it("resubmits a request whose batch is past the results retention", async () => {
    // Learn the request's custom_id from a first submission, then age it.
    const api = createFakeApi({ ended: () => false });
    const dying: FetchFunction = (input, init) =>
      (init?.method ?? "GET") === "GET"
        ? new Promise<Response>(() => {})
        : api.fetch(input, init);
    void ask(
      batchClient(dying, { database: db, batch: { directBelow: 1 } }),
      "old",
    );
    await waitFor(() => api.batches.length === 1);
    db.prepare(
      "UPDATE llm_batch_requests SET batch_id = 'msgbatch_old', submitted_at = ?",
    ).run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString());

    const fresh = createFakeApi();
    const result = await ask(
      batchClient(fresh.fetch, { database: db, batch: { directBelow: 1 } }),
      "old",
    );

    expect(result.object.echo).toBe("old");
    expect(fresh.batches).toHaveLength(1);
    expect(fresh.calls).not.toContain("GET /messages/batches/msgbatch_old");
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met");
}
