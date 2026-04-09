import { z } from "zod";

import {
  edgeClassificationSchema,
  fullTextAcquisitionSchema,
  resolvedPaperSchema,
  undefinedable,
} from "./common.js";
import { auditabilityStatusSchema } from "./taxonomy.js";

export const familyUseProfileValues = [
  "primary_empirical_heavy",
  "mixed_primary_review",
  "review_mediated",
  "duplicate_heavy",
  "small_family",
  "low_access",
] as const;

export const familyUseProfileSchema = z.enum(familyUseProfileValues);
export type FamilyUseProfileTag = z.infer<typeof familyUseProfileSchema>;

export const m2PriorityValues = [
  "first",
  "later",
  "caution",
  "not_now",
] as const;

export const m2PrioritySchema = z.enum(m2PriorityValues);
export type M2Priority = z.infer<typeof m2PrioritySchema>;

export const preScreenDecisionValues = ["greenlight", "deprioritize"] as const;

export const preScreenDecisionSchema = z.enum(preScreenDecisionValues);
export type PreScreenDecision = z.infer<typeof preScreenDecisionSchema>;

export const seedPaperInputSchema = z
  .object({
    doi: z.string().min(1),
    trackedClaim: z.string().min(1),
    notes: z.string().optional(),
  })
  .passthrough();
export type SeedPaperInput = z.infer<typeof seedPaperInputSchema>;

export const preScreenEdgeSchema = z
  .object({
    citingPaperId: z.string().min(1),
    citedPaperId: z.string().min(1),
    auditabilityStatus: auditabilityStatusSchema,
    auditabilityReason: z.string().min(1),
    classification: edgeClassificationSchema,
    paperType: undefinedable(z.string()),
    referencedWorksCount: undefinedable(z.number().int()),
    /** BM25(title+abstract, claim query). Omitted on legacy artifacts. */
    claimRelevanceScore: undefinedable(z.number()),
    /** When false, this edge is outside the claim-scoped family. Omitted on legacy artifacts (treated as true). */
    inClaimFamily: undefinedable(z.boolean()),
  })
  .passthrough();
export type PreScreenEdge = z.infer<typeof preScreenEdgeSchema>;

/** Grounding the analyst's `trackedClaim` in the seed paper's full text. */
export const claimGroundingStatusValues = [
  "not_attempted",
  "grounded",
  "ambiguous",
  "not_found",
  "no_seed_fulltext",
  "materialize_failed",
] as const;

export const claimGroundingStatusSchema = z.enum(claimGroundingStatusValues);
export type ClaimGroundingStatus = z.infer<typeof claimGroundingStatusSchema>;

/**
 * Extended shortlist entry emitted by the redesigned attribution-first discover
 * stage. All fields beyond `doi` and `trackedClaim` are optional so that legacy
 * shortlist files (which only contain those two plus an optional `notes`) remain
 * valid without any migration.
 *
 * `ShortlistInput` uses this schema so that both old and new shortlist files
 * load through the same parser.
 */
export const discoveryShortlistEntrySchema = z
  .object({
    doi: z.string().min(1),
    trackedClaim: z.string().min(1),
    notes: z.string().optional(),
    /** Set when the entry was produced by the attribution-first discover path. */
    familyId: z.string().optional(),
    /** How this entry was produced. */
    discoveryMethod: z
      .enum(["attribution_first", "legacy_rank", "manual"])
      .optional(),
    supportingMentionCount: z.number().int().nonnegative().optional(),
    supportingPaperCount: z.number().int().nonnegative().optional(),
    /** Seed-grounding status at discovery time (may be refined by screen). */
    seedGroundingStatus: claimGroundingStatusSchema.optional(),
    /** Path to the discovery sidecar containing the full family candidate. */
    sourceDiscoveryArtifact: z.string().optional(),
  })
  .passthrough();
export type DiscoveryShortlistEntry = z.infer<
  typeof discoveryShortlistEntrySchema
>;

/**
 * The shortlist file fed from `discover` to `screen`. Both legacy entries
 * (doi + trackedClaim + optional notes) and redesigned entries (which add
 * familyId and other optional fields) parse correctly through this schema.
 */
export const shortlistInputSchema = z
  .object({
    seeds: z.array(discoveryShortlistEntrySchema).min(1),
  })
  .passthrough();
export type ShortlistInput = z.infer<typeof shortlistInputSchema>;

export const seedClaimSupportSpanSchema = z
  .object({
    text: z.string().min(1),
    sectionTitle: undefinedable(z.string()),
    blockKind: undefinedable(
      z.enum(["abstract", "body_paragraph", "figure_caption", "table_caption"]),
    ),
    /** Lexical rank score when present (e.g. legacy artifacts); omitted for LLM-quoted passages. */
    bm25Score: z.number().optional(),
  })
  .passthrough();
