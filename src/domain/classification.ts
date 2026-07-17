import { z } from "zod";

const confidenceValues = ["low", "medium", "high"] as const;

export const confidenceSchema = z.enum(confidenceValues);
export type Confidence = z.infer<typeof confidenceSchema>;

export type CitationRole =
  | "substantive_attribution"
  | "background_context"
  | "methods_materials"
  | "acknowledgment_or_low_information"
  | "unclear";

export type TransmissionModifiers = {
  isBundled: boolean;
  isReviewMediated: boolean;
  /** Number of references sharing this citation marker group (1 = single ref). */
  bundleSize?: number;
};

const evaluationModeValues = [
  "fidelity_specific_claim",
  "fidelity_background_framing",
  "fidelity_bundled_use",
  "fidelity_methods_use",
  "review_transmission",
  "skip_low_information",
  "manual_review_role_ambiguous",
  "manual_review_extraction_limited",
] as const;

export const evaluationModeSchema = z.enum(evaluationModeValues);
export type EvaluationMode = z.infer<typeof evaluationModeSchema>;

export type CachePolicy =
  | "prefer_cache"
  | "refresh_missing_only"
  | "force_refresh";
