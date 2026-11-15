import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTraceSession,
  inspectTrace,
  readTraceEvents,
  readTracePayload,
  traceOperation,
  withTraceSession,
  TracePersistenceError,
} from "../../src/telemetry/trace.js";
import { tracedFetch } from "../../src/telemetry/http.js";

const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "palimpsest-trace-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("durable centralized traces", () => {
  it("keeps production network calls behind the audited fetch boundary", () => {
    const files = readdirSync("src", { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name));
    for (const file of files) {
      if (file === join("src", "telemetry", "http.ts")) continue;
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\b(?:globalThis\.)?fetch\s*\(/);
      expect(source, file).not.toMatch(/from ["'](?:node:)?https?["']/);
      if (file !== join("src", "integrations", "llm-client.ts"))
        expect(source, file).not.toMatch(
          /from ["'](?:ai|@ai-sdk\/[^"']+|@anthropic-ai\/sdk|openai)["']/,
        );
    }
  });
  it("persists starts before side effects and keeps concurrent children attached to their parents", async () => {
    const path = root();
    const session = createTraceSession(path, { runId: "test-run" });
    await withTraceSession(session, () =>
      Promise.all(
        ["one", "two"].map((name) =>
          traceOperation(
            "tool",
            name,
            { name },
            async (parent) => {
              expect(
                readTraceEvents(path).events.some(
                  (event) =>
                    event.spanId === parent && event.phase === "started",
                ),
              ).toBe(true);
              await Promise.resolve();
              return traceOperation("tool", `${name}.child`, {}, () =>
                Promise.resolve(name),
              );
            },
            { item: name },
          ),
        ),
      ),
    );
    const events = readTraceEvents(path).events;
    for (const name of ["one", "two"]) {
      const parent = events.find((event) => event.name === name)!;
      expect(
        events.find((event) => event.name === `${name}.child`),
      ).toMatchObject({
        parentSpanId: parent.spanId,
        labels: { runId: "test-run", item: name },
      });
    }
    expect(inspectTrace(path)).toMatchObject({
      byKind: { tool: 4 },
      incomplete: [],
    });
  });

  it("saves raw responses before returning them, with credentials removed and usage retained", async () => {
    const path = root();
    const session = createTraceSession(path);
    const key = "private-test-credential";
    const response = await withTraceSession(session, () =>
      tracedFetch(
        `https://example.test/api?api_key=${key}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: JSON.stringify({
            prompt: "scientific claim",
            input_tokens: 12,
          }),
        },
        () => {
          expect(
            readTraceEvents(path).events.some(
              (event) => event.name === "request_body",
            ),
          ).toBe(true);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                model: "served-model",
                usage: { input_tokens: 12, output_tokens: 4 },
                echoedKey: key,
              }),
              {
                headers: {
                  "content-type": "application/json",
                  "request-id": "req-123",
                  "set-cookie": "secret-cookie",
                },
              },
            ),
          );
        },
      ),
    );
    const events = readTraceEvents(path).events;
    const body = events.find((event) => event.name === "response_body")!
      .data as { payload: Parameters<typeof readTracePayload>[1] };
    expect(readTracePayload(path, body.payload)).toEqual({
      model: "served-model",
      usage: { input_tokens: 12, output_tokens: 4 },
      echoedKey: "[REDACTED]",
    });
    expect(
      events.find((event) => event.name === "response_headers")!.data,
    ).toMatchObject({ headers: { "request-id": "req-123" } });
    expect(await response.json()).toMatchObject({ echoedKey: key });
    const saved = [
      ...readdirSync(join(path, "traces", "blobs")).map((file) =>
        readFileSync(join(path, "traces", "blobs", file), "utf8"),
      ),
      JSON.stringify(events),
    ].join("\n");
    expect(saved).not.toContain(key);
    expect(saved).not.toContain("secret-cookie");
  });

  it("refuses network work when the trace cannot be persisted", async () => {
    const path = root();
    writeFileSync(join(path, "traces"), "not a directory");
    const fetcher = vi.fn();
    await expect(
      withTraceSession(createTraceSession(path), () =>
        tracedFetch("https://example.test", undefined, fetcher),
      ),
    ).rejects.toBeInstanceOf(TracePersistenceError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves response headers if the body fails in transit", async () => {
    const path = root();
    await expect(
      withTraceSession(createTraceSession(path), () =>
        tracedFetch("https://example.test", undefined, () =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("interrupted body"));
                },
              }),
              { headers: { "request-id": "req-interrupted" } },
            ),
          ),
        ),
      ),
    ).rejects.toThrow("interrupted body");
    expect(readTraceEvents(path).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "response_headers" }),
        expect.objectContaining({ kind: "http", phase: "failed" }),
      ]),
    );
  });

  it("survives SIGKILL without a shutdown handler and identifies unfinished work", () => {
    const path = root();
    const script = `import { createTraceSession, withTraceSession, traceOperation, traceCheckpoint } from './src/telemetry/trace.ts';
      await withTraceSession(createTraceSession(${JSON.stringify(path)}), () => traceOperation('llm.attempt', 'adjudication', { model: 'example' }, async () => {
        traceCheckpoint('response_body', { usage: { input_tokens: 10, output_tokens: 3 } });
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => {});
      }));`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), timeout: 10_000 },
    );
    expect(child.signal).toBe("SIGKILL");
    expect(readTraceEvents(path).events.map((event) => event.name)).toEqual([
      "adjudication",
      "response_body",
    ]);
    expect(inspectTrace(path)).toMatchObject({
      unresolvedModelAttempts: 1,
      incomplete: [expect.objectContaining({ kind: "llm.attempt" })],
    });
  });

  it("reports torn final appends and rejects corrupted payloads", async () => {
    const path = root();
    const session = createTraceSession(path);
    await withTraceSession(session, () =>
      traceOperation("tool", "example", { value: 1 }, () =>
        Promise.resolve(true),
      ),
    );
    appendFileSync(
      join(session.root, "sessions", `${session.sessionId}.jsonl`),
      '{"version":',
    );
    expect(inspectTrace(path)).toMatchObject({
      eventCount: 2,
      incompleteJournals: [`${session.sessionId}.jsonl`],
    });
    const payload = readTraceEvents(path).events[0]!.payload!;
    writeFileSync(join(session.root, payload.file), "tampered");
    expect(() => readTracePayload(path, payload)).toThrow("hash mismatch");
  });
});
