import { z } from "zod";

export function undefinedable<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => value, schema.optional());
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Provider-normalized publication type (for example `review` or `article`). */
export const paperTypeSchema = z.string().min(1);

export type PaperResolutionProvenance = {
  method: "doi" | "pmcid" | "pmid" | "title_author_year";
  confidence: "exact" | "high";
  requestedIdentifierType?: "doi" | "pmcid" | "pmid" | undefined;
  requestedIdentifier?: string | undefined;
  [key: string]: unknown;
};

/** One place a provider says a work's text can be fetched from. */
export type FullTextLocation = {
  url: string;
  /** A direct PDF link, or a page that may link to the text. */
  kind: "pdf" | "landing_page";
  /**
   * The publisher's version of record, or a repository copy such as an arXiv
   * preprint. Acquisition tries the version of record first.
   */
  host: "publisher" | "repository";
};

export type FullTextHints = {
  providerAvailability: "available" | "abstract_only" | "unavailable";
  providerReason?: string | undefined;
  /** In the provider's order, primary location first; URLs are unique. */
  locations: FullTextLocation[];
};

export type FullTextAcquisitionMethod =
  | "biorxiv_xml"
  | "pmc_xml"
  | "landing_page_xml"
  | "direct_pdf_grobid";

export type FullTextAcquisitionSelectedLocatorKind =
  | "pmcid_metadata"
  | "pmcid_derived_url"
  | "doi_input"
  | "doi_resolved"
  | "direct_pdf_url"
  | "meta_pdf_url"
  | "meta_xml_url";

export type FullTextAcquisition = {
  materializationSource: "network" | "raw_cache" | "parsed_cache";
  attempts: Array<{
    attemptIndex: number;
    candidateKind: string;
    method?: FullTextAcquisitionMethod | undefined;
    locatorKind: string;
    locatorValue: string;
    url?: string | undefined;
    probeClassification: string;
    httpStatus?: number | undefined;
    contentType?: string | undefined;
    success: boolean;
    failureReason?: string | undefined;
    [key: string]: unknown;
  }>;
  selectedMethod?: FullTextAcquisitionMethod | undefined;
  selectedLocatorKind?: FullTextAcquisitionSelectedLocatorKind | undefined;
  selectedUrl?: string | undefined;
  fullTextFormat?: "jats_xml" | "grobid_tei_xml" | undefined;
  failureReason?: string | undefined;
  accessChannel?:
    | "open_access"
    | "institutional_proxy"
    | "local_pdf"
    | undefined;
  [key: string]: unknown;
};

export type ResolvedPaper = {
  id: string;
  doi?: string | undefined;
  pmcid?: string | undefined;
  pmid?: string | undefined;
  /** arXiv identifier without version, e.g. `1806.10165`. */
  arxivId?: string | undefined;
  /** Journal volume, which physics-style references give in place of a title. */
  volume?: string | undefined;
  title: string;
  authors: string[];
  source: "openalex" | "semantic_scholar" | "manual";
  fullTextHints: FullTextHints;
  paperType?: string | undefined;
  referencedWorksCount?: number | undefined;
  publicationYear?: number | undefined;
  resolutionProvenance?: PaperResolutionProvenance | undefined;
  [key: string]: unknown;
};
