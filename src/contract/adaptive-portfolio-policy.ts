import { z } from "zod";

/**
 * Client-safe adaptive portfolio policy schema.
 * Keep Node-bound selection/annotation helpers out of this module so
 * `palimpsest/contract` (UI) can import run config without `node:crypto`.
 */
export const CANDIDATE_SELECTION_POLICY_VERSION =
  "adaptive-portfolio-v3" as const;

export const adaptivePortfolioPolicySchema = z
  .object({
    mode: z.literal("adaptive_portfolio"),
    minFamilies: z.number().int().positive().default(15),
    maxFamilies: z.number().int().positive().default(25),
    maxPreparedRecords: z.number().int().positive().default(100),
    // Lower prevalence / higher novelty so recurring vague paraphrases
    // cannot crowd out specific but less-repeated claims.
    prevalenceWeight: z.number().finite().nonnegative().default(0.25),
    specificityWeight: z.number().finite().nonnegative().default(0.35),
    confidenceWeight: z.number().finite().nonnegative().default(0.15),
    noveltyWeight: z.number().finite().nonnegative().default(0.25),
    minMarginalNovelty: z.number().finite().min(0).max(1).default(0.08),
    policyVersion: z
      .literal(CANDIDATE_SELECTION_POLICY_VERSION)
      .default(CANDIDATE_SELECTION_POLICY_VERSION),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.minFamilies > policy.maxFamilies) {
      context.addIssue({
        code: "custom",
        path: ["minFamilies"],
        message: "minFamilies cannot exceed maxFamilies",
      });
    }
  });

export type AdaptivePortfolioPolicy = z.infer<
  typeof adaptivePortfolioPolicySchema
>;

export const defaultAdaptivePortfolioPolicy: AdaptivePortfolioPolicy =
  adaptivePortfolioPolicySchema.parse({ mode: "adaptive_portfolio" });

const ALL_CANDIDATES_POLICY_VERSION = "all-candidates-v1" as const;

/**
 * Keep every candidate: no family cap, record budget, or novelty floor. Each
 * candidate still gets its annotation and a disposition in the same decision
 * ledger, so a census run accounts for selection exactly as a portfolio does.
 */
const allCandidatesPolicySchema = z
  .object({
    mode: z.literal("all"),
    policyVersion: z
      .literal(ALL_CANDIDATES_POLICY_VERSION)
      .default(ALL_CANDIDATES_POLICY_VERSION),
  })
  .strict();

export type AllCandidatesPolicy = z.infer<typeof allCandidatesPolicySchema>;

/** How Discover chooses which candidates become Scope families. */
export const candidateSelectionPolicySchema = z.discriminatedUnion("mode", [
  adaptivePortfolioPolicySchema,
  allCandidatesPolicySchema,
]);
export type CandidateSelectionPolicy = z.infer<
  typeof candidateSelectionPolicySchema
>;
export const candidateSelectionModeValues = [
  "adaptive_portfolio",
  "all",
] as const;
export type CandidateSelectionMode = CandidateSelectionPolicy["mode"];

export const defaultAllCandidatesPolicy: AllCandidatesPolicy =
  allCandidatesPolicySchema.parse({ mode: "all" });
