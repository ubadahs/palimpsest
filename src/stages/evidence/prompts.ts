/** Evidence's relevance-rerank prompt. */

import { z } from "zod";
import { PROMPT_VERSIONS } from "../../config/prompt-versions.js";

export const RERANK_PROMPT_ID = "evidence-relevance-rerank" as const;

export const RERANK_PROMPT_VERSION = PROMPT_VERSIONS.rerank;

export function buildRelevanceRerankPrompt(input: {
  query: { text: string };
  topN: number;
  candidates: readonly {
    text: string;
    sourceBlockKind: string;
    sourceSectionTitle?: string | undefined;
    sourceSectionRole?: string | undefined;
    sourceCitesOtherWork?: boolean | undefined;
  }[];
}): string {
  // The reranker is an independent ranking: BM25 scores and ranks are withheld
  // so it cannot anchor on the ordering it exists to correct. Block kind and
  // section let it prefer the seed's own results over its background prose.
  const candidates = input.candidates
    .map((candidate, index) => {
      const section = candidate.sourceSectionTitle
        ? `, section="${candidate.sourceSectionTitle}"`
        : "";
      const role = candidate.sourceSectionRole
        ? `, role=${candidate.sourceSectionRole}`
        : "";
      const cites = candidate.sourceCitesOtherWork ? ", cites other work" : "";
      return `#${String(index + 1)} (${candidate.sourceBlockKind}${role}${section}${cites})\n${candidate.text}`;
    })
    .join("\n\n");

  return `You are ranking cited-paper chunks by relevance to a claim query.

Query: "${input.query.text}"

Return the top ${String(input.topN)} most relevant chunks. Relevance only — ignore citation fidelity judgments. Prefer chunks with role=results, figure, or table, and prefer chunks that do not cite other work: a passage marked "cites other work" is likely the cited paper summarizing prior findings rather than reporting its own. Candidate order carries no information.

Candidates:
${candidates}

Respond with JSON (no markdown fences), referring to candidates by their numbers:
{
  "results": [
    { "candidate": 3, "relevanceScore": 0-100, "rank": 1, "rationale": "..." }
  ]
}
Use only candidate numbers from the list above, each at most once. Ranks must be contiguous from 1.`;
}

/**
 * The model refers to candidates by number; 64-hex chunk ids were echoed
 * with typos often enough to lose a third of rerank calls. Out-of-range or
 * repeated numbers are dropped, results are ordered by score, and ranks are
 * reassigned contiguously before the contract schema is applied.
 */

export const rerankModelResponseSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            candidate: z.number().int().positive(),
            relevanceScore: z.number().min(0).max(100),
            rank: z.number().int().positive().optional(),
            rationale: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
