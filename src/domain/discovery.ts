import { z } from "zod";

import {
  fullTextAcquisitionSchema,
  resolvedPaperSchema,
  undefinedable,
} from "./common.js";

// ---------------------------------------------------------------------------
// Claim type: what kind of assertion the paper is making.
// ---------------------------------------------------------------------------

export const discoveredClaimTypeValues = [
  "finding",
  "interpretation",
  "methodological",
] as const;

export const discoveredClaimTypeSchema = z.enum(discoveredClaimTypeValues);
export type DiscoveredClaimType = z.infer<typeof discoveredClaimTypeSchema>;

// ---------------------------------------------------------------------------
// A single claim unit extracted from a paper.
// ---------------------------------------------------------------------------

export const discoveredClaimSchema = z
  .object({
    /** Self-contained, normalized assertion. */
    claimText: z.string().min(1),
    /** Verbatim sentence(s) from the manuscript that the claim was extracted from. */
    sourceSpans: z.array(z.string().min(1)).min(1),
    /** Section where the claim appears (e.g. "Results", "Discussion"). */
    section: z.string().min(1),
    /** Reference labels or identifiers cited alongside this claim (e.g. "[12]", "Smith et al., 2020"). */
    citedReferences: z.array(z.string()),
    claimType: discoveredClaimTypeSchema,
    confidence: z.enum(["high", "medium"]),
  })
  .passthrough();
export type DiscoveredClaim = z.infer<typeof discoveredClaimSchema>;

// ---------------------------------------------------------------------------
// LLM response schema — what the model returns.
// ---------------------------------------------------------------------------

export const claimDiscoveryLlmResponseSchema = z
  .object({
    claims: z.array(discoveredClaimSchema),
  })
  .passthrough();
export type ClaimDiscoveryLlmResponse = z.infer<
  typeof claimDiscoveryLlmResponseSchema
>;

// ---------------------------------------------------------------------------
// Claim engagement: how citing papers engage with each discovered claim.
// ---------------------------------------------------------------------------

export const claimEngagementLevelValues = [
  "direct",
  "indirect",
  "none",
] as const;

export const claimEngagementLevelSchema = z.enum(claimEngagementLevelValues);
export type ClaimEngagementLevel = z.infer<typeof claimEngagementLevelSchema>;

export const claimEngagementSchema = z
  .object({
    claimIndex: z.number().int().nonnegative(),
    claimText: z.string().min(1),
    claimType: discoveredClaimTypeSchema,
    directCount: z.number().int().nonnegative(),
    indirectCount: z.number().int().nonnegative(),
    directPapers: z.array(z.string()),
  })
  .passthrough();
export type ClaimEngagement = z.infer<typeof claimEngagementSchema>;

export const claimRankingResultSchema = z
  .object({
    citingPapersAnalyzed: z.number().int().nonnegative(),
    citingPapersTotal: z.number().int().nonnegative(),
    rankingModel: z.string().min(1),
    rankingEstimatedCostUsd: z.number().nonnegative(),
    engagements: z.array(claimEngagementSchema),
  })
  .passthrough();
export type ClaimRankingResult = z.infer<typeof claimRankingResultSchema>;

// ---------------------------------------------------------------------------
// Full discovery result for one paper.
// ---------------------------------------------------------------------------

export const discoveryStatusValues = [
  "completed",
  "no_fulltext",
  "parse_failed",
  "llm_failed",
] as const;

export const discoveryStatusSchema = z.enum(discoveryStatusValues);
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;

export const claimDiscoveryResultSchema = z
  .object({
    doi: z.string().min(1),
    resolvedPaper: undefinedable(resolvedPaperSchema),
    status: discoveryStatusSchema,
    statusDetail: z.string().min(1),
    claims: z.array(discoveredClaimSchema),
    /** Only findings — the subset suitable as seeds for downstream screening. */
    findingCount: z.number().int().nonnegative(),
    totalClaimCount: z.number().int().nonnegative(),
    llmModel: undefinedable(z.string()),
    llmInputTokens: undefinedable(z.number().int().nonnegative()),
    llmOutputTokens: undefinedable(z.number().int().nonnegative()),
    llmEstimatedCostUsd: undefinedable(z.number().nonnegative()),
    ranking: undefinedable(claimRankingResultSchema),
    fullTextAcquisition: undefinedable(fullTextAcquisitionSchema),
    generatedAt: z.string().min(1),
  })
  .passthrough();
export type ClaimDiscoveryResult = z.infer<typeof claimDiscoveryResultSchema>;

// ---------------------------------------------------------------------------
// Input schema: just a DOI (or list).
// ---------------------------------------------------------------------------

export const discoveryInputSchema = z
  .object({
    dois: z.array(z.string().min(1)).min(1),
  })
  .passthrough();
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
