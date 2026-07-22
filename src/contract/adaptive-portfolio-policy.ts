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
