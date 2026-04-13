import { z } from "zod";

export function undefinedable<T extends z.ZodTypeAny>(schema: T) {
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

export const paperResolutionProvenanceSchema = z
  .object({
    method: z.enum(["doi", "pmcid", "pmid", "title_author_year"]),
    confidence: z.enum(["exact", "high"]),
    requestedIdentifierType: undefinedable(z.enum(["doi", "pmcid", "pmid"])),
    requestedIdentifier: undefinedable(z.string().min(1)),
  })
  .passthrough();
export type PaperResolutionProvenance = z.infer<
  typeof paperResolutionProvenanceSchema
>;

export const providerFullTextAvailabilityValues = [
  "available",
  "abstract_only",
  "unavailable",
] as const;
export const providerFullTextAvailabilitySchema = z.enum(
  providerFullTextAvailabilityValues,
);
export type ProviderFullTextAvailability = z.infer<
  typeof providerFullTextAvailabilitySchema
>;

export const fullTextHintsSchema = z
  .object({
    providerAvailability: providerFullTextAvailabilitySchema,
    providerReason: undefinedable(z.string().min(1)),
    providerSourceHint: undefinedable(z.string().min(1)),
    pdfUrl: undefinedable(z.string().min(1)),
    landingPageUrl: undefinedable(z.string().min(1)),
    repositoryUrl: undefinedable(z.string().min(1)),
    sourceName: undefinedable(z.string().min(1)),
    sourceType: undefinedable(z.string().min(1)),
  })
  .passthrough();
export type FullTextHints = z.infer<typeof fullTextHintsSchema>;

export const fullTextAcquisitionMaterializationSourceValues = [
  "network",
  "raw_cache",
  "parsed_cache",
] as const;
export const fullTextAcquisitionMaterializationSourceSchema = z.enum(
  fullTextAcquisitionMaterializationSourceValues,
);
export type FullTextAcquisitionMaterializationSource = z.infer<
  typeof fullTextAcquisitionMaterializationSourceSchema
>;

export const fullTextAcquisitionMethodValues = [
  "biorxiv_xml",
  "pmc_xml",
  "landing_page_xml",
  "direct_pdf_grobid",
] as const;
export const fullTextAcquisitionMethodSchema = z.enum(
  fullTextAcquisitionMethodValues,
);
export type FullTextAcquisitionMethod = z.infer<
  typeof fullTextAcquisitionMethodSchema
>;

export const fullTextAcquisitionSelectedLocatorKindValues = [
  "pmcid_metadata",
  "pmcid_derived_url",
  "doi_input",
  "doi_resolved",
  "direct_pdf_url",
  "meta_pdf_url",
  "meta_xml_url",
] as const;
export const fullTextAcquisitionSelectedLocatorKindSchema = z.enum(
  fullTextAcquisitionSelectedLocatorKindValues,
);
export type FullTextAcquisitionSelectedLocatorKind = z.infer<
  typeof fullTextAcquisitionSelectedLocatorKindSchema
>;

export const fullTextAcquisitionAttemptSchema = z
  .object({
    attemptIndex: z.number().int().nonnegative(),
    candidateKind: z.string().min(1),
    method: undefinedable(fullTextAcquisitionMethodSchema),
    locatorKind: z.string().min(1),
    locatorValue: z.string().min(1),
    url: undefinedable(z.string().min(1)),
    probeClassification: z.string().min(1),
    httpStatus: undefinedable(z.number().int().nonnegative()),
    contentType: undefinedable(z.string().min(1)),
    success: z.boolean(),
    failureReason: undefinedable(z.string().min(1)),
  })
  .passthrough();
export type FullTextAcquisitionAttempt = z.infer<
  typeof fullTextAcquisitionAttemptSchema
>;

export const accessChannelValues = [
  "open_access",
  "institutional_proxy",
  "local_pdf",
] as const;
export const accessChannelSchema = z.enum(accessChannelValues);
export type AccessChannel = z.infer<typeof accessChannelSchema>;

export const fullTextAcquisitionSchema = z
  .object({
    materializationSource: fullTextAcquisitionMaterializationSourceSchema,
    attempts: z.array(fullTextAcquisitionAttemptSchema),
    selectedMethod: undefinedable(fullTextAcquisitionMethodSchema),
    selectedLocatorKind: undefinedable(
      fullTextAcquisitionSelectedLocatorKindSchema,
    ),
    selectedUrl: undefinedable(z.string().min(1)),
    fullTextFormat: undefinedable(
      z.enum(["jats_xml", "grobid_tei_xml", "pdf_text"]),
    ),
    failureReason: undefinedable(z.string().min(1)),
    /** How the full text was accessed — open access, institutional proxy, or local file. */
    accessChannel: undefinedable(accessChannelSchema),
  })
  .passthrough();
export type FullTextAcquisition = z.infer<typeof fullTextAcquisitionSchema>;

export const resolvedPaperSchema = z
  .object({
    id: z.string().min(1),
    doi: undefinedable(z.string().min(1)),
    pmcid: undefinedable(z.string().min(1)),
    pmid: undefinedable(z.string().min(1)),
    title: z.string().min(1),
    authors: z.array(z.string()),
    abstract: undefinedable(z.string()),
    source: paperSourceSchema,
    fullTextHints: fullTextHintsSchema,
    paperType: undefinedable(z.string().min(1)),
    referencedWorksCount: undefinedable(z.number().int()),
    publicationYear: undefinedable(z.number().int()),
    resolutionProvenance: undefinedable(paperResolutionProvenanceSchema),
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
