import { z } from "zod";

import type {
  FullTextStatus,
  PaperResolutionProvenance,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import { fetchJson } from "./http-client.js";

// --- Zod schemas for the OpenAlex Works API subset we use ---

const openAlexAuthorshipSchema = z.object({
  author: z.object({
    display_name: z.string(),
  }),
});

const openAlexSourceSchema = z
  .object({
    display_name: z.string().nullable(),
    type: z.string().nullable(),
  })
  .nullable();

const openAlexLocationSchema = z
  .object({
    source: openAlexSourceSchema.optional(),
    pdf_url: z.string().nullable().optional(),
    landing_page_url: z.string().nullable().optional(),
  })
  .nullable();

const openAlexOpenAccessSchema = z.object({
  is_oa: z.boolean(),
  oa_url: z.string().nullable().optional(),
});

const openAlexWorkSchema = z
  .object({
    id: z.string(),
    doi: z.string().nullable().optional(),
    ids: z
      .object({
        pmid: z.string().nullable().optional(),
        pmcid: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    display_name: z.string(),
    authorships: z.array(openAlexAuthorshipSchema).optional(),
    abstract_inverted_index: z
      .record(z.string(), z.array(z.number()))
      .nullable()
      .optional(),
    open_access: openAlexOpenAccessSchema.optional(),
    primary_location: openAlexLocationSchema.optional(),
    type: z.string().nullable().optional(),
    referenced_works_count: z.number().optional(),
    publication_year: z.number().nullable().optional(),
  })
  .passthrough();

const openAlexWorksListSchema = z.object({
  meta: z.object({
    count: z.number(),
  }),
  results: z.array(openAlexWorkSchema),
});

type OpenAlexWork = z.infer<typeof openAlexWorkSchema>;

// --- Helpers ---

function reconstructAbstract(invertedIndex: Record<string, number[]>): string {
  const words: string[] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  return words.join(" ");
}

function stripDoiPrefix(rawDoi: string): string {
  return rawDoi.replace(/^https?:\/\/doi\.org\//i, "");
}

const STRUCTURED_SOURCE_PATTERNS = [
  { pattern: /biorxiv/i, source: "biorxiv_xml" },
  { pattern: /pmc|pubmed\s*central/i, source: "pmc_xml" },
];

function inferFullTextStatus(work: OpenAlexWork): FullTextStatus {
  const isOa = work.open_access?.is_oa ?? false;
  const oaUrl = work.open_access?.oa_url ?? undefined;
  const sourceName = work.primary_location?.source?.display_name ?? "";
  const sourceType = work.primary_location?.source?.type ?? "";

  if (!isOa || oaUrl == null) {
    return { status: "unavailable", reason: "No open-access URL available" };
  }

  for (const { pattern, source } of STRUCTURED_SOURCE_PATTERNS) {
    if (pattern.test(sourceName)) {
      return { status: "available", source };
    }
  }

  if (sourceType === "repository") {
    return { status: "available", source: "repository_pdf" };
  }

  if (work.primary_location?.pdf_url) {
    return { status: "available", source: "pdf" };
  }

  return { status: "available", source: "oa_link" };
}

function toResolvedPaper(work: OpenAlexWork): ResolvedPaper {
  const rawDoi = work.doi ?? undefined;
  const abstract =
    work.abstract_inverted_index != null
      ? reconstructAbstract(work.abstract_inverted_index)
      : undefined;
  const pdfUrl = work.primary_location?.pdf_url ?? undefined;
  const landingPageUrl = work.primary_location?.landing_page_url ?? undefined;
  const oaUrl = work.open_access?.oa_url ?? undefined;

  return {
    id: work.id,
    doi: rawDoi ? stripDoiPrefix(rawDoi) : undefined,
    pmcid: work.ids?.pmcid ?? undefined,
    pmid:
      work.ids?.pmid?.replace(
        /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i,
        "",
      ) ?? undefined,
    title: work.display_name,
    authors: (work.authorships ?? []).map((a) => a.author.display_name),
    abstract,
    source: "openalex",
    openAccessUrl: pdfUrl ?? oaUrl ?? landingPageUrl,
    openAccessPdfUrl: pdfUrl,
    openAccessLandingPageUrl: landingPageUrl,
    openAccessOaUrl: oaUrl,
    fullTextStatus: inferFullTextStatus(work),
    paperType: work.type ?? undefined,
    referencedWorksCount: work.referenced_works_count,
    publicationYear: work.publication_year ?? undefined,
    resolutionProvenance: undefined,
  };
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAuthorOverlap(work: OpenAlexWork, authors: string[]): boolean {
  if (authors.length === 0) {
    return true;
  }

  const expectedSurnames = new Set(
    authors
      .map((author) => author.trim().split(/\s+/).at(-1)?.toLowerCase())
      .filter((author): author is string => Boolean(author)),
  );
  if (expectedSurnames.size === 0) {
    return true;
  }

  const workSurnames = new Set(
    (work.authorships ?? [])
      .map((authorship) =>
        authorship.author.display_name
          .trim()
          .split(/\s+/)
          .at(-1)
          ?.toLowerCase(),
      )
      .filter((surname): surname is string => Boolean(surname)),
  );

  for (const surname of expectedSurnames) {
    if (workSurnames.has(surname)) {
      return true;
    }
  }
  return false;
}

function matchesPublicationYear(
  work: OpenAlexWork,
  publicationYear: number | undefined,
): boolean {
  if (!publicationYear || !work.publication_year) {
    return true;
  }
  return Math.abs(work.publication_year - publicationYear) <= 1;
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

// --- Public API ---

function appendEmail(url: string, email: string | undefined): string {
  if (!email) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}mailto=${encodeURIComponent(email)}`;
}

export async function resolveWorkByDoi(
  doi: string,
  baseUrl: string,
  email?: string,
): Promise<Result<ResolvedPaper>> {
  const encodedDoi = encodeURIComponent(`https://doi.org/${doi}`);
  const url = appendEmail(`${baseUrl}/works/${encodedDoi}`, email);
  const result = await fetchJson(url, openAlexWorkSchema);

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

async function resolveWorkByFilter(
  filter: string,
  baseUrl: string,
  email?: string,
): Promise<Result<ResolvedPaper>> {
  const url = appendEmail(
    `${baseUrl}/works?filter=${encodeURIComponent(filter)}&per_page=5`,
    email,
  );
  const result = await fetchJson(url, openAlexWorksListSchema);
  if (!result.ok) {
    return result;
  }

  if (result.data.results.length !== 1) {
    return {
      ok: false,
      error:
        result.data.results.length === 0
          ? `No OpenAlex match for ${filter}`
          : `Ambiguous OpenAlex match for ${filter}`,
    };
  }

  return { ok: true, data: toResolvedPaper(result.data.results[0]!) };
}

export async function resolveWorkByPmid(
  pmid: string,
  baseUrl: string,
  email?: string,
): Promise<Result<ResolvedPaper>> {
  const result = await resolveWorkByFilter(`pmid:${pmid}`, baseUrl, email);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    data: withResolutionProvenance(result.data, "pmid", "exact"),
  };
}

export async function resolveWorkByPmcid(
  pmcid: string,
  baseUrl: string,
  email?: string,
): Promise<Result<ResolvedPaper>> {
  const result = await resolveWorkByFilter(`pmcid:${pmcid}`, baseUrl, email);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    data: withResolutionProvenance(result.data, "pmcid", "exact"),
  };
}

export async function resolveWorkByMetadata(
  locator: {
    title: string;
    authors: string[];
    publicationYear?: number;
  },
  baseUrl: string,
  email?: string,
): Promise<Result<ResolvedPaper>> {
  const query = encodeURIComponent(`"${locator.title}"`);
  const url = appendEmail(
    `${baseUrl}/works?search=${query}&per_page=10`,
    email,
  );
  const result = await fetchJson(url, openAlexWorksListSchema);

  if (!result.ok) {
    return result;
  }

  const normalizedTitle = normalizeTitle(locator.title);
  const candidates = result.data.results.filter(
    (work) =>
      normalizeTitle(work.display_name) === normalizedTitle &&
      matchesPublicationYear(work, locator.publicationYear) &&
      hasAuthorOverlap(work, locator.authors),
  );

  if (candidates.length === 0) {
    return { ok: false, error: "No high-confidence OpenAlex metadata match" };
  }

  if (candidates.length > 1) {
    return { ok: false, error: "Ambiguous OpenAlex metadata match" };
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

export async function getCitingWorks(
  openAlexId: string,
  baseUrl: string,
  limit = 50,
  email?: string,
): Promise<Result<ResolvedPaper[]>> {
  const url = appendEmail(
    `${baseUrl}/works?filter=cites:${openAlexId}&per_page=${String(limit)}`,
    email,
  );
  const result = await fetchJson(url, openAlexWorksListSchema);

  if (!result.ok) return result;
  return { ok: true, data: result.data.results.map(toResolvedPaper) };
}

export async function findPublishedVersion(
  title: string,
  excludeId: string,
  baseUrl: string,
  email?: string,
): Promise<Result<ResolvedPaper>> {
  const query = encodeURIComponent(`"${title}"`);
  const url = appendEmail(
    `${baseUrl}/works?search=${query}&filter=type:article&per_page=5`,
    email,
  );
  const result = await fetchJson(url, openAlexWorksListSchema);

  if (!result.ok) return result;

  const match = result.data.results.find(
    (w) => w.id !== excludeId && w.display_name === title,
  );

  if (!match) {
    return { ok: false, error: "No published version found" };
  }

  return { ok: true, data: toResolvedPaper(match) };
}

export { reconstructAbstract as _reconstructAbstract };
