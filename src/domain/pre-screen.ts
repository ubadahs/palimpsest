import { z } from "zod";

import {
  edgeClassificationSchema,
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

export const shortlistInputSchema = z
  .object({
    seeds: z.array(seedPaperInputSchema).min(1),
  })
  .passthrough();
export type ShortlistInput = z.infer<typeof shortlistInputSchema>;

export const preScreenEdgeSchema = z
  .object({
    citingPaperId: z.string().min(1),
    citedPaperId: z.string().min(1),
    auditabilityStatus: auditabilityStatusSchema,
    auditabilityReason: z.string().min(1),
    classification: edgeClassificationSchema,
    paperType: undefinedable(z.string()),
    referencedWorksCount: undefinedable(z.number().int()),
  })
  .passthrough();
export type PreScreenEdge = z.infer<typeof preScreenEdgeSchema>;

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
    metrics: preScreenMetricsSchema,
    familyUseProfile: z.array(familyUseProfileSchema),
    m2Priority: m2PrioritySchema,
    decision: preScreenDecisionSchema,
    decisionReason: z.string().min(1),
  })
  .passthrough();
export type ClaimFamilyPreScreen = z.infer<typeof claimFamilyPreScreenSchema>;

export const preScreenResultsSchema = z.array(claimFamilyPreScreenSchema);
