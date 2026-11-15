import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import Database from "better-sqlite3";
import { createLLMClient } from "../../src/integrations/llm-client.js";
import {
  createRunCostTracker,
  readPersistedCalls,
} from "../../src/pipeline/cost-summary.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import {
  inspectTrace,
  readTraceEvents,
  TracePersistenceError,
} from "../../src/telemetry/trace.js";

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "palimpsest-llm-audit-"));
  roots.push(root);
  return { root, tracker: createRunCostTracker(root) };
}
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const request = {
  purpose: "adjudication" as const,
  prompt: "A synthetic claim.",
  schema: z.object({ ok: z.boolean() }),
};
function reply(text = '{"ok":true}') {
  return new Response(
    JSON.stringify({
      id: "msg-audit",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 200,
        },
      },
    }),
    {
      headers: {
        "content-type": "application/json",
        "request-id": "req-audit",
      },
    },
  );
}

describe("real SDK audit path with a fake network", () => {
  it("does not retry persistence failures wrapped by the SDK", async () => {
    const { tracker } = setup();
    let sends = 0;
    const client = createLLMClient({
      apiKey: "test-secret",
      collector: tracker.collector,
      fetch: () => {
        sends++;
        return Promise.reject(new TracePersistenceError("disk unavailable"));
      },
    });
    await expect(client.generateObject(request)).rejects.toBeInstanceOf(
      TracePersistenceError,
    );
    expect(sends).toBe(1);
  });

  it("preserves reported tokens when the served model has no known price", async () => {
    const { root, tracker } = setup();
    const client = createLLMClient({
      apiKey: "test-secret",
      collector: tracker.collector,
      fetch: async () => {
        const body = (await reply().json()) as Record<string, unknown>;
        return Response.json({ ...body, model: "unpriced-model" });
      },
    });
    const result = await client.generateObject(request);
    expect(result.record).toMatchObject({
      servedModel: "unpriced-model",
      inputTokens: 800,
      outputTokens: 20,
      usageStatus: "reported",
      billingStatus: "unknown",
      pricing: null,
      estimatedCostUsd: 0,
    });
    expect(readPersistedCalls(root)[0]).toMatchObject({
      billingStatus: "unknown",
    });
  });
  it("retains raw usage, cache TTLs, model identity, request ids, pricing and cache origin", async () => {
    const { root, tracker } = setup();
    const db = new Database(":memory:");
    runMigrations(db);
    try {
      let sends = 0;
      const client = createLLMClient({
        apiKey: "test-secret",
        collector: tracker.collector,
        database: db,
        fetch: () => {
          sends++;
          return Promise.resolve(reply());
        },
      });
      const first = await client.generateObject({
        ...request,
        exactCache: { keyVersion: "audit-v1" },
      });
      const hit = await client.generateObject({
        ...request,
        exactCache: { keyVersion: "audit-v1" },
      });
      expect(sends).toBe(1);
      expect(first.record).toMatchObject({
        usageStatus: "reported",
        billingStatus: "billable",
        inputTokens: 800,
        outputTokens: 20,
        noCacheInputTokens: 100,
        cacheReadTokens: 500,
        cacheWriteTokens: 200,
        cacheCreation: { ephemeral1hInputTokens: 200 },
        servedModel: "claude-sonnet-5-5",
        providerRequestId: "req-audit",
        providerResponseId: "msg-audit",
        rawUsage: { input_tokens: 100 },
        pricing: { model: "claude-sonnet-5-5", input: 2, output: 10 },
      });
      expect(first.record.estimatedCostUsd).toBeCloseTo(
        (100 * 2 + 500 * 0.1 + 200 * 2 * 2 + 20 * 10) / 1_000_000,
      );
      expect(hit.record).toMatchObject({
        usageStatus: "not_sent",
        billingStatus: "free",
        exactCacheHit: true,
        cacheOrigin: {
          callId: first.record.callId,
          traceRoot: tracker.trace.root,
          servedModel: "claude-sonnet-5-5",
        },
      });
      expect(readPersistedCalls(root)).toHaveLength(2);
      const audit = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "trace",
          "--root",
          root,
          "--calls",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(audit.status, audit.stderr).toBe(0);
      expect(JSON.parse(audit.stdout)).toMatchObject({
        cost: { totalCalls: 2, totalExactCacheHits: 1, unknownCostCalls: 0 },
        calls: [
          expect.objectContaining({ inputTokens: 800 }),
          expect.objectContaining({ exactCacheHit: true }),
        ],
      });
      expect(inspectTrace(root)).toMatchObject({
        incomplete: [],
        unresolvedModelAttempts: 0,
        byKind: { "llm.call": 2, "llm.attempt": 1, http: 1 },
      });
    } finally {
      db.close();
    }
  });

  it("records every retry and keeps a rejected request's unreported charge unknown", async () => {
    const { root, tracker } = setup();
    let sends = 0;
    const client = createLLMClient({
      apiKey: "test-secret",
      collector: tracker.collector,
      fetch: () =>
        Promise.resolve(
          ++sends === 1
            ? new Response(
                JSON.stringify({
                  type: "error",
                  error: { type: "overloaded_error", message: "overloaded" },
                }),
                {
                  status: 529,
                  headers: { "content-type": "application/json" },
                },
              )
            : reply(),
        ),
    });
    await client.generateObject(request);
    expect(sends).toBe(2);
    expect(readPersistedCalls(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failed: true,
          usageStatus: "missing",
          billingStatus: "unknown",
        }),
        expect.objectContaining({ successful: true, usageStatus: "reported" }),
      ]),
    );
    expect(inspectTrace(root).byKind).toMatchObject({
      "llm.attempt": 2,
      http: 2,
    });
  });

  it("persists billable malformed replies before schema validation fails", async () => {
    const { root, tracker } = setup();
    const client = createLLMClient({
      apiKey: "test-secret",
      collector: tracker.collector,
      fetch: () => Promise.resolve(reply('{"wrong":true}')),
    });
    await expect(client.generateObject(request)).rejects.toThrow();
    expect(readPersistedCalls(root)).toEqual([
      expect.objectContaining({
        failed: true,
        billable: true,
        inputTokens: 800,
        providerErrorClass: "malformed_output",
      }),
    ]);
    const events = readTraceEvents(root).events;
    expect(
      events.findIndex((event) => event.name === "response_body"),
    ).toBeLessThan(events.findIndex((event) => event.name === "usage"));
  });
});
