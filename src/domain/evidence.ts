import { z } from "zod";

import { resolvedPaperSchema, undefinedable } from "./common.js";
import { fullTextFormatSchema, parsedBlockKindSchema } from "./parsing.js";
import {
  evaluationModeSchema,
  evaluationTaskSchema,
  extractionStateSchema,
  familyClassificationResultSchema,
  studyModeSchema,
} from "./classification.js";
import { extractionOutcomeSchema } from "./extraction.js";
import { seedPaperInputSchema } from "./pre-screen.js";

export const evidenceSpanSchema = z
  .object({
    spanId: z.string().min(1),
    text: z.string(),
    sectionTitle: undefinedable(z.string()),
    blockKind: parsedBlockKindSchema,
    matchMethod: z.enum([
      "keyword_overlap",
      "entity_overlap",
      "claim_term",
      "section_title",
      "bm25",
      "bm25_reranked",
      "llm_reranked",
    ]),
    relevanceScore: z.number(),
    bm25Score: z.number(),
    rerankScore: undefinedable(z.number()),
    charOffsetStart: undefinedable(z.number().int().nonnegative()),
    charOffsetEnd: undefinedable(z.number().int().nonnegative()),
  })
  .passthrough();
export type EvidenceSpan = z.infer<typeof evidenceSpanSchema>;

export const citedPaperResolutionStatusValues = [
  "resolved",
  "missing_doi",
  "resolution_failed",
] as const;

export const citedPaperResolutionStatusSchema = z.enum(
  citedPaperResolutionStatusValues,
);
export type CitedPaperResolutionStatus = z.infer<
  typeof citedPaperResolutionStatusSchema
>;

export const citedPaperFetchStatusValues = [
  "retrieved",
  "no_fulltext",
  "fetch_failed",
  "not_attempted",
] as const;

export const citedPaperFetchStatusSchema = z.enum(citedPaperFetchStatusValues);
export type CitedPaperFetchStatus = z.infer<typeof citedPaperFetchStatusSchema>;

export const citedPaperSourceSchema = z
  .object({
    resolutionStatus: citedPaperResolutionStatusSchema,
    resolutionError: undefinedable(z.string()),
    resolvedPaper: undefinedable(resolvedPaperSchema),
    fetchStatus: citedPaperFetchStatusSchema,
    fetchError: undefinedable(z.string()),
    fullTextFormat: undefinedable(fullTextFormatSchema),
  })
  .passthrough();
export type CitedPaperSource = z.infer<typeof citedPaperSourceSchema>;

export const taskEvidenceRetrievalStatusValues = [
  "retrieved",
  "no_fulltext",
  "no_matches",
  "abstract_only_matches",
  "not_attempted",
  "unresolved_cited_paper",
] as const;

export const taskEvidenceRetrievalStatusSchema = z.enum(
  taskEvidenceRetrievalStatusValues,
);
export type TaskEvidenceRetrievalStatus = z.infer<
  typeof taskEvidenceRetrievalStatusSchema
>;

export const taskWithEvidenceSchema = evaluationTaskSchema
  .extend({
    rubricQuestion: z.string(),
    citedPaperEvidenceSpans: z.array(evidenceSpanSchema),
    evidenceRetrievalStatus: taskEvidenceRetrievalStatusSchema,
  })
  .passthrough();
export type TaskWithEvidence = z.infer<typeof taskWithEvidenceSchema>;

export const edgeWithEvidenceSchema = z
  .object({
    packetId: z.string().min(1),
    citingPaperTitle: z.string().min(1),
    citedPaperTitle: z.string().min(1),
    extractionState: extractionStateSchema,
    extractionOutcome: extractionOutcomeSchema.optional(),
    isReviewMediated: z.boolean(),
    tasks: z.array(taskWithEvidenceSchema),
  })
  .passthrough();
export type EdgeWithEvidence = z.infer<typeof edgeWithEvidenceSchema>;

export const evidenceSummarySchema = z
  .object({
    totalTasks: z.number().int().nonnegative(),
    tasksWithEvidence: z.number().int().nonnegative(),
    tasksNoFulltext: z.number().int().nonnegative(),
    tasksUnresolvedCitedPaper: z.number().int().nonnegative(),
    tasksNoMatches: z.number().int().nonnegative(),
    tasksAbstractOnlyMatches: z.number().int().nonnegative(),
    tasksNotAttempted: z.number().int().nonnegative(),
    totalEvidenceSpans: z.number().int().nonnegative(),
    tasksByMode: z.partialRecord(evaluationModeSchema, z.number().int()),
  })
  .passthrough();
export type EvidenceSummary = z.infer<typeof evidenceSummarySchema>;

export const familyEvidenceResultSchema = z
  .object({
    seed: seedPaperInputSchema,
    resolvedSeedPaperTitle: z.string().min(1),
    studyMode: studyModeSchema,
    groundedSeedClaimText: undefinedable(z.string().min(1)),
    citedPaperFullTextAvailable: z.boolean(),
    citedPaperSource: citedPaperSourceSchema,
    edges: z.array(edgeWithEvidenceSchema),
    summary: evidenceSummarySchema,
  })
  .passthrough();
export type FamilyEvidenceResult = z.infer<typeof familyEvidenceResultSchema>;

export { familyClassificationResultSchema };
