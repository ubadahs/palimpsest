/** Prepare's citation-role prompt, for occurrences the regex pass leaves unclear. */

import { z } from "zod";
import { PROMPT_VERSIONS } from "../../config/prompt-versions.js";
import { annotateCitingContext } from "../../shared/citation-context-window.js";
import { citationRoleRubric } from "../../domain/rubric.js";
import { type PrepareClassifierInput } from "./run.js";

export const ROLE_CLASSIFICATION_PROMPT_ID =
  "citation-role-classification" as const;

export const ROLE_CLASSIFICATION_PROMPT_VERSION =
  PROMPT_VERSIONS.roleClassification;

/**
 * Asks for one citation role from the same five-value taxonomy the regex pass
 * uses. Shows the verified support span (what the extractor bound to the seed),
 * the marked sentences, and the section heading — nothing about the seed's own
 * content, because the question is what this citer is doing with the seed, not
 * whether it is right.
 */

export function buildCitationRolePrompt(input: PrepareClassifierInput): string {
  const occurrence = input.citationOccurrence;
  const section = occurrence.sectionTitle
    ? `Section heading: ${occurrence.sectionTitle}`
    : "Section heading: (not recorded)";
  const refLabel = occurrence.seedRefLabel
    ? `\nSeed reference as it appears in this paper: ${occurrence.seedRefLabel}`
    : "";
  const bundle = occurrence.isBundledCitation
    ? `\nThis marker is shared with ${String(occurrence.bundleSize)} references.`
    : "";
  const spans = input.occurrenceSourceClaimRecords
    .map((claim, index) => {
      const span = claim.supportSpan?.text ?? claim.extractedClaimText;
      return `${String(index + 1)}. ${span}`;
    })
    .join("\n");

  return `You are classifying what a citing paper is doing with one cited reference.

${section}${refLabel}${bundle}

Citing context (sentences attributed to the cited reference are wrapped in ▶ ... ◀):
${annotateCitingContext(
  occurrence,
  input.occurrenceSourceClaimRecords.flatMap((claim) =>
    claim.supportSpan ? [claim.supportSpan] : [],
  ),
)}

Text the extractor bound to the cited reference:
${spans}

${citationRoleRubric()}

Respond with JSON (no markdown fences):
{ "citationRole": "...", "rationale": "one sentence" }`;
}

export const citationRoleResponseSchema = z
  .object({
    citationRole: z.enum([
      "substantive_attribution",
      "background_context",
      "methods_materials",
      "acknowledgment_or_low_information",
      "unclear",
    ]),
    rationale: z.string().min(1),
  })
  .strict();
