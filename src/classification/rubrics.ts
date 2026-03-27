import type { EvaluationMode, RubricQuestion } from "../domain/types.js";

const RUBRICS: Record<EvaluationMode, RubricQuestion> = {
  fidelity_specific_claim: {
    mode: "fidelity_specific_claim",
    question: [
      "Does the cited paper contain evidence that directly supports the specific finding or conclusion attributed to it by the citing context?",
      "",
      "Guidance:",
      "- Evaluate the *attributed content*, not only the surrounding conclusion. If the paper is cited as a data source, evaluate whether it provides that data, even if the citing paper draws its own conclusions from it.",
      "- Distinguish the general finding (e.g., 'structures exist') from specific characterizations (e.g., 'T-shaped geometry'). If the cited paper supports the general finding but the specific characterization appears to be novel to the citing paper, that is partially_supported.",
      "- If the citing context is truncated or incomplete, default to cannot_determine.",
    ].join("\n"),
    verdictOptions: [
      "supported",
      "partially_supported",
      "overstated_or_generalized",
      "not_supported",
      "cannot_determine",
    ],
  },
  fidelity_background_framing: {
    mode: "fidelity_background_framing",
    question: [
      "Is the cited paper being characterized accurately in terms of its topic, scope, or established contribution? Does the framing introduce distortion?",
      "",
      "Guidance:",
      "- Background framing often compresses multiple findings into a cleaner narrative. If the substance is accurate but the framing is tighter or more definitive than the source, that is partially_supported.",
      "- If the cited paper's scope is broadened or narrowed significantly by the framing, note this as scope compression.",
      "- An accurate but imprecise description of a specific paper's contribution (e.g., 'studied basic mechanisms' for a paper about a specific mechanism) is partially_supported, not supported.",
    ].join("\n"),
    verdictOptions: [
      "supported",
      "partially_supported",
      "overstated_or_generalized",
      "not_supported",
      "cannot_determine",
    ],
  },
  fidelity_bundled_use: {
    mode: "fidelity_bundled_use",
    question: [
      "Does this paper belong in this citation bundle? Evaluate on two dimensions:",
      "",
      "(a) Topical relevance: Does the paper address the general topic of the bundle?",
      "(b) Propositional support: Does the paper actually support the specific bundled proposition?",
      "",
      "Guidance:",
      "- A paper can be topically relevant (addresses hepatocyte polarity) without supporting the specific bundled claim (integrin-dependent adhesion reorganization). That is partially_supported.",
      "- 'supported' requires both topical relevance AND propositional support.",
      "- A paper that is only tangentially related to the bundle topic is not_supported / tangential.",
      "- If the bundled proposition is cut off or unclear, default to cannot_determine.",
    ].join("\n"),
    verdictOptions: [
      "supported",
      "partially_supported",
      "not_supported",
      "cannot_determine",
    ],
  },
  fidelity_methods_use: {
    mode: "fidelity_methods_use",
    question: [
      "Is the cited paper actually the source of the method, protocol, or material described? Is the attribution to this paper correct?",
      "",
      "Guidance:",
      "- Distinguish three levels: (a) the paper is the original source of the method, (b) the paper uses/adapts a method from an earlier source, (c) the paper is not the proper source of attribution.",
      "- If the cited paper uses a method from Tanimizu et al. 2003 with modifications, and the citing paper attributes the full method to the cited paper, that is partially_supported (indirect source).",
      "- 'supported' means the cited paper either originated the method or is the standard reference for this version of it.",
    ].join("\n"),
    verdictOptions: [
      "supported",
      "partially_supported",
      "not_supported",
      "cannot_determine",
    ],
  },
  review_transmission: {
    mode: "review_transmission",
    question: [
      "Does the review paper accurately transmit the finding or contribution of the cited paper, or does it introduce generalization, simplification, or distortion?",
      "",
      "Guidance:",
      "- Reviews typically simplify. If the core finding is accurately transmitted but packaged into a cleaner causal narrative, that is partially_supported.",
      "- If the review attributes a stronger or broader claim than the cited paper makes, that is overstated_or_generalized.",
      "- If the citing context is truncated and the specific claim attributed to this citation is not identifiable, default to cannot_determine.",
    ].join("\n"),
    verdictOptions: [
      "supported",
      "partially_supported",
      "overstated_or_generalized",
      "not_supported",
      "cannot_determine",
    ],
  },
  skip_low_information: {
    mode: "skip_low_information",
    question: "Low-information citation — no fidelity question applicable.",
    verdictOptions: ["skipped"],
  },
  manual_review_role_ambiguous: {
    mode: "manual_review_role_ambiguous",
    question: [
      "The citation role could not be determined heuristically. What is this citation doing, and does the cited paper support it?",
      "",
      "Guidance:",
      "- First determine the citation function (substantive attribution, background, methods, bundle member, acknowledgment).",
      "- Then apply the appropriate rubric for that function.",
      "- If the citing context is a bibliography block or reference list rather than an in-text citation, mark as cannot_determine with note 'non-adjudicable context'.",
    ].join("\n"),
    verdictOptions: [
      "supported",
      "partially_supported",
      "overstated_or_generalized",
      "not_supported",
      "cannot_determine",
    ],
  },
  manual_review_extraction_limited: {
    mode: "manual_review_extraction_limited",
    question:
      "Extraction quality was too low to classify. Manual inspection of the full text is needed.",
    verdictOptions: ["needs_manual_inspection"],
  },
};

export function getRubric(mode: EvaluationMode): RubricQuestion {
  return RUBRICS[mode];
}
