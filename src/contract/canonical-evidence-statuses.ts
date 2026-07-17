import { z } from "zod";

/**
 * Cycle-free canonical Evidence record status vocabulary. Evidence and Report
 * both consume these exact schemas; neither stage duplicates the enum values.
 */
export const evidenceRetrievalStatusSchema = z.enum([
  "retrieved",
  "no_lexical_matches",
  "seed_text_unavailable",
  "seed_acquisition_failed",
  "retrieval_failed",
]);
export type EvidenceRetrievalStatus = z.infer<
  typeof evidenceRetrievalStatusSchema
>;

export const evidenceRerankStatusSchema = z.enum([
  "disabled",
  "not_attempted_no_candidates",
  "not_attempted_unavailable",
  "not_attempted_retrieval_failure",
  "completed",
  "failed",
]);
export type EvidenceRerankStatus = z.infer<typeof evidenceRerankStatusSchema>;
