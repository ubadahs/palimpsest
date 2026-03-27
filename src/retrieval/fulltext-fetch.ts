import { z } from "zod";

import type Database from "better-sqlite3";

import type { CachePolicy, ResolvedPaper, Result } from "../domain/types.js";
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
  format: "jats_xml" | "pdf_text";
};

export type FullTextFetchAdapters = {
  fetchXml: (url: string) => Promise<Result<string>>;
  fetchPdf: (url: string) => Promise<Result<Buffer>>;
  extractPdfText: (buffer: Buffer) => Promise<Result<string>>;
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
  const toolParam = "citation-fidelity";
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

async function fetchPdfText(
  url: string,
  adapters: FullTextFetchAdapters,
): Promise<Result<FullTextContent>> {
  const pdfResult = await adapters.fetchPdf(url);
  if (!pdfResult.ok) return pdfResult;

  const textResult = await adapters.extractPdfText(pdfResult.data);
  if (!textResult.ok) return textResult;

  return { ok: true, data: { content: textResult.data, format: "pdf_text" } };
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
        fetchSourceUrl: paper.openAccessUrl,
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

  if (paper.openAccessUrl) {
    return fetchPdfText(paper.openAccessUrl, adapters);
  }

  return { ok: false, error: "No fetchable full text URL" };
}

// --- Default adapter implementations using native fetch ---

const FETCH_OPTIONS: FetchJsonOptions = { timeoutMs: 30_000, maxRetries: 2 };

async function defaultFetchXml(url: string): Promise<Result<string>> {
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "application/xml, text/xml",
        "User-Agent": "citation-fidelity/0.1",
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
      headers: { "User-Agent": "citation-fidelity/0.1" },
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

async function defaultExtractPdfText(buffer: Buffer): Promise<Result<string>> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return { ok: true, data: result.text };
  } catch (err) {
    return {
      ok: false,
      error: `PDF parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function createDefaultAdapters(
  email: string | undefined,
): FullTextFetchAdapters {
  return {
    fetchXml: defaultFetchXml,
    fetchPdf: defaultFetchPdf,
    extractPdfText: defaultExtractPdfText,
    email,
  };
}
