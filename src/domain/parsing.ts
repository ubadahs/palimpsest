import { z } from "zod";

import { undefinedable } from "./common.js";

export const fullTextFormatValues = [
  "jats_xml",
  "grobid_tei_xml",
  "pdf_text",
] as const;

export const fullTextFormatSchema = z.enum(fullTextFormatValues);
export type FullTextFormat = z.infer<typeof fullTextFormatSchema>;

export const parsedPaperParserKindValues = [
  "jats",
  "grobid_tei",
  "legacy_pdf_text",
] as const;

export const parsedPaperParserKindSchema = z.enum(parsedPaperParserKindValues);
export type ParsedPaperParserKind = z.infer<typeof parsedPaperParserKindSchema>;

export const parsedBlockKindValues = [
  "abstract",
  "body_paragraph",
  "figure_caption",
  "table_caption",
] as const;

export const parsedBlockKindSchema = z.enum(parsedBlockKindValues);
export type ParsedBlockKind = z.infer<typeof parsedBlockKindSchema>;

export const parsedPaperBlockSchema = z
  .object({
    blockId: z.string().min(1),
    text: z.string().min(1),
    sectionTitle: undefinedable(z.string()),
    blockKind: parsedBlockKindSchema,
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().nonnegative(),
  })
  .passthrough();
export type ParsedPaperBlock = z.infer<typeof parsedPaperBlockSchema>;

export const parsedPaperReferenceSchema = z
  .object({
    refId: z.string().min(1),
    doi: undefinedable(z.string()),
    title: undefinedable(z.string()),
    label: undefinedable(z.string()),
    authorSurnames: z.array(z.string()),
    year: undefinedable(z.number().int()),
    pmcid: undefinedable(z.string()),
    pmid: undefinedable(z.string()),
  })
  .passthrough();
export type ParsedPaperReference = z.infer<typeof parsedPaperReferenceSchema>;

export const parsedCitationMentionSchema = z
  .object({
    mentionIndex: z.number().int().nonnegative(),
    rawContext: z.string(),
    citationMarker: z.string(),
    sectionTitle: undefinedable(z.string()),
    refId: undefinedable(z.string()),
    charOffsetStart: undefinedable(z.number().int().nonnegative()),
    charOffsetEnd: undefinedable(z.number().int().nonnegative()),
    isBundledCitation: z.boolean(),
    bundleSize: z.number().int().positive(),
    bundleRefIds: z.array(z.string()),
    bundlePattern: z.enum([
      "parenthetical_group",
      "semicolon_separated",
      "single",
      "unknown",
    ]),
    sourceType: z.enum(["jats_xml", "grobid_tei", "pdf_text"]),
    parser: z.string().min(1),
  })
  .passthrough();
export type ParsedCitationMention = z.infer<typeof parsedCitationMentionSchema>;

export const parsedPaperDocumentSchema = z
  .object({
    parserKind: parsedPaperParserKindSchema,
    parserVersion: z.string().min(1),
    fullTextFormat: fullTextFormatSchema,
    blocks: z.array(parsedPaperBlockSchema),
    references: z.array(parsedPaperReferenceSchema),
    mentions: z.array(parsedCitationMentionSchema),
  })
  .passthrough();
export type ParsedPaperDocument = z.infer<typeof parsedPaperDocumentSchema>;
