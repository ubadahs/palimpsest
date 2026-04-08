import { z } from "zod";

import {
  fullTextAcquisitionSchema,
  resolvedPaperSchema,
  undefinedable,
} from "./common.js";
import { claimGroundingStatusSchema } from "./pre-screen.js";

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

// ---------------------------------------------------------------------------
// Attribution-first discovery types (Phase 1 — redesign scaffolding)
// ---------------------------------------------------------------------------

// Outcome of attempting to harvest seed-paper mentions from one citing paper.
export const mentionHarvestOutcomeValues = [
  "success",
  "no_fulltext",
  "http_403",
  "parse_failed",
  "ref_list_empty",
  "no_reference_match",
  "ref_found_but_no_in_text_xref",
  "unknown_failure",
] as const;

export const mentionHarvestOutcomeSchema = z.enum(mentionHarvestOutcomeValues);
export type MentionHarvestOutcome = z.infer<typeof mentionHarvestOutcomeSchema>;

// A single normalized in-text mention of the seed paper inside a citing paper.
export const harvestedSeedMentionSchema = z
  .object({
    mentionId: z.string().min(1),
    citingPaperId: z.string().min(1),
    citedPaperId: z.string().min(1),
    citationMarker: z.string(),
    rawContext: z.string(),
    sectionTitle: undefinedable(z.string()),
    sourceType: z.enum(["jats_xml", "grobid_tei", "pdf_text"]),
    provenance: z
      .object({
        citingPaperTitle: z.string(),
        parserKind: undefinedable(z.string()),
        acquisitionMethod: undefinedable(z.string()),
      })
      .passthrough(),
    harvestOutcome: mentionHarvestOutcomeSchema,
  })
  .passthrough();
export type HarvestedSeedMention = z.infer<typeof harvestedSeedMentionSchema>;

// Per-paper harvest summary (one entry per probe paper in a discovery run).
export const paperHarvestSummarySchema = z
  .object({
    citingPaperId: z.string().min(1),
    citingPaperTitle: z.string(),
    harvestOutcome: mentionHarvestOutcomeSchema,
    mentionCount: z.number().int().nonnegative(),
    failureReason: undefinedable(z.string()),
  })
  .passthrough();
export type PaperHarvestSummary = z.infer<typeof paperHarvestSummarySchema>;

// Result of LLM-extracting an attributed claim from one harvested mention.
export const attributedClaimExtractionRecordSchema = z
  .object({
    recordId: z.string().min(1),
    mentionId: z.string().min(1),
    citingPaperId: z.string().min(1),
    /** True when the mention contains an in-scope empirical attribution to the seed paper. */
    inScopeEmpiricalAttribution: z.boolean(),
    attributedClaimText: undefinedable(z.string()),
    supportSpanText: undefinedable(z.string()),
    confidence: undefinedable(z.enum(["high", "medium", "low"])),
    /** Filled when inScopeEmpiricalAttribution is false. */
    reasonIfExcluded: undefinedable(z.string()),
    llmCallProvenance: z
      .object({
        model: z.string().min(1),
        promptTemplateId: z.string().min(1),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        estimatedCostUsd: z.number().nonnegative(),
        generatedAt: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();
export type AttributedClaimExtractionRecord = z.infer<
  typeof attributedClaimExtractionRecordSchema
>;

// Observable viability metrics over a family candidate's probe set.
export const familyProbeMetricsSchema = z
  .object({
    probePaperCount: z.number().int().nonnegative(),
    successfulHarvestCount: z.number().int().nonnegative(),
    harvestSuccessRate: z.number().min(0).max(1),
    totalMentionCount: z.number().int().nonnegative(),
    uniqueCitingPaperCount: z.number().int().nonnegative(),
    auditableEdgeCount: z.number().int().nonnegative(),
    hasPrimaryPapers: z.boolean(),
    hasReviewPapers: z.boolean(),
  })
  .passthrough();
export type FamilyProbeMetrics = z.infer<typeof familyProbeMetricsSchema>;

// Seed-grounding result for a candidate family (lightweight version without
// full LLM provenance, which lives in the discovery-grounding-trace sidecar).
export const familyCandidateSeedGroundingSchema = z
  .object({
    status: claimGroundingStatusSchema,
    supportSpanText: undefinedable(z.string()),
    groundingDetail: undefinedable(z.string()),
  })
  .passthrough();
export type FamilyCandidateSeedGrounding = z.infer<
  typeof familyCandidateSeedGroundingSchema
>;

// A cluster of attributed claims that represent the same seed-paper contribution.
export const attributedClaimFamilyCandidateSchema = z
  .object({
    familyId: z.string().min(1),
    doi: z.string().min(1),
    canonicalTrackedClaim: z.string().min(1),
    memberRecordIds: z.array(z.string()),
    memberMentionIds: z.array(z.string()),
    memberCitingPaperIds: z.array(z.string()),
    seedGrounding: familyCandidateSeedGroundingSchema,
    probeMetrics: familyProbeMetricsSchema,
    shortlistEligible: z.boolean(),
    shortlistReason: z.string().min(1),
  })
  .passthrough();
export type AttributedClaimFamilyCandidate = z.infer<
  typeof attributedClaimFamilyCandidateSchema
>;

// Probe-set selection: which citing papers were inspected and why.
export const probeSelectionReasonValues = [
  "selected_full_text_available",
  "selected_all_auditable",
  "excluded_probe_budget",
  "excluded_no_full_text",
] as const;

export const probeSelectionReasonSchema = z.enum(probeSelectionReasonValues);
export type ProbeSelectionReason = z.infer<typeof probeSelectionReasonSchema>;

export const probePaperEntrySchema = z
  .object({
    citingPaperId: z.string().min(1),
    citingPaperTitle: z.string(),
    selected: z.boolean(),
    reason: probeSelectionReasonSchema,
  })
  .passthrough();
export type ProbePaperEntry = z.infer<typeof probePaperEntrySchema>;

export const discoveryProbeSelectionSchema = z
  .object({
    seedPaperId: z.string().min(1),
    doi: z.string().min(1),
    strategy: z.enum(["all_auditable", "capped"]),
    probeBudget: undefinedable(z.number().int().positive()),
    papers: z.array(probePaperEntrySchema),
    selectedCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    generatedAt: z.string().min(1),
  })
  .passthrough();
export type DiscoveryProbeSelection = z.infer<
  typeof discoveryProbeSelectionSchema
>;

// Full citing neighborhood snapshot (persisted before probe filtering).
export const seedNeighborhoodSnapshotSchema = z
  .object({
    seedPaperId: z.string().min(1),
    doi: z.string().min(1),
    totalCitingPapers: z.number().int().nonnegative(),
    fullTextAvailableCount: z.number().int().nonnegative(),
    abstractOnlyCount: z.number().int().nonnegative(),
    unavailableCount: z.number().int().nonnegative(),
    generatedAt: z.string().min(1),
  })
  .passthrough();
export type SeedNeighborhoodSnapshot = z.infer<
  typeof seedNeighborhoodSnapshotSchema
>;
