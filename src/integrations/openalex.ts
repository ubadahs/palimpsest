import { z } from "zod";

import type {
  FullTextHints,
  FullTextLocation,
  PaperResolutionProvenance,
  ResolvedPaper,
  Result,
} from "../domain/common.js";
import { parseArxivId } from "../shared/arxiv.js";
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
    is_oa: z.boolean().nullable().optional(),
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
    open_access: openAlexOpenAccessSchema.optional(),
    primary_location: openAlexLocationSchema.optional(),
    locations: z.array(openAlexLocationSchema).nullable().optional(),
    biblio: z
      .object({ volume: z.string().nullable().optional() })
      .nullable()
      .optional(),
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

function stripDoiPrefix(rawDoi: string): string {
  return rawDoi.replace(/^https?:\/\/doi\.org\//i, "");
}

/**
 * The primary location (open or not, since a closed publisher page can still
 * be reached through the institutional proxy) followed by every other
 * open-access location. Publishers often serve a bot challenge where the PDF
 * should be while the same work's arXiv or repository copy downloads cleanly.
 */
function toFullTextLocations(work: OpenAlexWork): FullTextLocation[] {
  const locations: FullTextLocation[] = [];
  const seenUrls = new Set<string>();
  const others = (work.locations ?? []).filter((location) => location?.is_oa);
  for (const location of [work.primary_location, ...others]) {
    if (!location) continue;
    const host =
      location.source?.type === "repository" ? "repository" : "publisher";
    for (const [url, kind] of [
      [location.pdf_url, "pdf"],
      [location.landing_page_url, "landing_page"],
    ] as const) {
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      locations.push({ url, kind, host });
    }
  }
  return locations;
}

function inferFullTextHints(work: OpenAlexWork): FullTextHints {
  const locations = toFullTextLocations(work);
  return work.open_access?.is_oa && work.open_access.oa_url != null
    ? { providerAvailability: "available", locations }
    : {
        providerAvailability: "unavailable",
        providerReason: "No open-access URL available",
        locations,
      };
}

function findArxivId(work: OpenAlexWork): string | undefined {
  for (const text of [
    work.doi,
    ...(work.locations ?? []).flatMap((location) => [
      location?.landing_page_url,
      location?.pdf_url,
    ]),
  ]) {
    const arxivId = text ? parseArxivId(text) : undefined;
    if (arxivId) return arxivId;
  }
  return undefined;
}

function toResolvedPaper(work: OpenAlexWork): ResolvedPaper {
  const rawDoi = work.doi ?? undefined;
  const fullTextHints = inferFullTextHints(work);

  return {
    id: work.id,
    doi: rawDoi ? stripDoiPrefix(rawDoi) : undefined,
    pmcid: work.ids?.pmcid ?? undefined,
    arxivId: findArxivId(work),
    volume: work.biblio?.volume ?? undefined,
    pmid:
      work.ids?.pmid?.replace(
        /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i,
        "",
      ) ?? undefined,
    title: work.display_name,
    authors: (work.authorships ?? []).map((a) => a.author.display_name),
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

/**
 * The fields `toResolvedPaper` and `inferFullTextHints` actually read. Passing
 * `select=` keeps a 200-work neighborhood page small; without it OpenAlex
 * returns every field it has, including the inverted abstract index.
 */
const OPENALEX_SELECT_FIELDS = [
  "id",
  "doi",
  "ids",
  "display_name",
  "authorships",
  "open_access",
  "primary_location",
  "locations",
  "biblio",
  "type",
  "referenced_works_count",
  "publication_year",
].join(",");

function appendSelect(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}select=${OPENALEX_SELECT_FIELDS}`;
}

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
  const url = appendEmail(
    appendSelect(`${baseUrl}/works/${encodedDoi}`),
    email,
  );
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
    appendSelect(
      `${baseUrl}/works?filter=${encodeURIComponent(filter)}&per_page=5`,
    ),
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
    appendSelect(`${baseUrl}/works?search=${query}&per_page=10`),
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

/** Wire-level page provenance for one paginated citing-works request. */
export type OpenAlexCitingWorksPage = {
  pageIndex: number;
  requestUrl: string;
  /** OpenAlex's 1-based `page` parameter. */
  page: number;
  perPage: number;
  returnedCount: number;
  /** Works on this page not already seen on an earlier one, in order. */
  keptCount: number;
  /** OpenAlex `meta.count`, echoed on every page of a given query. */
  responseTotalCount: number;
};

export type CitingWorksResult = {
  papers: ResolvedPaper[];
  pages: OpenAlexCitingWorksPage[];
  /** Authoritative provider-reported total citing-work count for this boundary. */
  providerReportedTotal: number;
  /** "complete" when every citing work was retrieved; "truncated" when the
   * observation limit was reached before the provider's list was exhausted. */
  coverage: "complete" | "truncated";
};

/** OpenAlex's documented maximum `per_page` for the Works API. */
const OPENALEX_MAX_PER_PAGE = 200;

/**
 * OpenAlex serves at most this many results through `page=` paging. Cursor
 * paging goes further but needs an API key, which this client does not send;
 * the neighborhood limit's default matches this ceiling.
 */
const OPENALEX_MAX_PAGED_RESULTS = 10_000;

/**
 * Retrieve up to `limit` citing works (and never more than OpenAlex's
 * page-paging ceiling), treating `limit` as a total observation cap across as
 * many requests as needed. Every page uses the same `per_page` and an
 * explicit sort, so page offsets line up: OpenAlex's default order (citations,
 * age-adjusted) shifts between requests and can repeat or skip a work across
 * pages. A repeated work is still kept once; if that leaves the list short of
 * the provider total, coverage says truncated. Each page's request/response shape
 * is returned so callers can persist page-level provenance.
 */
export async function getCitingWorks(
  openAlexId: string,
  baseUrl: string,
  limit = 50,
  email?: string,
  yearRange?: { fromYear?: number; toYear?: number },
): Promise<Result<CitingWorksResult>> {
  let filter = `cites:${openAlexId}`;
  if (yearRange?.fromYear != null) {
    filter += `,publication_year:>${String(yearRange.fromYear - 1)}`;
  }
  if (yearRange?.toYear != null) {
    filter += `,publication_year:<${String(yearRange.toYear + 1)}`;
  }

  const cap = Math.min(limit, OPENALEX_MAX_PAGED_RESULTS);
  const perPage = Math.max(1, Math.min(OPENALEX_MAX_PER_PAGE, cap));
  const works: OpenAlexWork[] = [];
  const seenIds = new Set<string>();
  const pages: OpenAlexCitingWorksPage[] = [];
  let providerReportedTotal = 0;
  let page = 1;

  while (works.length < cap && (page - 1) * perPage < cap) {
    const url = appendEmail(
      appendSelect(
        `${baseUrl}/works?filter=${filter}&sort=publication_date:asc&per_page=${String(perPage)}&page=${String(page)}`,
      ),
      email,
    );
    const result = await fetchJson(url, openAlexWorksListSchema);
    if (!result.ok) return result;

    providerReportedTotal = result.data.meta.count;
    let keptCount = 0;
    for (const work of result.data.results) {
      if (seenIds.has(work.id)) continue;
      seenIds.add(work.id);
      works.push(work);
      keptCount += 1;
    }
    pages.push({
      pageIndex: page - 1,
      requestUrl: url,
      page,
      perPage,
      returnedCount: result.data.results.length,
      keptCount,
      responseTotalCount: providerReportedTotal,
    });
    page += 1;

    if (
      result.data.results.length < perPage ||
      (page - 1) * perPage >= providerReportedTotal
    ) {
      break;
    }
  }

  const papers = works.slice(0, cap).map(toResolvedPaper);
  const coverage: "complete" | "truncated" =
    papers.length >= providerReportedTotal ? "complete" : "truncated";

  return {
    ok: true,
    data: { papers, pages, providerReportedTotal, coverage },
  };
}
