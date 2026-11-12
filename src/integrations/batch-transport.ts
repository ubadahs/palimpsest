/**
 * Message Batches API as a transport under the Anthropic provider.
 *
 * The provider builds each Messages request and parses each reply exactly as
 * it does for a direct call; only the `fetch` underneath changes. A
 * `POST /v1/messages` is held in a queue with its exact body, the queue is
 * submitted as one batch once it goes quiet, and each caller gets back a
 * synthetic `Response` built from its batch result: the same Message JSON a
 * direct call returns, or an error body and status that make the provider
 * raise the error a direct call would. Validation, the exact-result cache,
 * retries, error classification, and telemetry above the provider are
 * untouched.
 *
 * A submitted batch is billed even if this process dies before reading it, so
 * every submitted request is recorded (see `storage/llm-batch-requests.ts`).
 * Its `custom_id` is a hash of its body and headers, so the same request on a
 * later run finds that batch and takes its result instead of being sent again.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  BATCH_RESULTS_RETENTION_DAYS,
  createMemoryBatchRequestStore,
  type BatchRequestStore,
} from "../storage/llm-batch-requests.js";

/** Response header that tells the client a reply was served from a batch. */
export const TRANSPORT_HEADER = "x-palimpsest-transport";

export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BatchTransportSettings = {
  /** Submit once no request has joined the queue for this long. */
  idleMs?: number;
  /** Submit at once when the queue reaches this many requests. */
  maxBatchRequests?: number;
  /** Submit at once when the queued request bodies reach this many bytes. */
  maxBatchBytes?: number;
  /**
   * A queue that goes quiet with fewer requests than this is sent directly:
   * one or two requests (a clustering call, a prompt-cache write) would
   * otherwise wait minutes for a batch to save cents.
   */
  directBelow?: number;
  /** First wait before polling a new batch; doubles up to `pollMaxMs`. */
  pollInitialMs?: number;
  pollMaxMs?: number;
  /** Batch results are kept by the API for 29 days; older rows are resent. */
  retentionMs?: number;
};

export type BatchTransportOptions = BatchTransportSettings & {
  /** The network fetch batches and direct sends go through. */
  fetch?: FetchFunction;
  store?: BatchRequestStore;
  now?: () => Date;
  log?: (message: string) => void;
};

export type BatchTransport = {
  fetch: FetchFunction;
};

const DEFAULTS = {
  idleMs: 2_000,
  // The API takes up to 100,000 requests or 256 MB; staying well under keeps
  // one oversized stage from being rejected whole.
  maxBatchRequests: 10_000,
  maxBatchBytes: 200 * 1024 * 1024,
  directBelow: 5,
  pollInitialMs: 15_000,
  pollMaxMs: 60_000,
  retentionMs: BATCH_RESULTS_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
} satisfies Required<BatchTransportSettings>;

/** Status a direct call returns for each API error type. */
const STATUS_BY_ERROR_TYPE: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

const batchSchema = z.object({
  id: z.string().min(1),
  processing_status: z.enum(["in_progress", "canceling", "ended"]),
  results_url: z.string().nullable().optional(),
});

const resultLineSchema = z.object({
  custom_id: z.string().min(1),
  result: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("succeeded"),
      message: z.record(z.string(), z.unknown()),
    }),
    z.object({ type: z.literal("errored"), error: z.unknown() }),
    z.object({ type: z.literal("canceled") }),
    z.object({ type: z.literal("expired") }),
  ]),
});

type BatchResult = z.infer<typeof resultLineSchema>["result"];

const apiErrorSchema = z.object({
  type: z.string().min(1),
  message: z.string(),
});

