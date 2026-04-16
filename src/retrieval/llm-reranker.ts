/**
 * LLM-based evidence reranker.
 *
 * Takes BM25 candidate blocks + the citing context, asks an LLM to:
 *   1. Semantically rank which blocks best support/refute the citing claim.
 *   2. Extract the 1-3 most relevant sentences from each top block.
 *
 * The prompt is tailored to the evaluation mode so that methods-use tasks
 * search for protocols and bundled/background tasks search for topical support.
 */

import { z } from "zod";

import type {
  ExactCacheConfig,
  LLMClient,
} from "../integrations/llm-client.js";
import type { EvaluationMode, Result } from "../domain/types.js";
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";

import { LLM_CACHE_VERSIONS } from "../config/llm-versions.js";

const RERANK_CACHE_KEY_VERSION = LLM_CACHE_VERSIONS.rerank;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LLMRerankCandidate = {
  blockId: string;
  text: string;
  sectionTitle?: string | undefined;
};

export type LLMRerankRequest = {
  /** Focused window around the citation marker (1-3 sentences). */
  citingContext: string;
  /** What the citation is supposed to support (seed claim or task claim). */
  claimSummary: string;
  /** Evaluation mode — drives what kind of evidence to look for. */
  evaluationMode: EvaluationMode;
  /** BM25-ranked candidate blocks from the cited paper. */
  candidates: LLMRerankCandidate[];
};

export type LLMRerankResult = {
  blockId: string;
  /** Relevance score 0-100, higher = more relevant. */
  relevanceScore: number;
  /** The 1-3 most relevant sentences extracted from this block. */
  extractedSentences: string;
};

export type LLMRerankResponse = {
  results: LLMRerankResult[];
};

// ---------------------------------------------------------------------------
// Schema for structured LLM output
// ---------------------------------------------------------------------------

const rerankItemSchema = z.object({
  blockId: z.string(),
  relevanceScore: z.number(),
  extractedSentences: z.string(),
});

const rerankResponseSchema = z.object({
  results: z.array(rerankItemSchema),
});

// ---------------------------------------------------------------------------
// Mode-specific retrieval guidance
// ---------------------------------------------------------------------------

