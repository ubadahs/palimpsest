import { z } from "zod";

import { undefinedable } from "./common.js";
import {
  citationMentionSchema,
  confidenceSchema,
  edgeExtractionResultSchema,
  extractionOutcomeSchema,
  familyExtractionResultSchema,
} from "./extraction.js";
import { seedPaperInputSchema } from "./pre-screen.js";
import { auditabilityStatusSchema } from "./taxonomy.js";

export const extractionStateValues = [
  "extracted",
  "failed",
  "skipped",
] as const;

export const extractionStateSchema = z.enum(extractionStateValues);
export type ExtractionState = z.infer<typeof extractionStateSchema>;

export const citationRoleValues = [
  "substantive_attribution",
  "background_context",
  "methods_materials",
  "acknowledgment_or_low_information",
  "unclear",
] as const;

export const citationRoleSchema = z.enum(citationRoleValues);
export type CitationRole = z.infer<typeof citationRoleSchema>;

export const transmissionModifiersSchema = z
  .object({
    isBundled: z.boolean(),
    isReviewMediated: z.boolean(),
  })
  .passthrough();
export type TransmissionModifiers = z.infer<typeof transmissionModifiersSchema>;

export const evaluationModeValues = [
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

export const studyModeValues = [
  "substantive_only",
  "all_functions_census",
  "background_and_bundled_focus",
  "methods_focus",
  "review_transmission_focus",
] as const;

export const studyModeSchema = z.enum(studyModeValues);
export type StudyMode = z.infer<typeof studyModeSchema>;

export const cachePolicyValues = [
  "prefer_cache",
  "refresh_missing_only",
  "force_refresh",
] as const;

export const cachePolicySchema = z.enum(cachePolicyValues);
export type CachePolicy = z.infer<typeof cachePolicySchema>;

export const classifiedMentionSchema = citationMentionSchema
  .extend({
    citationRole: citationRoleSchema,
    modifiers: transmissionModifiersSchema,
    classificationSignals: z.array(z.string()),
  })
  .passthrough();
export type ClassifiedMention = z.infer<typeof classifiedMentionSchema>;

export const evaluationTaskSchema = z
  .object({
    taskId: z.string().min(1),
    evaluationMode: evaluationModeSchema,
    citationRole: citationRoleSchema,
    modifiers: transmissionModifiersSchema,
    mentions: z.array(classifiedMentionSchema),
    mentionCount: z.number().int().nonnegative(),
  })
  .passthrough();
export type EvaluationTask = z.infer<typeof evaluationTaskSchema>;

export const edgeEvaluationPacketSchema = z
  .object({
    packetId: z.string().min(1),
    studyMode: studyModeSchema,
    citingPaper: z
      .object({
        id: z.string().min(1),
        doi: undefinedable(z.string()),
        title: z.string().min(1),
        paperType: undefinedable(z.string()),
      })
      .passthrough(),
    citedPaper: z
      .object({
        id: z.string().min(1),
        doi: undefinedable(z.string()),
        pmcid: undefinedable(z.string()),
        pmid: undefinedable(z.string()),
        title: z.string().min(1),
        authors: z.array(z.string()),
        publicationYear: undefinedable(z.number().int()),
      })
      .passthrough(),
    extractionState: extractionStateSchema,
    extractionOutcome: extractionOutcomeSchema,
    auditabilityStatus: auditabilityStatusSchema,
    sourceType: z.enum(["jats_xml", "grobid_tei", "pdf_text", "not_attempted"]),
    extractionConfidence: confidenceSchema,
    usableForGrounding: z.union([z.boolean(), z.literal("unknown")]),
    failureReason: undefinedable(z.string()),
    mentions: z.array(classifiedMentionSchema),
    tasks: z.array(evaluationTaskSchema),
    rolesPresent: z.array(citationRoleSchema),
    isReviewMediated: z.boolean(),
    requiresManualReview: z.boolean(),
    usableMentionsCount: z.number().int().nonnegative(),
    bundledMentionsCount: z.number().int().nonnegative(),
    cachedPaperRef: undefinedable(z.string()),
    provenance: z
      .object({
        preScreenRunId: undefinedable(z.string()),
        extractionRunId: undefinedable(z.string()),
        classificationTimestamp: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();
export type EdgeEvaluationPacket = z.infer<typeof edgeEvaluationPacketSchema>;

export const extractionStateSummarySchema = z
  .object({
    totalEdges: z.number().int().nonnegative(),
    extracted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failureCountsByOutcome: z.partialRecord(
      extractionOutcomeSchema,
      z.number().int(),
    ),
  })
  .passthrough();
export type ExtractionStateSummary = z.infer<
  typeof extractionStateSummarySchema
>;

export const literatureStructureSummarySchema = z
  .object({
    edgesWithMentions: z.number().int().nonnegative(),
    totalMentions: z.number().int().nonnegative(),
    totalTasks: z.number().int().nonnegative(),
    countsByRole: z.record(citationRoleSchema, z.number().int()),
    countsByMode: z.record(evaluationModeSchema, z.number().int()),
    bundledMentionCount: z.number().int().nonnegative(),
    bundledMentionRate: z.number().min(0),
    reviewMediatedEdgeCount: z.number().int().nonnegative(),
    reviewMediatedEdgeRate: z.number().min(0),
    manualReviewTaskCount: z.number().int().nonnegative(),
  })
  .passthrough();
export type LiteratureStructureSummary = z.infer<
  typeof literatureStructureSummarySchema
>;

export const classificationSummarySchema = z
  .object({
    extractionState: extractionStateSummarySchema,
    literatureStructure: literatureStructureSummarySchema,
  })
  .passthrough();
export type ClassificationSummary = z.infer<typeof classificationSummarySchema>;

export const familyClassificationResultSchema = z
  .object({
    seed: seedPaperInputSchema,
    resolvedSeedPaperTitle: z.string().min(1),
    studyMode: studyModeSchema,
    packets: z.array(edgeEvaluationPacketSchema),
    summary: classificationSummarySchema,
  })
  .passthrough();
export type FamilyClassificationResult = z.infer<
  typeof familyClassificationResultSchema
>;

export const rubricQuestionSchema = z
  .object({
    mode: evaluationModeSchema,
    question: z.string(),
    verdictOptions: z.array(z.string()),
  })
  .passthrough();
export type RubricQuestion = z.infer<typeof rubricQuestionSchema>;

export { edgeExtractionResultSchema, familyExtractionResultSchema };