type Waiter = {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

type Entry = {
  customId: string;
  url: string;
  init: RequestInit;
  params: Record<string, unknown>;
  bytes: number;
  waiters: Waiter[];
};

/** Requests that can share a batch: same endpoint, key, version and betas. */
type Group = {
  baseUrl: string;
  headers: Record<string, string>;
  queue: Entry[];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const FORWARDED_HEADERS = [
  "x-api-key",
  "authorization",
  "anthropic-version",
  "anthropic-beta",
] as const;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function errorResponse(status: number, type: string, message: string) {
  return jsonResponse(status, { type: "error", error: { type, message } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      [TRANSPORT_HEADER]: "batch",
    },
  });
}

/**
 * The reply a direct call would have produced. Expired and canceled requests
 * were never processed and are not billed, so they come back as transient
 * errors that the provider and client retries resend.
 */
function responseForResult(result: BatchResult): Response {
  switch (result.type) {
    case "succeeded":
      return jsonResponse(200, result.message);
    case "errored": {
      // The API wraps the error as it would a direct reply's body; accept the
      // bare error object too.
      const wrapped = z
        .object({ error: apiErrorSchema })
        .safeParse(result.error);
      const bare = apiErrorSchema.safeParse(result.error);
      const error = wrapped.success
        ? wrapped.data.error
        : bare.success
          ? bare.data
          : { type: "api_error", message: "Batch request errored" };
      return errorResponse(
        STATUS_BY_ERROR_TYPE[error.type] ?? 500,
        error.type,
        error.message,
      );
    }
    case "expired":
      return errorResponse(
        504,
        "timeout_error",
        "Batch request expired: the batch timed out before this request was processed",
      );
    case "canceled":
      return errorResponse(
        500,
        "api_error",
        "Batch request was canceled before it was processed",
      );
  }
}

function parseResultLine(text: string) {
  try {
    const parsed = resultLineSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createBatchTransport(
  options: BatchTransportOptions = {},
): BatchTransport {
  const settings = {
    idleMs: options.idleMs ?? DEFAULTS.idleMs,
    maxBatchRequests: options.maxBatchRequests ?? DEFAULTS.maxBatchRequests,
    maxBatchBytes: options.maxBatchBytes ?? DEFAULTS.maxBatchBytes,
    directBelow: options.directBelow ?? DEFAULTS.directBelow,
    pollInitialMs: options.pollInitialMs ?? DEFAULTS.pollInitialMs,
    pollMaxMs: options.pollMaxMs ?? DEFAULTS.pollMaxMs,
    retentionMs: options.retentionMs ?? DEFAULTS.retentionMs,
  };
  const network: FetchFunction =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const store = options.store ?? createMemoryBatchRequestStore();
  const now = options.now ?? (() => new Date());
  const log =
    options.log ??
    ((message: string) => {
      console.error(`[batch] ${message}`);
    });

  /** Every request not yet answered, queued or submitted, by custom_id. */
  const inFlight = new Map<string, Entry>();
  const groups = new Map<string, Group>();
  /** Custom ids this process waits on, per batch it is following. */
  const members = new Map<string, Set<string>>();

  function settle(entry: Entry, respond: () => Response): void {
    inFlight.delete(entry.customId);
    for (const waiter of entry.waiters) {
      waiter.resolve(respond());
    }
  }

  function fail(entry: Entry, error: unknown): void {
    inFlight.delete(entry.customId);
    for (const waiter of entry.waiters) {
      waiter.reject(error);
    }
  }

  function groupFor(url: string, headers: Headers): Group {
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = headers.get(name);
      if (value != null) forwarded[name] = value;
    }
    const baseUrl = url.replace(/\/messages\/?$/, "");
    const key = sha256(JSON.stringify([baseUrl, forwarded]));
    let group = groups.get(key);
    if (!group) {
      group = {
        baseUrl,
        headers: forwarded,
        queue: [],
        bytes: 0,
        timer: undefined,
      };
      groups.set(key, group);
    }
    return group;
  }

  function enqueue(group: Group, entry: Entry): void {
    group.queue.push(entry);
    group.bytes += entry.bytes;
    if (group.timer) clearTimeout(group.timer);
    group.timer = undefined;
    if (
      group.queue.length >= settings.maxBatchRequests ||
      group.bytes >= settings.maxBatchBytes
    ) {
      flush(group);
      return;
    }
    group.timer = setTimeout(() => {
      flush(group);
    }, settings.idleMs);
  }

  function flush(group: Group): void {
    if (group.timer) clearTimeout(group.timer);
    group.timer = undefined;
    const entries = group.queue.splice(0);
    group.bytes = 0;
    if (entries.length === 0) return;
    if (entries.length < settings.directBelow) {
      for (const entry of entries) sendDirect(entry);
      return;
    }
    void submit(group, entries);
  }

  function sendDirect(entry: Entry): void {
    network(entry.url, entry.init).then(
      (response) => {
        const [first, ...rest] = entry.waiters;
        const copies = rest.map(() => response.clone());
        inFlight.delete(entry.customId);
        first?.resolve(response);
        rest.forEach((waiter, index) => {
          waiter.resolve(copies[index]!);
        });
      },
      (error: unknown) => {
        fail(entry, error);
      },
    );
  }

  async function submit(group: Group, entries: Entry[]): Promise<void> {
    let response: Response;
    try {
      response = await network(`${group.baseUrl}/messages/batches`, {
        method: "POST",
        headers: { ...group.headers, "content-type": "application/json" },
        body: JSON.stringify({
          requests: entries.map((entry) => ({
            custom_id: entry.customId,
            params: entry.params,
          })),
        }),
      });
    } catch (error) {
      // As a direct call's network failure would: the provider retries.
      for (const entry of entries) fail(entry, error);
      return;
    }

    if (!response.ok) {
      // The batch was refused whole (bad key, rate limit, malformed request):
      // every caller sees the reply its own direct call would have had.
      const body = await response.text();
      const status = response.status;
      const contentType =
        response.headers.get("content-type") ?? "application/json";
      for (const entry of entries) {
        settle(
          entry,
          () =>
            new Response(body, {
              status,
              headers: {
                "content-type": contentType,
                [TRANSPORT_HEADER]: "batch",
              },
            }),
        );
      }
      return;
    }

    const batch = batchSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!batch.success) {
      for (const entry of entries) {
        settle(entry, () =>
          errorResponse(500, "api_error", "Unreadable batch create response"),
        );
      }
      return;
    }

    const batchId = batch.data.id;
    store.recordSubmitted(
      batchId,
      entries.map((entry) => entry.customId),
      now().toISOString(),
    );
    log(`submitted ${batchId} with ${String(entries.length)} requests`);
    follow(batchId, group, entries, settings.pollInitialMs);
  }

  /** Wait on `batchId` for `entries`, starting a poller if none runs yet. */
  function follow(
    batchId: string,
    group: Group,
    entries: Entry[],
    firstDelayMs: number,
  ): void {
    const existing = members.get(batchId);
    const ids = existing ?? new Set<string>();
    for (const entry of entries) ids.add(entry.customId);
    if (existing) return;
    members.set(batchId, ids);
    watch(batchId, group, firstDelayMs).catch((error: unknown) => {
      // Never leave a caller hanging on a poller that broke.
      const message = error instanceof Error ? error.message : String(error);
      finish(batchId, () =>
        errorResponse(500, "api_error", `Batch polling failed: ${message}`),
      );
    });
  }

  /** Answer every caller still waiting on `batchId` and stop following it. */
  function finish(batchId: string, respond: () => Response): void {
    for (const customId of members.get(batchId) ?? []) {
      const entry = inFlight.get(customId);
      if (entry) settle(entry, respond);
    }
    members.delete(batchId);
  }

  async function watch(
    batchId: string,
    group: Group,
    firstDelayMs: number,
  ): Promise<void> {
    let delay = firstDelayMs;
    let nextDelay = Math.max(settings.pollInitialMs, 1);
    for (;;) {
      if (delay > 0) await sleep(delay);
      delay = nextDelay;
      nextDelay = Math.min(settings.pollMaxMs, nextDelay * 2);

      let response: Response;
      try {
        response = await network(
          `${group.baseUrl}/messages/batches/${batchId}`,
          { method: "GET", headers: group.headers },
        );
      } catch (error) {
        log(
          `polling ${batchId} failed (${error instanceof Error ? error.message : String(error)}); retrying`,
        );
        continue;
      }
      if (response.status === 429 || response.status >= 500) continue;
      if (!response.ok) {
        // The batch cannot be read (another key, or gone): resend its
        // requests rather than wait forever.
        log(
          `${batchId} cannot be read (HTTP ${String(response.status)}); resubmitting its requests`,
        );
        abandon(batchId, group);
        return;
      }
      const batch = batchSchema.safeParse(
        await response.json().catch(() => undefined),
      );
      if (!batch.success || batch.data.processing_status !== "ended") {
        continue;
      }

      const resultsUrl =
        batch.data.results_url ??
        `${group.baseUrl}/messages/batches/${batchId}/results`;
      let results: Response;
      try {
        results = await network(resultsUrl, {
          method: "GET",
          headers: group.headers,
        });
      } catch {
        continue;
      }
      if (!results.ok) continue;
      deliver(batchId, await results.text());
      return;
    }
  }

  function deliver(batchId: string, jsonl: string): void {
    const ids = members.get(batchId) ?? new Set<string>();
    const counts = { succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    for (const line of jsonl.split("\n")) {
      if (line.trim().length === 0) continue;
      const parsed = parseResultLine(line);
      if (!parsed) continue;
      counts[parsed.result.type] += 1;
      const entry = ids.has(parsed.custom_id)
        ? inFlight.get(parsed.custom_id)
        : undefined;
      if (entry) {
        store.remove(parsed.custom_id);
        settle(entry, () => responseForResult(parsed.result));
      } else if (parsed.result.type === "succeeded") {
        // Paid for, and no one here asked: keep it for the run that does.
        store.storeResult(parsed.custom_id, line);
      } else {
        store.remove(parsed.custom_id);
      }
    }
    log(
      `${batchId} ended: ${String(counts.succeeded)} succeeded, ${String(counts.errored)} errored, ${String(counts.expired)} expired, ${String(counts.canceled)} canceled`,
    );
    for (const customId of ids) {
      if (inFlight.has(customId)) store.remove(customId);
    }
    finish(batchId, () =>
      errorResponse(500, "api_error", "Request missing from batch results"),
    );
  }

  function abandon(batchId: string, group: Group): void {
    const ids = members.get(batchId) ?? new Set<string>();
    members.delete(batchId);
    for (const customId of ids) {
      store.remove(customId);
      const entry = inFlight.get(customId);
      if (entry) enqueue(group, entry);
    }
  }

  function withinRetention(submittedAt: string): boolean {
    const submitted = Date.parse(submittedAt);
    return (
      Number.isFinite(submitted) &&
      now().getTime() - submitted < settings.retentionMs
    );
  }

  function accept(
    url: string,
    init: RequestInit,
    body: string,
    waiter: Waiter,
  ): void {
    const headers = new Headers(init.headers);
    const customId = sha256(
      JSON.stringify([
        headers.get("anthropic-version") ?? "",
        headers.get("anthropic-beta") ?? "",
        body,
      ]),
    );

    // An identical request already on its way: share its answer.
    const existing = inFlight.get(customId);
    if (existing) {
      existing.waiters.push(waiter);
      return;
    }

    let params: Record<string, unknown>;
    try {
      params = z.record(z.string(), z.unknown()).parse(JSON.parse(body));
      // A batch item cannot stream; the provider never asks it to here.
      delete params["stream"];
    } catch (error) {
      waiter.reject(error);
      return;
    }

    const entry: Entry = {
      customId,
      url,
      init,
      params,
      bytes: Buffer.byteLength(body),
      waiters: [waiter],
    };
    inFlight.set(customId, entry);
    const group = groupFor(url, headers);

    const row = store.get(customId);
    if (row && withinRetention(row.submittedAt)) {
      const stored =
        row.resultJson != null ? parseResultLine(row.resultJson) : undefined;
      if (stored) {
        log(`reusing a stored result from ${row.batchId}`);
        store.remove(customId);
        settle(entry, () => responseForResult(stored.result));
        return;
      }
      if (row.resultJson == null) {
        log(`waiting on ${row.batchId}, submitted earlier`);
        follow(row.batchId, group, [entry], 0);
        return;
      }
    }
    if (row) store.remove(customId);
    enqueue(group, entry);
  }

  return {
    fetch(input, init) {
      const url = requestUrl(input);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const body = init?.body;
      if (
        method !== "POST" ||
        !/\/messages\/?$/.test(new URL(url).pathname) ||
        typeof body !== "string"
      ) {
        return network(input, init);
      }
      return new Promise<Response>((resolve, reject) => {
        accept(url, init ?? {}, body, { resolve, reject });
      });
    },
  };
}
