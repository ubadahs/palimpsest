/**
 * LLM-based claim-family filter.
 *
 * After BM25 pre-filtering, each surviving citing paper is individually
 * assessed by Haiku 4.5 (with extended thinking) for semantic relevance
 * to the grounded seed claim. Papers that pass both gates stay in the
 * claim family.
 */

import { z } from "zod";

import type { LLMClient } from "../integrations/llm-client.js";
import type { Result } from "../domain/types.js";
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";
import { pMap } from "../shared/p-map.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaimFamilyCandidate = {
  citingPaperId: string;
  title: string;
  abstract: string;
};

const filterResultSchema = z.object({
  relevant: z.boolean(),
  reason: z.string(),
});

export type LLMClaimFamilyFilterResult = {
  citingPaperId: string;
  relevant: boolean;
  reason: string;
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildFilterPrompt(
  seedClaim: string,
  seedTitle: string,
  candidate: ClaimFamilyCandidate,
): string {
  return `You are a citation relevance filter for a citation fidelity audit.

## Task

A seed paper makes a specific claim. A citing paper references the seed paper. Your job: determine whether this citing paper is likely citing the seed paper **in relation to** the tracked claim below — not merely citing it for an unrelated finding.

## Seed paper

Title: "${seedTitle}"

## Tracked claim (grounded in the seed paper)

"${seedClaim}"

## Citing paper

Title: "${candidate.title}"
Abstract: "${candidate.abstract}"

## Instructions

- Answer whether this citing paper plausibly references the seed paper in connection with the tracked claim.
- A paper is relevant if its abstract suggests it engages with the same specific topic, finding, or methodological contribution described in the tracked claim.
- A paper is NOT relevant if it cites the seed paper for an unrelated finding, a different dataset, or purely as general background on a broader field.
- When in doubt, lean towards relevant (false negatives are worse than false positives).

Return a JSON object:
{
  "relevant": true or false,
  "reason": "one sentence explaining why"
}`;
}

// ---------------------------------------------------------------------------
// Single-paper filter call
// ---------------------------------------------------------------------------

async function filterOneCandidate(
  client: LLMClient,
  seedClaim: string,
  seedTitle: string,
  candidate: ClaimFamilyCandidate,
  thinkingBudget: number,
  model: string,
): Promise<Result<LLMClaimFamilyFilterResult>> {
  const prompt = buildFilterPrompt(seedClaim, seedTitle, candidate);

  try {
    const result = await client.generateText({
      purpose: "claim-family-filter",
      model,
      prompt,
      thinking: { type: "enabled", budgetTokens: thinkingBudget },
    });

    const parsed = filterResultSchema.parse(
      JSON.parse(extractJsonFromModelText(result.text)),
    );

    return {
      ok: true,
      data: {
        citingPaperId: candidate.citingPaperId,
        relevant: parsed.relevant,
        reason: parsed.reason,
      },
    };
  } catch (error) {
    // On failure, default to keeping the paper (false negatives are worse).
    return {
      ok: false,
      error: `LLM claim-family filter failed for ${candidate.citingPaperId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LLMClaimFamilyFilterOptions = {
  /** Thinking budget in tokens per candidate. Default 4096. */
  thinkingBudget?: number;
  /** Max concurrent LLM calls. Default 10. */
  concurrency?: number;
  /** Model to use. Default "claude-haiku-4-5". */
  model?: string;
};

/**
 * Run LLM claim-family filtering on BM25 survivors.
 *
 * Returns a Set of citingPaperIds that the LLM considers relevant.
 * Papers where the LLM call fails are kept (fail-open).
 */
export async function llmFilterClaimFamily(
  client: LLMClient,
  seedClaim: string,
  seedTitle: string,
  candidates: ClaimFamilyCandidate[],
  options: LLMClaimFamilyFilterOptions = {},
): Promise<LLMClaimFamilyFilterResult[]> {
  if (candidates.length === 0) {
    return [];
  }

  const thinkingBudget = options.thinkingBudget ?? 4096;
  const concurrency = options.concurrency ?? 10;
  const model = options.model ?? "claude-haiku-4-5";

  const results = await pMap(
    candidates,
    async (candidate) => {
      const r = await filterOneCandidate(
        client,
        seedClaim,
        seedTitle,
        candidate,
        thinkingBudget,
        model,
      );
      if (r.ok) return r.data;
      // Fail-open: keep the paper.
      return {
        citingPaperId: candidate.citingPaperId,
        relevant: true,
        reason: `LLM filter failed (kept by default): ${r.error}`,
      } satisfies LLMClaimFamilyFilterResult;
    },
    { concurrency },
  );

  return results;
}
