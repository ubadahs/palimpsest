/**
 * The scientific rubric: what each citation role and fidelity verdict means.
 * Production prompts and the evaluation questions put to other providers are
 * both rendered from these definitions, so a comparison measures one rubric.
 *
 * Changing any text here changes production prompts: bump the prompt versions
 * that render it (`roleClassification`, `adjudication`, `seedTextAdjudication`)
 * and the evaluation prompt revision.
 */
import type { CitationRole } from "./classification.js";
import type { FidelityVerdict } from "./taxonomy.js";

export const CITATION_ROLE_DEFINITIONS: Readonly<Record<CitationRole, string>> =
  {
    substantive_attribution:
      "the citing text credits a specific finding, result, or measurement to the cited work.",
    background_context:
      "the citing text uses the cited work to establish general knowledge, motivation, or framing.",
    methods_materials:
      "the citing text uses the cited work for a method, protocol, reagent, dataset, or tool.",
    acknowledgment_or_low_information:
      'the citation carries no attributed content (a bare "see also", a list of examples).',
    unclear: "the context genuinely does not say which of the above it is.",
  };

/** How to choose between roles when more than one seems to fit. */
export const CITATION_ROLE_GUIDANCE = `Classify the finding attributed to this reference, not the citing paper's neighboring results. A specific prior finding or measurement remains substantive_attribution when it motivates a marker choice, method, or comparison, including in an Introduction or Discussion. Choose methods_materials when the citation supplies a method, reagent, dataset, or tool without attributing a finding about it. Choose background_context for general framing without a specific attributed result. If substantive_attribution and another role both seem plausible, prefer substantive_attribution for an explicit empirical claim.

Pick "unclear" only when the context is too thin to decide; a heading that does not match a familiar pattern is not by itself a reason.`;

export const VERDICT_DEFINITIONS: Readonly<
  Record<FidelityVerdict, { name: string; definition: string }>
> = {
  F: {
    name: "faithful",
    definition:
      "the attribution preserves the cited source's substantive meaning; reasonable compression is allowed, including bundled citations when the seed supports a meaningful claim kernel",
  },
  D: {
    name: "distortion",
    definition:
      "a real source kernel exists, but scope, strength, certainty, causality, population, conditions, measurement endpoint, or generality is materially altered",
  },
  E: {
    name: "error",
    definition:
      "the central attribution is unsupported, contradicted, about the wrong entity/result, or otherwise lacks the claimed source kernel",
  },
  U: {
    name: "uncertain",
    definition:
      "exact cited evidence is present, but genuine scientific or attribution ambiguity prevents a defensible F/D/E judgment. Do not use U for missing evidence or tool failure.",
  },
};

/**
 * Where compression ends and distortion begins; shared by every adjudication
 * prompt. Spelling the boundary out in more rules has made models stricter
 * than human reviewers, not closer to them, so change this text only against
 * labelled cases.
 */
export const FIDELITY_BOUNDARY_GUIDANCE = `Quantifier compression that preserves the kernel (for example "four types" vs "only four types") remains F when the source supports that kernel. Proxy endpoints that change what was measured (for example prevalence/density vs staining intensity) are D when the source kernel differs.`;

/** The role rubric as a prompt section. */
export function citationRoleRubric(): string {
  const roles = Object.entries(CITATION_ROLE_DEFINITIONS)
    .map(([role, definition]) => `- ${role} — ${definition}`)
    .join("\n");
  return `Choose exactly one role:\n${roles}\n\n${CITATION_ROLE_GUIDANCE}`;
}

/** The verdict rubric as the `verdict` field of an adjudication reply. */
export function verdictRubric(): string {
  const verdicts = Object.entries(VERDICT_DEFINITIONS)
    .map(
      ([verdict, { name, definition }]) =>
        `  - ${verdict} (${name}): ${definition}`,
    )
    .join("\n");
  return `- verdict: one of F, D, E, U using these definitions only:\n${verdicts}`;
}

/** Definitions as standalone sentences: the criteria a question-style provider chooses between. */
export function rubricCriteria(
  definitions: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => {
      const text = definition.charAt(0).toUpperCase() + definition.slice(1);
      return [key, /[.!?]$/.test(text) ? text : `${text}.`];
    }),
  );
}

/** The verdict definitions without their names. */
export function verdictDefinitionsOnly(): Record<FidelityVerdict, string> {
  return {
    F: VERDICT_DEFINITIONS.F.definition,
    D: VERDICT_DEFINITIONS.D.definition,
    E: VERDICT_DEFINITIONS.E.definition,
    U: VERDICT_DEFINITIONS.U.definition,
  };
}