export type SeedClaimSupportSpan = z.infer<typeof seedClaimSupportSpanSchema>;

export const claimGroundingSchema = z
  .object({
    status: claimGroundingStatusSchema,
    /** Original analyst text from the shortlist. */
    analystClaim: z.string().min(1),
    /** Canonical wording used for claim-family retrieval (from LLM grounding). */
    normalizedClaim: z.string().min(1),
    supportSpans: z.array(seedClaimSupportSpanSchema),
    /** When true, M2+ must not run for this family until the claim is revised or grounding is fixed. Ignored for status `ambiguous` (see {@link claimFamilyBlocksDownstream}). */
    blocksDownstream: z.boolean(),
    detailReason: z.string().min(1),
  })
  .passthrough();
export type ClaimGrounding = z.infer<typeof claimGroundingSchema>;

export const preScreenMetricsSchema = z
  .object({
    totalEdges: z.number().int().nonnegative(),
    uniqueEdges: z.number().int().nonnegative(),
    collapsedDuplicates: z.number().int().nonnegative(),
    auditableStructuredEdges: z.number().int().nonnegative(),
    auditablePdfEdges: z.number().int().nonnegative(),
    partiallyAuditableEdges: z.number().int().nonnegative(),
    notAuditableEdges: z.number().int().nonnegative(),
    auditableCoverage: z.number().min(0),
    primaryLikeEdgeCount: z.number().int().nonnegative(),
    primaryLikeEdgeRate: z.number().min(0),
    reviewEdgeCount: z.number().int().nonnegative(),
    reviewEdgeRate: z.number().min(0),
    commentaryEdgeCount: z.number().int().nonnegative(),
    commentaryEdgeRate: z.number().min(0),
    letterEdgeCount: z.number().int().nonnegative(),
    letterEdgeRate: z.number().min(0),
    bookChapterEdgeCount: z.number().int().nonnegative(),
    bookChapterEdgeRate: z.number().min(0),
    articleEdgeCount: z.number().int().nonnegative(),
    articleEdgeRate: z.number().min(0),
    preprintEdgeCount: z.number().int().nonnegative(),
    preprintEdgeRate: z.number().min(0),
  })
  .passthrough();
export type PreScreenMetrics = z.infer<typeof preScreenMetricsSchema>;

export const duplicateGroupSchema = z
  .object({
    duplicateGroupId: z.string().min(1),
    keptRepresentativePaperId: z.string().min(1),
    collapsedFromPaperIds: z.array(z.string()),
    collapseReason: z.string().min(1),
  })
  .passthrough();
export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>;

export const claimFamilyPreScreenSchema = z
  .object({
    seed: seedPaperInputSchema,
    resolvedSeedPaper: undefinedable(resolvedPaperSchema),
    edges: z.array(preScreenEdgeSchema),
    resolvedPapers: z.record(z.string(), resolvedPaperSchema),
    duplicateGroups: z.array(duplicateGroupSchema),
    /** Metrics over citing papers that pass claim-relevance filtering. Drives greenlight. */
    metrics: preScreenMetricsSchema,
    /** Full seed neighborhood before claim filtering (auditability composition). */
    neighborhoodMetrics: undefinedable(preScreenMetricsSchema),
    seedFullTextAcquisition: undefinedable(fullTextAcquisitionSchema),
    claimGrounding: undefinedable(claimGroundingSchema),
    familyUseProfile: z.array(familyUseProfileSchema),
    m2Priority: m2PrioritySchema,
    decision: preScreenDecisionSchema,
    decisionReason: z.string().min(1),
  })
  .passthrough();
export type ClaimFamilyPreScreen = z.infer<typeof claimFamilyPreScreenSchema>;

export const preScreenResultsSchema = z.array(claimFamilyPreScreenSchema);

/**
 * Whether this grounding outcome should block M2+ and claim-scoped pre-screen metrics.
 * `ambiguous` never blocks: several strong matches still mean the claim is present in the seed text.
 */
export function claimGroundingBlocksAnalysis(g: ClaimGrounding): boolean {
  if (g.status === "ambiguous") {
    return false;
  }
  return g.blocksDownstream;
}

/** True when pre-screen requires revising the claim or grounding before M2+. */
export function claimFamilyBlocksDownstream(
  family: ClaimFamilyPreScreen,
): boolean {
  const g = family.claimGrounding;
  if (!g) {
    return false;
  }
  return claimGroundingBlocksAnalysis(g);
}
