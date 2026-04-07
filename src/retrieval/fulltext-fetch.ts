import { z } from "zod";

import type Database from "better-sqlite3";

import type {
  CachePolicy,
  FullTextFormat,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import {
  fetchJson,
  type FetchJsonOptions,
} from "../integrations/http-client.js";
import {
  computeContentHash,
  getCachedPaper,
  upsertRawPaper,
} from "../storage/paper-cache.js";

export type FullTextContent = {
  content: string;
  format: FullTextFormat;
};

export type FullTextFetchAdapters = {
  fetchXml: (url: string) => Promise<Result<string>>;
  fetchPdf: (url: string) => Promise<Result<Buffer>>;
  processPdfWithGrobid: (buffer: Buffer) => Promise<Result<string>>;
  email: string | undefined;
};

// --- bioRxiv: resolve DOI -> jatsxml URL via API, then fetch ---

const biorxivDetailSchema = z.object({
  collection: z.array(z.object({ jatsxml: z.string().min(1) }).passthrough()),
});

async function fetchBiorxivXml(
  doi: string,
  baseUrl: string,
  adapters: FullTextFetchAdapters,
): Promise<Result<FullTextContent>> {
  const stripped = doi.replace(/^10\.1101\//, "");
  const apiUrl = `${baseUrl}/details/biorxiv/10.1101/${stripped}/na/json`;
  const meta = await fetchJson(apiUrl, biorxivDetailSchema);

  if (!meta.ok) return meta;

  const entry = meta.data.collection[0];
  if (!entry) return { ok: false, error: "No bioRxiv entry found" };

  const xmlResult = await adapters.fetchXml(entry.jatsxml);
  if (!xmlResult.ok) return xmlResult;

  return { ok: true, data: { content: xmlResult.data, format: "jats_xml" } };
}

// --- PMC: resolve DOI -> PMCID, then fetch JATS XML via efetch ---

const pmcIdConverterSchema = z.object({
  records: z.array(z.object({ pmcid: z.string().optional() }).passthrough()),
});

async function fetchPmcXml(
  doi: string,
  adapters: FullTextFetchAdapters,
): Promise<Result<FullTextContent>> {
  const toolParam = "palimpsest";
  const emailParam = adapters.email
    ? `&email=${encodeURIComponent(adapters.email)}`
    : "";
  const idUrl = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(doi)}&format=json&tool=${toolParam}${emailParam}`;

  const idResult = await fetchJson(idUrl, pmcIdConverterSchema);
  if (!idResult.ok) return idResult;

  const record = idResult.data.records[0];
  const pmcid = record?.pmcid;
  if (!pmcid) return { ok: false, error: "No PMCID found for DOI" };

  const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&rettype=xml`;
  const xmlResult = await adapters.fetchXml(efetchUrl);
  if (!xmlResult.ok) return xmlResult;

  return { ok: true, data: { content: xmlResult.data, format: "jats_xml" } };
}

// --- PDF fallback: fetch and extract text ---

async function fetchPdfViaGrobid(
  url: string,
  adapters: FullTextFetchAdapters,
): Promise<Result<FullTextContent>> {
  const pdfResult = await adapters.fetchPdf(url);
  if (!pdfResult.ok) return pdfResult;

  const teiResult = await adapters.processPdfWithGrobid(pdfResult.data);
  if (!teiResult.ok) return teiResult;

  return {
    ok: true,
    data: { content: teiResult.data, format: "grobid_tei_xml" },
  };
}

// --- Public API ---

export type CacheOptions = {
  db: Database.Database;
  cachePolicy: CachePolicy;
};

export async function fetchFullText(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  adapters: FullTextFetchAdapters,
  cache?: CacheOptions,
): Promise<Result<FullTextContent>> {
  if (paper.fullTextStatus.status !== "available") {
    return {
      ok: false,
      error: `Full text not available: ${paper.fullTextStatus.status === "unavailable" ? paper.fullTextStatus.reason : "abstract only"}`,
    };
  }

  if (cache && cache.cachePolicy !== "force_refresh") {
    const cached = getCachedPaper(cache.db, paper.id, cache.cachePolicy);
    if (cached?.rawFullText && cached.fullTextFormat) {
      return {
        ok: true,
        data: {
          content: cached.rawFullText,
          format: cached.fullTextFormat as FullTextContent["format"],
        },
      };
    }
  }

  const result = await fetchFullTextFromNetwork(
    paper,
    biorxivBaseUrl,
    adapters,
  );

  if (result.ok && cache) {
    try {
      upsertRawPaper(cache.db, {
        paperId: paper.id,
        doi: paper.doi,
        openalexId: paper.id.startsWith("https://openalex.org/")
          ? paper.id
          : undefined,
        pmcid: undefined,
        title: paper.title,
        authorsJson: JSON.stringify(paper.authors),
        accessStatus: "available",
        rawFullText: result.data.content,
        fullTextFormat: result.data.format,
        fetchSourceUrl:
          paper.openAccessPdfUrl ??
          paper.openAccessOaUrl ??
          paper.openAccessUrl,
        fetchStatus: "success",
        contentHash: computeContentHash(result.data.content),
        fetchedAt: new Date().toISOString(),
        metadataJson: undefined,
      });
    } catch {
      // cache write failure is non-fatal
    }
  }

  return result;
}

async function fetchFullTextFromNetwork(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  adapters: FullTextFetchAdapters,
): Promise<Result<FullTextContent>> {
  if (paper.fullTextStatus.status !== "available") {
    return { ok: false, error: "Full text not available" };
  }
  const source = paper.fullTextStatus.source;

  if (source === "biorxiv_xml" && paper.doi) {
    return fetchBiorxivXml(paper.doi, biorxivBaseUrl, adapters);
  }

  if (paper.doi) {
    const pmcResult = await fetchPmcXml(paper.doi, adapters);
    if (pmcResult.ok) return pmcResult;
  }

  const directPdfUrl = paper.openAccessPdfUrl ?? paper.openAccessUrl;
  if (directPdfUrl) {
    return fetchPdfViaGrobid(directPdfUrl, adapters);
  }

  return {
    ok: false,
    error: "No fetchable direct full text URL",
  };
}

// --- Default adapter implementations using native fetch ---

const FETCH_OPTIONS: FetchJsonOptions = { timeoutMs: 30_000, maxRetries: 2 };

async function defaultFetchXml(url: string): Promise<Result<string>> {
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "application/xml, text/xml",
        "User-Agent": "palimpsest/0.1",
      },
      signal: AbortSignal.timeout(FETCH_OPTIONS.timeoutMs ?? 30_000),
    });
    if (!resp.ok)
      return { ok: false, error: `HTTP ${String(resp.status)} from ${url}` };
    return { ok: true, data: await resp.text() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function defaultFetchPdf(url: string): Promise<Result<Buffer>> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "palimpsest/0.1" },
      signal: AbortSignal.timeout(FETCH_OPTIONS.timeoutMs ?? 30_000),
    });
    if (!resp.ok)
      return { ok: false, error: `HTTP ${String(resp.status)} from ${url}` };
    const arrayBuf = await resp.arrayBuffer();
    return { ok: true, data: Buffer.from(arrayBuf) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function defaultProcessPdfWithGrobid(
  buffer: Buffer,
  grobidBaseUrl: string,
): Promise<Result<string>> {
  try {
    const formData = new FormData();
    const pdfBytes = Uint8Array.from(buffer).buffer;
    formData.append(
      "input",
      new Blob([pdfBytes], { type: "application/pdf" }),
      "paper.pdf",
    );
    formData.append("consolidateHeader", "0");
    formData.append("consolidateCitations", "0");

    const normalizedBaseUrl = grobidBaseUrl.replace(/\/+$/, "");
    const resp = await fetch(
      `${normalizedBaseUrl}/api/processFulltextDocument`,
      {
        method: "POST",
        headers: {
          "User-Agent": "palimpsest/0.1",
        },
        body: formData,
        signal: AbortSignal.timeout(FETCH_OPTIONS.timeoutMs ?? 30_000),
      },
    );

    if (!resp.ok) {
      return {
        ok: false,
        error: `GROBID HTTP ${String(resp.status)} from ${normalizedBaseUrl}`,
      };
    }

    return { ok: true, data: await resp.text() };
  } catch (err) {
    return {
      ok: false,
      error: `GROBID parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function createDefaultAdapters(
  grobidBaseUrl: string,
  email: string | undefined,
): FullTextFetchAdapters {
  return {
    fetchXml: defaultFetchXml,
    fetchPdf: defaultFetchPdf,
    processPdfWithGrobid: (buffer) =>
      defaultProcessPdfWithGrobid(buffer, grobidBaseUrl),
    email,
  };
}
