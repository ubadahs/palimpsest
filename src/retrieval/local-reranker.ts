import { z } from "zod";

import type { Result } from "../domain/types.js";

const rerankResultSchema = z.object({
  id: z.string().min(1),
  score: z.number(),
  rank: z.number().int().positive(),
});

const rerankResponseSchema = z.object({
  results: z.array(rerankResultSchema),
});

export type RerankDocument = {
  id: string;
  text: string;
};

export type RerankResponse = z.infer<typeof rerankResponseSchema>;

export type LocalReranker = {
  rerank: (
    query: string,
    documents: RerankDocument[],
    topN: number,
  ) => Promise<Result<RerankResponse>>;
  healthCheck: () => Promise<Result<string>>;
};

const REQUEST_TIMEOUT_MS = 10_000;

export function createLocalReranker(
  baseUrl: string | undefined,
): LocalReranker | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return {
    async rerank(query, documents, topN) {
      try {
        const response = await fetch(`${normalizedBaseUrl}/rerank`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "citation-fidelity/0.1",
          },
          body: JSON.stringify({ query, documents, topN }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          return {
            ok: false,
            error: `Reranker HTTP ${String(response.status)} from ${normalizedBaseUrl}`,
          };
        }

        const json: unknown = await response.json();
        const parsed = rerankResponseSchema.parse(json);
        return { ok: true, data: parsed };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async healthCheck() {
      try {
        const response = await fetch(`${normalizedBaseUrl}/health`, {
          headers: {
            "User-Agent": "citation-fidelity/0.1",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          return {
            ok: false,
            error: `Reranker HTTP ${String(response.status)} from ${normalizedBaseUrl}`,
          };
        }
        return { ok: true, data: "ok" };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
