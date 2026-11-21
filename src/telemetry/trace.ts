import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const blobSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  file: z.string().regex(/^blobs\/[a-f0-9]{64}$/),
});
const traceEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string(),
  sessionId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  timestamp: z.string(),
  kind: z.string(),
  name: z.string(),
  phase: z.enum(["started", "checkpoint", "completed", "failed"]),
  labels: z.record(z.string(), z.string()),
  data: z.unknown().optional(),
  payload: blobSchema.optional(),
});
export type TraceEvent = z.infer<typeof traceEventSchema>;
export type TraceBlob = z.infer<typeof blobSchema>;

export class TracePersistenceError extends Error {
  override readonly name = "TracePersistenceError";
}

export function rethrowTraceError(error: unknown): void {
  if (error instanceof TracePersistenceError) throw error;
  // SDKs may wrap fetch failures; persistence failures must still stop retries.
  if (error instanceof Error && error.cause !== error && error.cause != null)
    rethrowTraceError(error.cause);
}

const sensitiveKey =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|signature|x-amz-credential|x-amz-signature)$/i;
const sensitiveUrlKey =
  /^(key|sig|x-amz-security-token|x-goog-credential|x-goog-signature|awsaccesskeyid)$/i;

/** Preserve scientific text and token fields; remove credential-bearing fields. */
export function redactTrace(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets)
      if (secret) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
        try {
          return safeTraceUrl(url);
        } catch {
          return url;
        }
      });
  }
  if (Array.isArray(value)) return value.map((v) => redactTrace(v, secrets));
  if (value && typeof value === "object") {
    if (value instanceof Error)
      return {
        name: value.name,
        message: redactTrace(value.message, secrets),
        stack: redactTrace(value.stack, secrets),
      };
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redactTrace(v, secrets),
      ]),
    );
  }
  return value;
}

export function safeTraceUrl(input: string): string {
  const url = new URL(input);
  const hasSecrets = traceUrlSecrets(input).length > 0;
  if (!hasSecrets) return input;
  if (url.username) url.username = "REDACTED";
  if (url.password) url.password = "REDACTED";
  for (const key of url.searchParams.keys())
    if (sensitiveKey.test(key) || sensitiveUrlKey.test(key))
      url.searchParams.set(key, "REDACTED");
  return url.toString();
}

export function traceUrlSecrets(input: string): string[] {
  const url = new URL(input);
  return [
    url.username,
    url.password,
    ...[...url.searchParams]
      .filter(([key]) => sensitiveKey.test(key) || sensitiveUrlKey.test(key))
      .map(([, value]) => value),
  ].filter(Boolean);
}

type TraceContext = {
  session: TraceSession;
  spanId?: string;
  labels: Record<string, string>;
};
const context = new AsyncLocalStorage<TraceContext>();
const standalone = new Map<string, TraceSession>();

export type TraceSession = {
  root: string;
  sessionId: string;
  labels: Record<string, string>;
  protect: (secrets: readonly string[]) => void;
  blob: (value: unknown) => TraceBlob;
  bytes: (value: Uint8Array) => TraceBlob;
  append: (
    event: Omit<TraceEvent, "version" | "eventId" | "sessionId" | "timestamp">,
  ) => void;
  recordCall: (callId: string, record: unknown) => void;
};

/** One journal per process invocation; shared content-addressed payloads per owner. */
export function createTraceSession(
  ownerRoot: string,
  labels: Record<string, string> = {},
): TraceSession {
  const root = resolve(ownerRoot, "traces");
  const sessionId = randomUUID();
  const journal = resolve(root, "sessions", `${sessionId}.jsonl`);
  const recordedCalls = new Set<string>();
  const secrets = new Set<string>();
  let persistenceFailure: TracePersistenceError | undefined;
  function persist<T>(fn: () => T): T {
    if (persistenceFailure) throw persistenceFailure;
    try {
      return fn();
    } catch (cause) {
      persistenceFailure = new TracePersistenceError(
        `Cannot persist trace in ${root}; refusing unlogged work`,
        { cause },
      );
      throw persistenceFailure;
    }
  }
  const session: TraceSession = {
    root,
    sessionId,
    labels,
    protect(values) {
      for (const value of values) if (value) secrets.add(value);
    },
    bytes(value) {
      return persist(() => {
        const sha256 = createHash("sha256").update(value).digest("hex");
        const file = `blobs/${sha256}`;
        const path = resolve(root, file);
        mkdirSync(resolve(root, "blobs"), { recursive: true });
        if (!existsSync(path)) {
          const temporary = `${path}.${randomUUID()}.tmp`;
          writeFileSync(temporary, value, { flag: "wx", flush: true });
          renameSync(temporary, path);
        }
        return { sha256, bytes: value.byteLength, file };
      });
    },
    blob(value) {
      return session.bytes(
        Buffer.from(JSON.stringify(redactTrace(value, [...secrets])) ?? "null"),
      );
    },
    append(event) {
      persist(() => {
        mkdirSync(resolve(root, "sessions"), { recursive: true });
        appendFileSync(
          journal,
          `${JSON.stringify(redactTrace({ ...event, version: 1, eventId: randomUUID(), sessionId, timestamp: new Date().toISOString() }, [...secrets]))}\n`,
          { flush: true },
        );
      });
    },
    recordCall(callId, record) {
      if (recordedCalls.has(callId)) return;
      const active = context.getStore();
      session.append({
        spanId: active?.spanId ?? callId,
        kind: "llm",
        name: "usage",
        phase: "checkpoint",
        labels: { ...labels, ...active?.labels },
        data: redactTrace(record),
      });
      recordedCalls.add(callId);
    },
  };
  return session;
}

