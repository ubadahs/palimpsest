import { traceOperation } from "../telemetry/trace.js";
import { tracedFetch } from "../telemetry/http.js";
/**
 * The HTTP side of every Jev provider, whichever model it serves: where
 * requests go, the key they carry, one request, how long to back off, and
 * the lock that keeps two processes off one quota.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildStableId } from "../shared/stable-identity.js";
import type { ProviderConfig } from "./config.js";
import type { JevAttempt } from "./optimization-contract.js";
import { evaluationRoot } from "./storage.js";

/** Typesafe's hosted Jev, used when a provider names no endpoint. */
const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_KEY_ENV = "TYPESAFE_API_KEY";
const MAX_BACKOFF_MS = 30_000;

type JevTransportResponse = {
  httpStatus: number;
  providerRequestId?: string;
  retryAfterMs?: number;
  body?: unknown;
  diagnostics?: JevAttempt["diagnostics"];
};

export type JevTransport = (
  provider: ProviderConfig,
  body: unknown,
  signal: AbortSignal,
  timeoutMs?: number,
) => Promise<JevTransportResponse>;

function keyEnv(provider: ProviderConfig): string {
  return provider.apiKeyEnv ?? DEFAULT_KEY_ENV;
}

/** Why a provider cannot send requests yet, if it cannot. */
export function jevAccessError(provider: ProviderConfig): string | undefined {
  if (
    provider.endpoint == null &&
    provider.endpointEnv != null &&
    !process.env[provider.endpointEnv]
  )
    return `${provider.id}: missing ${provider.endpointEnv}`;
  return process.env[keyEnv(provider)]
    ? undefined
    : `${provider.id}: missing ${keyEnv(provider)}`;
}

export function jevEndpoint(provider: ProviderConfig): string {
  const endpoint =
    provider.endpoint ??
    (provider.endpointEnv
      ? process.env[provider.endpointEnv]
      : TYPESAFE_ENDPOINT);
  if (endpoint == null || !URL.canParse(endpoint))
    throw new Error(`Invalid endpoint for ${provider.id}`);
  return endpoint;
}

export function jevQuotaGroup(provider: ProviderConfig): string {
  const endpoint = new URL(jevEndpoint(provider));
  return `${endpoint.origin}${endpoint.pathname}|${provider.model}`;
}

/** Exponential backoff from `baseMs` for the given zero-based retry, capped. */
export function jevBackoffMs(baseMs: number, retry: number): number {
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** retry);
}

function retryAfterMs(value: string | null): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

/** Keep bounded provider diagnostics, never reflected credentials or cookies. */
function failureDiagnostics(response: Response, text: string, key: string) {
  const redact = (value: string) =>
    value
      .split(key)
      .join("[REDACTED]")
      .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(
        /((?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi,
        "$1[REDACTED]",
      );
  const safeBody = redact(text);
  const headerNames = [
    "content-type",
    "retry-after",
    "x-request-id",
    "x-vercel-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ];
  return {
    responseHeaders: Object.fromEntries(
      headerNames.flatMap((name) => {
        const value = response.headers.get(name);
        return value == null ? [] : [[name, redact(value)]];
      }),
    ),
    errorBody: safeBody.slice(0, 4096),
    bodyTruncated: safeBody.length > 4096,
  };
}

/** One request. HTTP errors come back as a status; only the network throws. */
export const fetchJev: JevTransport = async (
  provider,
  body,
  signal,
  timeoutMs,
) =>
  traceOperation(
    "llm.external",
    "jev",
    { provider: provider.id, requestedModel: provider.model, body },
    async () => {
      const key = process.env[keyEnv(provider)];
      if (!key) throw new Error(`Missing ${keyEnv(provider)}`);
      const response = await tracedFetch(jevEndpoint(provider), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal:
          timeoutMs == null
            ? signal
            : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      const responseText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText) as unknown;
      } catch {
        parsed = undefined;
      }
      const requestId =
        response.headers.get("x-request-id") ??
        response.headers.get("x-vercel-id");
      const retryAfter = retryAfterMs(response.headers.get("retry-after"));
      return {
        httpStatus: response.status,
        ...(requestId ? { providerRequestId: requestId } : {}),
        ...(retryAfter != null ? { retryAfterMs: retryAfter } : {}),
        ...(parsed !== undefined ? { body: parsed } : {}),
        ...(!response.ok || parsed === undefined
          ? { diagnostics: failureDiagnostics(response, responseText, key) }
          : {}),
      };
    },
    { provider: provider.id, model: provider.model },
  );

function withQuotaLock<T>(
  provider: ProviderConfig,
  run: () => Promise<T>,
): Promise<T> {
  const lockDir = join(evaluationRoot(), "locks");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(
    lockDir,
    `${buildStableId("jev-quota", jevQuotaGroup(provider))}.lock`,
  );
  try {
    const current = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(current) || current <= 0)
      throw new Error("Jev quota lock is in use or unreadable");
    try {
      process.kill(current, 0);
      throw new Error(`Jev quota group is in use by process ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      try {
        unlinkSync(lockPath);
      } catch {
        /* stale lock removal is harmless */
      }
    });
}

/**
 * Runs holding one lock per quota group (endpoint and model), so two
 * processes never spend one quota at once. A group a live process already
 * holds fails at once rather than waiting.
 */
export function withJevQuotaLocks<T>(
  providers: readonly ProviderConfig[],
  run: () => Promise<T>,
): Promise<T> {
  return [
    ...new Map(
      providers.map((provider) => [jevQuotaGroup(provider), provider]),
    ),
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .reduceRight<() => Promise<T>>(
      (next, [, provider]) =>
        () =>
          withQuotaLock(provider, next),
      run,
    )();
}
