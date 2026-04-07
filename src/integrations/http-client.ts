import type { z } from "zod";

import type { Result } from "../domain/types.js";

export type FetchJsonOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

const USER_AGENT =
  "palimpsest/0.1 (https://github.com/ubadahs/palimpsest)";

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  options: FetchJsonOptions = {},
): Promise<Result<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...options.headers,
  };

  let lastError = "Unknown error";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        if (isRetryable(response.status) && attempt < maxRetries - 1) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          lastError = `HTTP ${String(response.status)}`;
          continue;
        }
        return {
          ok: false,
          error: `HTTP ${String(response.status)} from ${url}`,
        };
      }

      const json: unknown = await response.json();
      const parsed = schema.safeParse(json);

      if (!parsed.success) {
        return { ok: false, error: `Invalid response shape from ${url}` };
      }

      return { ok: true, data: parsed.data };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries - 1) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
    }
  }

  return {
    ok: false,
    error: `Failed after ${String(maxRetries)} attempts: ${lastError}`,
  };
}
