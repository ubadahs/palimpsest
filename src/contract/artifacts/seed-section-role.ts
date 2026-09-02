import { z } from "zod";

/**
 * Coarse role of a seed-text block, carried from Scope through Evidence so
 * retrieval and adjudication can tell the seed's own results from its
 * background prose.
 */
export const seedSectionRoleSchema = z.enum([
  "abstract",
  "introduction",
  "methods",
  "results",
  "discussion",
  "figure",
  "table",
  "other",
]);
export type SeedSectionRole = z.infer<typeof seedSectionRoleSchema>;
