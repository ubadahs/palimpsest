import type { NextApiRequest, NextApiResponse } from "next";

export function readQueryParam(
  request: NextApiRequest,
  key: string,
): string {
  const value = request.query[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing query param: ${key}`);
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
