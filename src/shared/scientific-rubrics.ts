/** Shared scientific instructions. Changes require a prompt/cache version bump. */
export const CITATION_ROLE_DEFINITIONS = `Choose exactly one role:
- substantive_attribution — the citing text credits a specific finding, result, or measurement to the cited work.
- background_context — the citing text uses the cited work to establish general knowledge, motivation, or framing.
- methods_materials — the citing text uses the cited work for a method, protocol, reagent, dataset, or tool.
- acknowledgment_or_low_information — the citation carries no attributed content (a bare "see also", a list of examples).
- unclear — the context genuinely does not say which of the above it is.

Classify the finding attributed to this reference, not the citing paper's neighboring results. A specific prior finding or measurement remains substantive_attribution when it motivates a marker choice, method, or comparison, including in an Introduction or Discussion. Choose methods_materials when the citation supplies a method, reagent, dataset, or tool without attributing a finding about it. Choose background_context for general framing without a specific attributed result. If substantive_attribution and another role both seem plausible, prefer substantive_attribution for an explicit empirical claim.

Pick "unclear" only when the context is too thin to decide; a heading that does not match a familiar pattern is not by itself a reason.`;

/**
 * Where compression ends and distortion begins; shared by every adjudication
 * prompt. Spelling the boundary out in more rules has made models stricter
 * than human reviewers, not closer to them, so change this text only against
 * labelled cases.
 */
export const FIDELITY_BOUNDARY_GUIDANCE = `Quantifier compression that preserves the kernel (for example "four types" vs "only four types") remains F when the source supports that kernel. Proxy endpoints that change what was measured (for example prevalence/density vs staining intensity) are D when the source kernel differs.`;

export function adjudicationVerdictDefinitions(): string {
  return `- verdict: one of F, D, E, U using these definitions only:
  - F (faithful): the attribution preserves the cited source's substantive meaning; reasonable compression is allowed, including bundled citations when the seed supports a meaningful claim kernel
  - D (distortion): a real source kernel exists, but scope, strength, certainty, causality, population, conditions, measurement endpoint, or generality is materially altered
  - E (error): the central attribution is unsupported, contradicted, about the wrong entity/result, or otherwise lacks the claimed source kernel
  - U (uncertain): exact cited evidence is present, but genuine scientific or attribution ambiguity prevents a defensible F/D/E judgment. Do not use U for missing evidence or tool failure.`;
}
