import { z } from "zod";

import { resolvedPaperSchema, undefinedable } from "./common.js";
import { parsedCitationMentionSchema } from "./parsing.js";
import { seedPaperInputSchema } from "./pre-screen.js";

export const extractionOutcomeValues = [
  "success_structured",
  "success_pdf",
  "success_grobid",
  "skipped_not_auditable",
  "fail_http_403",
  "fail_pdf_parse_error",
  "fail_grobid_parse_error",
  "fail_no_reference_match",
  "fail_ref_list_empty",
  "fail_ref_found_but_no_in_text_xref",
  "fail_unknown",
] as const;

export const extractionOutcomeSchema = z.enum(extractionOutcomeValues);
export type ExtractionOutcome = z.infer<typeof extractionOutcomeSchema>;

export const markerStyleValues = [
  "author_year",
  "numeric",
  "year_only",
  "unknown",
] as const;

export const markerStyleSchema = z.enum(markerStyleValues);
export type MarkerStyle = z.infer<typeof markerStyleSchema>;

export const contextTypeValues = [
  "bibliography_like",
  "methods_like",
  "narrative_like",
  "unknown",
] as const;

export const contextTypeSchema = z.enum(contextTypeValues);
export type ContextType = z.infer<typeof contextTypeSchema>;

export const confidenceValues = ["low", "medium", "high"] as const;

export const confidenceSchema = z.enum(confidenceValues);
export type Confidence = z.infer<typeof confidenceSchema>;

export const bundlePatternValues = [
  "parenthetical_group",
  "semicolon_separated",
  "single",
  "unknown",
] as const;

export const bundlePatternSchema = z.enum(bundlePatternValues);
export type BundlePattern = z.infer<typeof bundlePatternSchema>;

export const citationMentionSchema = z
  .object({
    isDuplicate: z.boolean(),
    contextLength: z.number().int().nonnegative(),
    markerStyle: markerStyleSchema,
    contextType: contextTypeSchema,
    confidence: confidenceSchema,
    provenance: z
      .object({
        sourceType: z.enum(["jats_xml", "grobid_tei", "pdf_text"]),
        parser: z.string().min(1),
        refId: undefinedable(z.string()),
        charOffsetStart: undefinedable(z.number().int().nonnegative()),
        charOffsetEnd: undefinedable(z.number().int().nonnegative()),
      })
      .passthrough(),
  })
  .extend(
    parsedCitationMentionSchema.omit({
      sourceType: true,
      parser: true,
      refId: true,
      charOffsetStart: true,
      charOffsetEnd: true,
    }).shape,
  )
  .passthrough();
export type CitationMention = z.infer<typeof citationMentionSchema>;

export const edgeExtractionResultSchema = z
  .object({
    citingPaperId: z.string().min(1),
    citedPaperId: z.string().min(1),
    citingPaperTitle: z.string().min(1),
    sourceType: z.enum(["jats_xml", "grobid_tei", "pdf_text", "not_attempted"]),
    extractionOutcome: extractionOutcomeSchema,
    extractionSuccess: z.boolean(),
    usableForGrounding: z.union([z.boolean(), z.literal("unknown")]),
    rawMentionCount: z.number().int().nonnegative(),
    deduplicatedMentionCount: z.number().int().nonnegative(),
    mentions: z.array(citationMentionSchema),
    failureReason: undefinedable(z.string()),
  })
  .passthrough();
export type EdgeExtractionResult = z.infer<typeof edgeExtractionResultSchema>;

export const extractionSummarySchema = z
  .object({
    totalEdges: z.number().int().nonnegative(),
    attemptedEdges: z.number().int().nonnegative(),
    successfulEdgesRaw: z.number().int().nonnegative(),
    successfulEdgesUsable: z.number().int().nonnegative(),
    rawMentionCount: z.number().int().nonnegative(),
    deduplicatedMentionCount: z.number().int().nonnegative(),
    usableMentionCount: z.number().int().nonnegative(),
    failureCountsByOutcome: z.partialRecord(
      extractionOutcomeSchema,
      z.number().int(),
    ),
  })
  .passthrough();
export type ExtractionSummary = z.infer<typeof extractionSummarySchema>;

export const familyExtractionResultSchema = z
  .object({
    seed: seedPaperInputSchema,
    resolvedSeedPaper: resolvedPaperSchema,
    edgeResults: z.array(edgeExtractionResultSchema),
    summary: extractionSummarySchema,
  })
  .passthrough();
export type FamilyExtractionResult = z.infer<
  typeof familyExtractionResultSchema
>;
