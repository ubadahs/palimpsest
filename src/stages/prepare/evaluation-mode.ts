import type {
  CitationRole,
  EvaluationMode,
  TransmissionModifiers,
} from "../../domain/classification.js";

const ROLE_TO_MODE: Record<CitationRole, EvaluationMode> = {
  substantive_attribution: "fidelity_specific_claim",
  background_context: "fidelity_background_framing",
  methods_materials: "fidelity_methods_use",
  acknowledgment_or_low_information: "skip_low_information",
  unclear: "manual_review_role_ambiguous",
};

const BUNDLED_ELIGIBLE_ROLES = new Set<CitationRole>([
  "substantive_attribution",
  "background_context",
]);

/**
 * The evaluation mode a resolved role implies. An unclear role is always
 * `manual_review_role_ambiguous`, whatever the extractor's confidence: a
 * low-confidence claim is a weak attribution on a verified span, which the
 * role model can still label. Only a claim with no verified span is
 * `manual_review_extraction_limited`, and Prepare sets that before any role.
 */
export function deriveEvaluationMode(
  role: CitationRole,
  modifiers: TransmissionModifiers,
): EvaluationMode {
  if (role === "unclear") return "manual_review_role_ambiguous";

  if (modifiers.isReviewMediated) return "review_transmission";

  if (modifiers.isBundled && BUNDLED_ELIGIBLE_ROLES.has(role)) {
    return "fidelity_bundled_use";
  }

  return ROLE_TO_MODE[role];
}
