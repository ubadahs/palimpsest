import { z } from "zod";

export function undefinedable<T extends z.ZodTypeAny>(
  schema: T,
) {
  return z.preprocess((value) => value, schema.optional());
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export const paperSourceValues = [
  "openalex",
  "semantic_scholar",
  "manual",
] as const;

export const paperSourceSchema = z.enum(paperSourceValues);
export type PaperSource = z.infer<typeof paperSourceSchema>;

export const fullTextAvailableSchema = z
  .object({
    status: z.literal("available"),
    source: z.string().min(1),
  })
  .passthrough();

export const fullTextAbstractOnlySchema = z
  .object({
    status: z.literal("abstract_only"),
  })
  .passthrough();

export const fullTextUnavailableSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: z.string().min(1),
  })
  .passthrough();

export const fullTextStatusSchema = z.discriminatedUnion("status", [
  fullTextAvailableSchema,
  fullTextAbstractOnlySchema,
  fullTextUnavailableSchema,
]);
export type FullTextStatus = z.infer<typeof fullTextStatusSchema>;

export const resolvedPaperSchema = z
  .object({
    id: z.string().min(1),
    doi: undefinedable(z.string().min(1)),
    title: z.string().min(1),
    authors: z.array(z.string()),
    abstract: undefinedable(z.string()),
    source: paperSourceSchema,
    openAccessUrl: undefinedable(z.string().min(1)),
    fullTextStatus: fullTextStatusSchema,
    paperType: undefinedable(z.string().min(1)),
    referencedWorksCount: undefinedable(z.number().int()),
    publicationYear: undefinedable(z.number().int()),
  })
  .passthrough();
export type ResolvedPaper = z.infer<typeof resolvedPaperSchema>;

export const edgeClassificationSchema = z
  .object({
    isReview: z.boolean(),
    isCommentary: z.boolean(),
    isLetter: z.boolean(),
    isBookChapter: z.boolean(),
    isPreprint: z.boolean(),
    isJournalArticle: z.boolean(),
    isPrimaryLike: z.boolean(),
    highReferenceCount: z.boolean(),
  })
  .passthrough();
export type EdgeClassification = z.infer<typeof edgeClassificationSchema>;