export function currentTraceSession(): TraceSession {
  const active = context.getStore();
  if (active) return active.session;
  const cwd = process.cwd();
  const owner = process.env["PALIMPSEST_TRACE_ROOT"];
  const key = owner ? resolve(owner) : cwd;
  let session = standalone.get(key);
  if (!session) {
    session = createTraceSession(
      owner ?? resolve(cwd, "data", "standalone", randomUUID()),
      { owner: "standalone" },
    );
    standalone.set(key, session);
  }
  return session;
}

export function currentTraceSpanId(): string | undefined {
  return context.getStore()?.spanId;
}

/** Keep queued work attached to the caller that scheduled it. */
export function bindTraceContext<T extends (...args: never[]) => unknown>(
  fn: T,
): T {
  return AsyncLocalStorage.bind(fn);
}

/** Reuse an owner's active session when one entrypoint calls another. */
export function withTraceOwner<T>(
  ownerRoot: string,
  labels: Record<string, string>,
  fn: () => T,
): T {
  const active = context.getStore();
  return withTraceSession(
    active?.session.root === resolve(ownerRoot, "traces")
      ? active.session
      : createTraceSession(ownerRoot, labels),
    fn,
  );
}

export function withTraceSession<T>(session: TraceSession, fn: () => T): T {
  const active = context.getStore();
  if (active?.session === session) return fn();
  return context.run({ session, labels: session.labels }, fn);
}

export function traceCheckpoint(name: string, data: unknown): void {
  const active = context.getStore();
  const session = currentTraceSession();
  session.append({
    spanId: active?.spanId ?? randomUUID(),
    kind: "checkpoint",
    name,
    phase: "checkpoint",
    labels: active?.labels ?? session.labels,
    data: redactTrace(data),
  });
}

export async function traceOperation<T>(
  kind: string,
  name: string,
  input: unknown,
  fn: (spanId: string) => Promise<T>,
  labels: Record<string, string> = {},
): Promise<T> {
  const active = context.getStore();
  const session = currentTraceSession();
  const spanId = randomUUID();
  const common = {
    spanId,
    ...(active?.spanId ? { parentSpanId: active.spanId } : {}),
    kind,
    name,
    labels: { ...session.labels, ...active?.labels, ...labels },
  };
  session.append({ ...common, phase: "started", payload: session.blob(input) });
  return context.run({ session, spanId, labels: common.labels }, async () => {
    try {
      const result = await fn(spanId);
      session.append({
        ...common,
        phase: "completed",
        payload: session.blob(result),
      });
      return result;
    } catch (error) {
      rethrowTraceError(error);
      session.append({ ...common, phase: "failed", data: redactTrace(error) });
      throw error;
    }
  });
}

/** Adapter calls include cache hits and local parsing, not just HTTP traffic. */
export function traceMethods<T extends object>(name: string, methods: T): T {
  return new Proxy(methods, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        traceOperation("tool", `${name}.${String(property)}`, args, () =>
          Promise.resolve(Reflect.apply(value, target, args) as unknown),
        );
    },
  });
}

/** A torn final append is reported, never silently interpreted as a complete log. */
export function readTraceEvents(ownerRoot: string): {
  events: TraceEvent[];
  incompleteJournals: string[];
} {
  const directory = resolve(ownerRoot, "traces", "sessions");
  if (!existsSync(directory)) return { events: [], incompleteJournals: [] };
  const events: TraceEvent[] = [];
  const incompleteJournals: string[] = [];
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()) {
    const text = readFileSync(resolve(directory, file), "utf8");
    const lines = text.split("\n");
    if (lines.at(-1) !== "") {
      incompleteJournals.push(file);
      lines.pop();
    }
    for (const line of lines)
      if (line) events.push(traceEventSchema.parse(JSON.parse(line)));
  }
  return { events, incompleteJournals };
}

export function readTracePayload(ownerRoot: string, blob: TraceBlob): unknown {
  blobSchema.parse(blob);
  if (blob.file !== `blobs/${blob.sha256}`)
    throw new Error("Invalid trace payload path");
  const bytes = readFileSync(resolve(ownerRoot, "traces", blob.file));
  if (createHash("sha256").update(bytes).digest("hex") !== blob.sha256)
    throw new Error(`Trace payload hash mismatch: ${blob.file}`);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

export function inspectTrace(ownerRoot: string) {
  const { events, incompleteJournals } = readTraceEvents(ownerRoot);
  const closed = new Set(
    events
      .filter(
        (event) => event.phase === "completed" || event.phase === "failed",
      )
      .map((event) => event.spanId),
  );
  const starts = events.filter((event) => event.phase === "started");
  const usage = new Set(
    events
      .filter((event) => event.kind === "llm" && event.name === "usage")
      .map((event) => event.spanId),
  );
  const byKind: Record<string, number> = {};
  for (const event of starts)
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
  return {
    eventCount: events.length,
    byKind,
    incompleteJournals,
    incomplete: starts.filter((event) => !closed.has(event.spanId)),
    unresolvedModelAttempts: starts.filter(
      (event) => event.kind === "llm.attempt" && !usage.has(event.spanId),
    ).length,
    unpricedExternalCalls: byKind["llm.external"] ?? 0,
  };
}
