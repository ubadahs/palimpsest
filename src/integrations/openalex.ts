import { z } from "zod";

import type { FullTextStatus, ResolvedPaper, Result } from "../domain/types.js";
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

  return {
    id: work.id,
    doi: rawDoi ? stripDoiPrefix(rawDoi) : undefined,
    title: work.display_name,
    authors: (work.authorships ?? []).map((a) => a.author.display_name),
    abstract,
    source: "openalex",
    openAccessUrl: work.open_access?.oa_url ?? undefined,
    fullTextStatus: inferFullTextStatus(work),
    paperType: work.type ?? undefined,
    referencedWorksCount: work.referenced_works_count,
    publicationYear: work.publication_year ?? undefined,
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
  return { ok: true, data: toResolvedPaper(result.data) };
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