function modeGuidance(mode: EvaluationMode): string {
  switch (mode) {
    case "fidelity_methods_use":
      return `This citation is being evaluated as a METHODS/PROTOCOL source. Prioritize passages from the Methods, Materials, or Experimental Procedures sections that describe specific protocols, reagents, instruments, or preparation steps matching the citing context. Do NOT rank scientific findings or discussion passages highly unless they contain the specific methodological detail cited.`;

    case "fidelity_specific_claim":
      return `This citation is being evaluated as a SPECIFIC EMPIRICAL CLAIM. Prioritize passages containing concrete data, results, or findings that directly address the specific assertion made in the citing context.`;

    case "fidelity_bundled_use":
      return `This citation is one of several bundled references supporting a general proposition. Prioritize passages that demonstrate the cited paper's topical relevance AND propositional support for the claim being made.`;

    case "fidelity_background_framing":
      return `This citation provides background context or framing. Prioritize passages that show the cited paper addresses the topic being characterized in the citing context.`;

    case "review_transmission":
      return `This citation is being evaluated for faithful transmission through a review paper. Prioritize passages containing the original finding or claim being relayed.`;

    case "manual_review_role_ambiguous":
      return `The citation role is ambiguous. First determine what the citing context is actually using this reference for (a method? a finding? anatomical context? background?), then prioritize passages that best match that actual use.`;

    default:
      return `Prioritize passages most directly relevant to how the citing context uses this reference.`;
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildRerankPrompt(request: LLMRerankRequest, topN: number): string {
  const candidateBlocks = request.candidates
    .map(
      (c, i) =>
        `--- Block ${String(i + 1)} [id: ${c.blockId}]${c.sectionTitle ? ` (section: ${c.sectionTitle})` : ""} ---\n${c.text}`,
    )
    .join("\n\n");

  return `You are a precision evidence retrieval assistant for a citation fidelity audit.

## Task

A citing paper references a cited paper. Below is the citing context and a set of candidate passages from the cited paper. Your job:

1. Rank the candidate passages by how directly they support (or contradict) the specific use made in the citing context.
2. For each of the top ${String(topN)} most relevant passages, extract the 1-3 most important sentences that a human reviewer would need to see to judge whether the citation is faithful.

## Evaluation mode guidance

${modeGuidance(request.evaluationMode)}

## Citing context (the sentence(s) containing the citation)

"${request.citingContext}"

## Family-level claim (for background only — the citing context takes priority)

"${request.claimSummary}"

## Candidate passages from cited paper

${candidateBlocks}

## Instructions

- The citing context is your PRIMARY signal. Match what it specifically says or implies about the cited paper.
- The family-level claim is secondary context — use it to break ties, not to override the citing context.
- The extractedSentences field should contain only the most relevant 1-3 sentences copied from the passage. These should be the sentences a reviewer needs to verify the citation.
- Return exactly the top ${String(topN)} most relevant passages (or fewer if fewer candidates are relevant).
- If a passage has zero relevance to the citing context, do not include it.

Return a JSON object with this structure:
{
  "results": [
    {
      "blockId": "the block id",
      "relevanceScore": 0-100,
      "extractedSentences": "The 1-3 key sentences from this passage."
    }
  ]
}

Order results by relevanceScore descending.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LLMRerankerOptions = {
  /** Model override (defaults to client default, which should be a fast/cheap model). */
  model?: string;
  /** How many top results to request from the LLM. Default 5. */
  topN?: number;
  /** Enable extended thinking (requires generateText path since generateObject doesn't support thinking). */
  useThinking?: boolean;
  /** Thinking budget in tokens. Default 8000. */
  thinkingBudget?: number;
  /** Enable persistent exact-result caching. */
  enableExactCache?: boolean;
};

function postProcess(
  raw: z.infer<typeof rerankResponseSchema>,
  validIds: Set<string>,
  topN: number,
): LLMRerankResponse {
  const sorted = [...raw.results].sort(
    (a, b) => b.relevanceScore - a.relevanceScore,
  );
  const filtered = sorted.filter((r) => validIds.has(r.blockId));
  return { results: filtered.slice(0, topN) };
}

export async function llmRerankBlocks(
  client: LLMClient,
  request: LLMRerankRequest,
  options: LLMRerankerOptions = {},
): Promise<Result<LLMRerankResponse>> {
  const topN = options.topN ?? 5;

  if (request.candidates.length === 0) {
    return { ok: true, data: { results: [] } };
  }

  const modelId = options.model ?? "claude-haiku-4-5";
  const prompt = buildRerankPrompt(request, topN);
  const validIds = new Set(request.candidates.map((c) => c.blockId));
  const exactCache: ExactCacheConfig | undefined = options.enableExactCache
    ? { keyVersion: RERANK_CACHE_KEY_VERSION }
    : undefined;

  try {
    if (options.useThinking) {
      // Thinking path: generateText + manual JSON parse.
      const result = await client.generateText({
        purpose: "evidence-rerank",
        model: modelId,
        prompt,
        thinking: {
          type: "enabled",
          budgetTokens: options.thinkingBudget ?? 8000,
        },
        ...(exactCache ? { exactCache } : {}),
      });
      const parsed = rerankResponseSchema.parse(
        JSON.parse(extractJsonFromModelText(result.text)),
      );
      return { ok: true, data: postProcess(parsed, validIds, topN) };
    }

    // Structured output path (default).
    const result = await client.generateObject({
      purpose: "evidence-rerank",
      model: modelId,
      prompt,
      schema: rerankResponseSchema,
      ...(exactCache ? { exactCache } : {}),
    });
    return { ok: true, data: postProcess(result.object, validIds, topN) };
  } catch (error) {
    return {
      ok: false,
      error: `LLM rerank failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
