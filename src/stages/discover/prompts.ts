/** Discover's prompts: claim extraction per mention, and claim clustering per seed. */

import { z } from "zod";
import { PROMPT_VERSIONS } from "../../config/prompt-versions.js";
import { type DiscoverCitationOccurrence } from "../../contract/artifacts/index.js";

export const EXTRACTION_PROMPT_ID = "attributed-claim-extraction" as const;

export const EXTRACTION_PROMPT_VERSION = PROMPT_VERSIONS.extraction;

export const CLUSTERING_PROMPT_ID = "claim-clustering" as const;

export const CLUSTERING_PROMPT_VERSION = PROMPT_VERSIONS.clustering;

export function buildSingleMentionExtractionPrompt(input: {
  seedTitle: string;
  seedDoi?: string | undefined;
  citingTitle: string;
  mention: DiscoverCitationOccurrence;
}): string {
  const seedLabel = input.mention.seedRefLabel
    ? `\nSeed reference as it appears in this paper: ${input.mention.seedRefLabel}`
    : "";
  const bundleNote = input.mention.isBundledCitation
    ? `\nThis marker is shared with ${String(input.mention.bundleSize)} references. Attribute to the seed only what the sentence credits to the seed; a bundle-mate's finding is not the seed's.`
    : "";
  return `You are a scientific attribution extraction agent for a metascience project that audits citation fidelity.

## Task

Extract every distinct empirical claim that the citing paper attributes to the seed paper in this single mention. Only the sentence(s) that carry the seed's citation marker count; neighbouring sentences that cite other work are out of scope even if they appear in the context. Return zero claims when there is no in-scope attribution; do not merge distinct claims.

## Seed paper

Title: ${input.seedTitle}
DOI: ${input.seedDoi ?? "unknown"}

## Citing paper

Title: ${input.citingTitle}

## Mention

Section: ${input.mention.sectionTitle ?? "unknown"}
Citation marker: ${input.mention.citationMarker}${seedLabel}${bundleNote}
Context:
> ${input.mention.rawContext}

## Response format

Respond with JSON (no markdown fences):
{
  "claims": [
    {
      "text": "Self-contained statement of what the citing paper claims the seed paper showed",
      "supportSpanText": "Verbatim span from the mention context",
      "confidence": "high"
    }
  ],
  "reason": "Brief extraction or exclusion reason"
}
Each claim must preserve its own source text, support span, and confidence. The supportSpanText must be copied verbatim from the sentence that carries the seed's marker. Confidence is required: "high" when the sentence plainly credits the seed with the claim, "medium" when the attribution is implied, "low" when the mention is a bare acknowledgment or the claim is uncertain. If no empirical claim is attributed to the seed, return an empty claims array.

Prompt template lineage: ${EXTRACTION_PROMPT_ID}@${EXTRACTION_PROMPT_VERSION}`;
}

export const claimExtractionOutputSchema = z
  .object({
    claims: z.array(
      z
        .object({
          text: z.string().trim().min(1),
          supportSpanText: z.string().min(1).optional(),
          confidence: z.enum(["high", "medium", "low"]).optional(),
        })
        .strict(),
    ),
    reason: z.string().min(1).optional(),
  })
  .strict();

export function buildClaimClusteringPrompt(input: {
  seedTitle: string;
  seedDoi?: string | undefined;
  claims: Array<{
    claimRecordId: string;
    extractedClaimText: string;
    citingPaperTitle: string;
    sectionTitle?: string | undefined;
  }>;
}): string {
  const claimLines = input.claims
    .map((claim, index) => {
      const where = claim.sectionTitle
        ? `${claim.citingPaperTitle} — ${claim.sectionTitle}`
        : claim.citingPaperTitle;
      return `#${String(index + 1)}: "${claim.extractedClaimText}"\n   (from: ${where})`;
    })
    .join("\n");

  return `You are clustering claims that citing papers attribute to one seed paper, for a metascience project that measures how claims drift as they are cited.

## Seed paper

Title: ${input.seedTitle}
DOI: ${input.seedDoi ?? "unknown"}

## Attributed claims

${claimLines}

## Task

Group the claims that attribute the SAME underlying finding of the seed paper. Claims belong together even when they differ in wording, strength, scope, certainty, population, or specificity; those differences are measured downstream and must not split a group. Split groups only when the claims concern different findings, variables, methods, or materials of the seed. A claim that shares no finding with any other stays in a group of one.

Every claim number above must appear in exactly one group; do not invent numbers.

For each group write one claim: a neutral, specific sentence naming the seed finding the group is about. Do not adopt any single citer's exaggeration or hedge; describe what the group has in common.

Respond with JSON (no markdown fences), referring to claims by their numbers:
{
  "clusters": [
    { "claim": "…", "claims": [1, 4, 7] }
  ]
}
Prompt template lineage: ${CLUSTERING_PROMPT_ID}@${CLUSTERING_PROMPT_VERSION}`;
}

export const claimClusteringOutputSchema = z
  .object({
    clusters: z.array(
      z
        .object({
          claim: z.string().trim().min(1),
          /** 1-based handles from the prompt; hashes are too error-prone for a model to echo. */
          claims: z.array(z.number().int().positive()).min(1),
        })
        .strict(),
    ),
  })
  .strict();
