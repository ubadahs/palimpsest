import { z } from "zod";

import type {
  FullTextHints,
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

function inferFullTextHints(work: OpenAlexWork): FullTextHints {
  const isOa = work.open_access?.is_oa ?? false;
  const oaUrl = work.open_access?.oa_url ?? undefined;
  const sourceName = work.primary_location?.source?.display_name ?? "";
  const sourceType = work.primary_location?.source?.type ?? "";
  const pdfUrl = work.primary_location?.pdf_url ?? undefined;
  const landingPageUrl = work.primary_location?.landing_page_url ?? undefined;

  let providerAvailability: FullTextHints["providerAvailability"] = "available";
  let providerReason: string | undefined;
  let providerSourceHint: string | undefined;

  if (!isOa || oaUrl == null) {
    providerAvailability = "unavailable";
    providerReason = "No open-access URL available";
  } else {
    for (const { pattern, source } of STRUCTURED_SOURCE_PATTERNS) {
      if (pattern.test(sourceName)) {
        providerSourceHint = source;
        break;
      }
    }

    if (!providerSourceHint) {
      if (sourceType === "repository") {
        providerSourceHint = "repository_pdf";
      } else if (pdfUrl) {
        providerSourceHint = "pdf";
      } else {
        providerSourceHint = "oa_link";
      }
    }
  }

  return {
    providerAvailability,
    providerReason,
    providerSourceHint,
    pdfUrl,
    landingPageUrl,
    repositoryUrl: oaUrl,
    sourceName: work.primary_location?.source?.display_name ?? undefined,
    sourceType: work.primary_location?.source?.type ?? undefined,
  };
}

function toResolvedPaper(work: OpenAlexWork): ResolvedPaper {
  const rawDoi = work.doi ?? undefined;
  const abstract =
    work.abstract_inverted_index != null
      ? reconstructAbstract(work.abstract_inverted_index)
      : undefined;
  const fullTextHints = inferFullTextHints(work);

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
    fullTextHints,
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
  requestedIdentifier:
    | { type: "doi" | "pmcid" | "pmid"; value: string }
    | undefined,
): ResolvedPaper {
  return {
    ...paper,
    resolutionProvenance: {
      method,
      confidence,
      requestedIdentifierType: requestedIdentifier?.type,
      requestedIdentifier: requestedIdentifier?.value,
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
      { type: "doi", value: doi },
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
    data: withResolutionProvenance(result.data, "pmid", "exact", {
      type: "pmid",
      value: pmid,
    }),
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
    data: withResolutionProvenance(result.data, "pmcid", "exact", {
      type: "pmcid",
      value: pmcid,
    }),
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
      undefined,
    ),
  };
}

export async function getCitingWorks(
  openAlexId: string,
  baseUrl: string,
  limit = 50,
  email?: string,
  yearRange?: { fromYear?: number; toYear?: number },
): Promise<Result<ResolvedPaper[]>> {
  let filter = `cites:${openAlexId}`;
  if (yearRange?.fromYear != null) {
    filter += `,publication_year:>=${String(yearRange.fromYear)}`;
  }
  if (yearRange?.toYear != null) {
    filter += `,publication_year:<=${String(yearRange.toYear)}`;
  }
  const url = appendEmail(
    `${baseUrl}/works?filter=${filter}&per_page=${String(limit)}`,
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
