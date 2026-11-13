/** Scope's prompt identities and the grounding prompt. The codebook prompts live in `seed-codebook.ts`. */

import { PROMPT_VERSIONS } from "../../config/prompt-versions.js";

export const GROUNDING_PROMPT_ID = "scope-grounding" as const;

export const GROUNDING_PROMPT_VERSION = PROMPT_VERSIONS.grounding;

export const SEED_CODEBOOK_PROMPT_ID = "seed-codebook" as const;

export const SEED_CODEBOOK_PROMPT_VERSION = PROMPT_VERSIONS.seedCodebook;

export const CODEBOOK_TAGGING_PROMPT_ID = "codebook-tagging" as const;

export const CODEBOOK_TAGGING_PROMPT_VERSION = PROMPT_VERSIONS.codebookTagging;

/**
 * The grounding prompt is split so the seed text (identical for every family
 * of a seed) is a cacheable prefix and only the family claim varies.
 */

export function buildScopeGroundingPrompt(input: {
  claim: string;
  seedTitle: string;
  blocks: Array<{
    blockId: string;
    text: string;
    sectionTitle?: string | undefined;
    blockKind: string;
  }>;
}): { prefix: string; suffix: string } {
  const blockText = input.blocks
    .map((block) => {
      const section = block.sectionTitle
        ? ` section="${block.sectionTitle}"`
        : "";
      return `### blockId=${block.blockId} (${block.blockKind}${section})\n${block.text}`;
    })
    .join("\n\n");

  const prefix = `You are assisting a metascience project that audits citation fidelity.

Ground the claim below against the immutable seed-text blocks below. Quotes must be exact contiguous substrings of the referenced block.

## Seed paper

Title: ${input.seedTitle}

## Seed-text blocks

${blockText}

`;
  const suffix = `## Claim

"${input.claim}"

## Response format

Respond with JSON (no markdown fences):
{
  "status": "grounded" | "ambiguous" | "not_found",
  "detailReason": "string",
  "supportSpans": [ { "verbatimQuote": "exact substring", "blockId": "block id from above" } ]
}
Rules:
- grounded/ambiguous require at least one supportSpan with an exact quote and correct blockId
- not_found must use an empty supportSpans array
- never invent blockIds`;
  return { prefix, suffix };
}
