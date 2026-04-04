import { z } from "zod";

import type {
  FullTextStatus,
  PaperResolutionProvenance,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import { fetchJson } from "./http-client.js";

// --- Zod schema for the Semantic Scholar Paper endpoint subset ---

const s2PaperSchema = z
  .object({
    paperId: z.string(),
    title: z.string().nullable(),
    authors: z.array(z.object({ name: z.string() })).optional(),
    abstract: z.string().nullable().optional(),
    isOpenAccess: z.boolean().optional(),
    openAccessPdf: z
      .object({ url: z.string().nullable() })
      .nullable()
      .optional(),
    externalIds: z
      .object({
        DOI: z.string().nullable().optional(),
        PubMed: z.string().nullable().optional(),
        PubMedCentral: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    publicationTypes: z.array(z.string()).nullable().optional(),
    referenceCount: z.number().nullable().optional(),
    year: z.number().nullable().optional(),
  })
  .passthrough();

type S2Paper = z.infer<typeof s2PaperSchema>;

// --- Helpers ---

function inferFullTextStatus(paper: S2Paper): FullTextStatus {
  const isOa = paper.isOpenAccess ?? false;
  const pdfUrl = paper.openAccessPdf?.url ?? undefined;

  if (!isOa || pdfUrl == null) {
    return { status: "unavailable", reason: "No open-access PDF available" };
  }

  return { status: "available", source: "pdf" };
}

function mapS2Type(types: string[] | null | undefined): string | undefined {
  if (!types || types.length === 0) return undefined;
  const first = types[0];
  if (!first) return undefined;
  return first.toLowerCase().replace(/\s+/g, "-");
}

function toResolvedPaper(paper: S2Paper): ResolvedPaper {
  return {
    id: paper.paperId,
    doi: paper.externalIds?.DOI ?? undefined,
    pmcid: paper.externalIds?.PubMedCentral ?? undefined,
    pmid: paper.externalIds?.PubMed ?? undefined,
    title: paper.title ?? "Untitled",
    authors: (paper.authors ?? []).map((a) => a.name),
    abstract: paper.abstract ?? undefined,
    source: "semantic_scholar",
    openAccessUrl: paper.openAccessPdf?.url ?? undefined,
    openAccessPdfUrl: paper.openAccessPdf?.url ?? undefined,
    openAccessLandingPageUrl: undefined,
    openAccessOaUrl: undefined,
    fullTextStatus: inferFullTextStatus(paper),
    paperType: mapS2Type(paper.publicationTypes),
    referencedWorksCount: paper.referenceCount ?? undefined,
    publicationYear: paper.year ?? undefined,
    resolutionProvenance: undefined,
  };
}

function withResolutionProvenance(
  paper: ResolvedPaper,
  method: PaperResolutionProvenance["method"],
  confidence: PaperResolutionProvenance["confidence"],
): ResolvedPaper {
  return {
    ...paper,
    resolutionProvenance: {
      method,
      confidence,
    },
  };
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAuthorOverlap(paper: S2Paper, authors: string[]): boolean {
  if (authors.length === 0) {
    return true;
  }

  const expected = new Set(
    authors
      .map((author) => author.trim().split(/\s+/).at(-1)?.toLowerCase())
      .filter((author): author is string => Boolean(author)),
  );
  if (expected.size === 0) {
    return true;
  }

  const actual = new Set(
    (paper.authors ?? [])
      .map((author) => author.name.trim().split(/\s+/).at(-1)?.toLowerCase())
      .filter((author): author is string => Boolean(author)),
  );
  for (const surname of expected) {
    if (actual.has(surname)) {
      return true;
    }
  }
  return false;
}

function matchesPublicationYear(
  paper: S2Paper,
  publicationYear: number | undefined,
): boolean {
  if (!publicationYear || !paper.year) {
    return true;
  }
  return Math.abs(paper.year - publicationYear) <= 1;
}

// --- Public API ---

const S2_FIELDS =
  "paperId,title,authors,abstract,isOpenAccess,openAccessPdf,externalIds,publicationTypes,referenceCount,year";

export async function resolvePaperByDoi(
  doi: string,
  baseUrl: string,
  apiKey?: string,
): Promise<Result<ResolvedPaper>> {
  const url = `${baseUrl}/paper/DOI:${doi}?fields=${S2_FIELDS}`;
  const result = apiKey
    ? await fetchJson(url, s2PaperSchema, { headers: { "x-api-key": apiKey } })
    : await fetchJson(url, s2PaperSchema);

  if (!result.ok) return result;
  return {
    ok: true,
    data: withResolutionProvenance(
      toResolvedPaper(result.data),
      "doi",
      "exact",
    ),
  };
}

export async function resolvePaperByPmid(
  pmid: string,
  baseUrl: string,
  apiKey?: string,
): Promise<Result<ResolvedPaper>> {
  const url = `${baseUrl}/paper/PMID:${pmid}?fields=${S2_FIELDS}`;
  const result = apiKey
    ? await fetchJson(url, s2PaperSchema, { headers: { "x-api-key": apiKey } })
    : await fetchJson(url, s2PaperSchema);

  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    data: withResolutionProvenance(
      toResolvedPaper(result.data),
      "pmid",
      "exact",
    ),
  };
}

export async function resolvePaperByPmcid(
  pmcid: string,
  baseUrl: string,
  apiKey?: string,
): Promise<Result<ResolvedPaper>> {
  const url = `${baseUrl}/paper/PMCID:${pmcid}?fields=${S2_FIELDS}`;
  const result = apiKey
    ? await fetchJson(url, s2PaperSchema, { headers: { "x-api-key": apiKey } })
    : await fetchJson(url, s2PaperSchema);

  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    data: withResolutionProvenance(
      toResolvedPaper(result.data),
      "pmcid",
      "exact",
    ),
  };
}

const s2SearchResponseSchema = z.object({
  data: z.array(s2PaperSchema),
});

export async function resolvePaperByMetadata(
  locator: {
    title: string;
    authors: string[];
    publicationYear?: number;
  },
  baseUrl: string,
  apiKey?: string,
): Promise<Result<ResolvedPaper>> {
  const url = `${baseUrl}/paper/search?query=${encodeURIComponent(locator.title)}&limit=10&fields=${S2_FIELDS}`;
  const result = apiKey
    ? await fetchJson(url, s2SearchResponseSchema, {
        headers: { "x-api-key": apiKey },
      })
    : await fetchJson(url, s2SearchResponseSchema);

  if (!result.ok) {
    return result;
  }

  const normalizedTitle = normalizeTitle(locator.title);
  const candidates = result.data.data.filter(
    (paper) =>
      normalizeTitle(paper.title ?? "") === normalizedTitle &&
      matchesPublicationYear(paper, locator.publicationYear) &&
      hasAuthorOverlap(paper, locator.authors),
  );

  if (candidates.length === 0) {
    return {
      ok: false,
      error: "No high-confidence Semantic Scholar metadata match",
    };
  }

  if (candidates.length > 1) {
    return {
      ok: false,
      error: "Ambiguous Semantic Scholar metadata match",
    };
  }

  return {
    ok: true,
    data: withResolutionProvenance(
      toResolvedPaper(candidates[0]!),
      "title_author_year",
      "high",
    ),
  };
}
