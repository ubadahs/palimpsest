/** Discover's prompts: claim extraction per mention, and claim clustering per seed. */

import { z } from "zod";
import { highlightCitationMarker } from "../../shared/claim-support-span.js";
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
    ? `\nReference as printed: ${input.mention.seedRefLabel}`
    : "";
  const bundleNote = input.mention.isBundledCitation
    ? `\nThis group contains ${String(input.mention.bundleSize)} references. Preserve shared credit and any uncertainty about which paper supplied the finding.`
    : "";
  const position = input.mention.markerSpan;
  const markedContext =
    position &&
    input.mention.rawContext.slice(
      position.charOffsetStart,
      position.charOffsetEnd,
    ) === input.mention.citationMarker
      ? input.mention.rawContext.slice(0, position.charOffsetStart) +
        highlightCitationMarker(input.mention.citationMarker) +
        input.mention.rawContext.slice(position.charOffsetEnd)
      : input.mention.rawContext;
  return `You are a scientific attribution extraction agent for a metascience project that audits citation fidelity.

## Task

What does the citing paper use the cited paper for at this particular citation? Extract each substantive, locally credited finding, argument, derivation, or use of a method or result. Preserve who did what. For an application or extension, distinguish the cited contribution from the citing authors' new work. Use the surrounding text to resolve references such as “this approach”. A bare citation, topical similarity, or a claim attached only to a different reference supplies no attributed statement.

## Cited paper

Title: ${input.seedTitle}
DOI: ${input.seedDoi ?? "unknown"}

## Citing paper

Title: ${input.citingTitle}

## Mention

Section: ${input.mention.sectionTitle ?? "unknown"}
Citation marker: ${input.mention.citationMarker}${seedLabel}${bundleNote}
Context (the target occurrence is marked with ▶ and ◀ when its position is known):
> ${markedContext}

## Response format

Respond with JSON (no markdown fences):
{
  "claims": [
    {
      "text": "Self-contained account of the specific claim or contribution credited here",
      "supportSpanText": "Verbatim span from the mention context",
      "confidence": "high"
    }
  ],
  "reason": "Brief extraction or exclusion reason"
}
For each statement, copy the smallest contiguous clause that states the use and identifies its citation into supportSpanText. Omit the added ▶ and ◀ symbols. Preserve the actual citation group when it belongs to that clause. End the span before an adjacent, separately cited clause, even in the same sentence. A larger paragraph may clarify a pronoun without being part of the support span. Use high, medium, or low confidence according to how explicitly the passage gives credit. Return an empty claims array when no substantive use is attributable here.

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
