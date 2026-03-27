import { z } from "zod";

import type { FullTextStatus, ResolvedPaper, Result } from "../domain/types.js";
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
      .object({ DOI: z.string().nullable().optional() })
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
    title: paper.title ?? "Untitled",
    authors: (paper.authors ?? []).map((a) => a.name),
    abstract: paper.abstract ?? undefined,
    source: "semantic_scholar",
    openAccessUrl: paper.openAccessPdf?.url ?? undefined,
    fullTextStatus: inferFullTextStatus(paper),
    paperType: mapS2Type(paper.publicationTypes),
    referencedWorksCount: paper.referenceCount ?? undefined,
    publicationYear: paper.year ?? undefined,
  };
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
  return { ok: true, data: toResolvedPaper(result.data) };
}
