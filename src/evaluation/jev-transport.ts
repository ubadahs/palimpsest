import type { ProviderConfig } from "./config.js";
import type { JevAttempt } from "./optimization-contract.js";

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
  timeoutMs: number,
) => Promise<JevTransportResponse>;

export function jevEndpoint(provider: ProviderConfig): string {
  const endpoint =
    provider.endpoint ??
    (provider.endpointEnv ? process.env[provider.endpointEnv] : undefined) ??
    "https://api.typesafe.ai/v1/systemone";
  if (!URL.canParse(endpoint))
    throw new Error(`Invalid endpoint for ${provider.id}`);
  return endpoint;
}

export function jevQuotaGroup(provider: ProviderConfig): string {
  const endpoint = new URL(jevEndpoint(provider));
  return `${endpoint.origin}${endpoint.pathname}|${provider.model}`;
}

export function retryAfterMs(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
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

export const fetchJev: JevTransport = async (
  provider,
  body,
  signal,
  timeoutMs,
) => {
  const keyEnv = provider.apiKeyEnv ?? "TYPESAFE_API_KEY";
  const key = process.env[keyEnv];
  if (!key) throw new Error(`Missing ${keyEnv}`);
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(jevEndpoint(provider), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, timeout]),
  });
  const responseText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    parsed = undefined;
  }
  return {
    httpStatus: response.status,
    ...(response.headers.get("x-request-id") ||
    response.headers.get("x-vercel-id")
      ? {
          providerRequestId:
            response.headers.get("x-request-id") ??
            response.headers.get("x-vercel-id")!,
        }
      : {}),
    ...(retryAfterMs(response.headers.get("retry-after")) != null
      ? { retryAfterMs: retryAfterMs(response.headers.get("retry-after"))! }
      : {}),
    ...(parsed !== undefined ? { body: parsed } : {}),
    ...(!response.ok || parsed === undefined
      ? { diagnostics: failureDiagnostics(response, responseText, key) }
      : {}),
  };
};
