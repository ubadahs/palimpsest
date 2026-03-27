import type {
  CitationRole,
  Confidence,
  EvaluationMode,
  TransmissionModifiers,
} from "../domain/types.js";

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

export function deriveEvaluationMode(
  role: CitationRole,
  modifiers: TransmissionModifiers,
  extractionConfidence?: Confidence,
): EvaluationMode {
  if (modifiers.isReviewMediated) return "review_transmission";

  if (modifiers.isBundled && BUNDLED_ELIGIBLE_ROLES.has(role)) {
    return "fidelity_bundled_use";
  }

  if (role === "unclear") {
    return extractionConfidence === "low"
      ? "manual_review_extraction_limited"
      : "manual_review_role_ambiguous";
  }

  return ROLE_TO_MODE[role];
}
