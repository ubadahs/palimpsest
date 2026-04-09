import type { NextApiRequest, NextApiResponse } from "next";

export function readQueryParam(request: NextApiRequest, key: string): string {
  const value = request.query[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing query param: ${key}`);
}

/** Optional non-negative integer query param (e.g. `familyIndex` for per-family stage rows). */
export function readOptionalFamilyIndex(
  request: NextApiRequest,
): number | undefined {
  const value = request.query["familyIndex"];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

export function allowMethods(
  request: NextApiRequest,
  response: NextApiResponse,
  methods: readonly string[],
): boolean {
  if (!request.method || methods.includes(request.method)) {
    return true;
  }

  response.setHeader("Allow", methods.join(", "));
  response.status(405).json({ error: `Method ${request.method} not allowed` });
  return false;
}

export function handleApiError(
  response: NextApiResponse,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  response.status(400).json({ error: message });
}
