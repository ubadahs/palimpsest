import { z } from "zod";

import type Database from "better-sqlite3";

import type {
  CachePolicy,
  FullTextAcquisition,
  FullTextAcquisitionMethod,
  FullTextAcquisitionSelectedLocatorKind,
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

export type FullTextFetchResponse = {
  finalUrl: string;
  status: number;
  contentType: string | undefined;
  body: Buffer;
};

export type FullTextFetchAdapters = {
  fetchUrl: (
    url: string,
    options?: { accept?: string },
  ) => Promise<Result<FullTextFetchResponse>>;
  processPdfWithGrobid: (buffer: Buffer) => Promise<Result<string>>;
  email: string | undefined;
};

export type FullTextAcquisitionSuccess = {
  ok: true;
  data: FullTextContent & { acquisition: FullTextAcquisition };
};

export type FullTextAcquisitionFailure = {
  ok: false;
  error: string;
  acquisition: FullTextAcquisition | undefined;
};

export type FullTextAcquisitionResult =
  | FullTextAcquisitionSuccess
  | FullTextAcquisitionFailure;

type AcquisitionCandidate = {
  candidateKind:
    | "biorxiv_xml"
    | "pmc_xml"
    | "direct_pdf"
    | "landing_page_discovery"
    | "landing_page_xml"
    | "landing_page_pdf";
  method?: FullTextAcquisitionMethod;
  locatorKind: string;
  locatorValue: string;
  url?: string;
  doi?: string;
  pmcid?: string;
  priority: number;
};

type AcquisitionExecutionState = {
  attempts: FullTextAcquisition["attempts"];
  nextAttemptIndex: number;
  candidates: AcquisitionCandidate[];
  seenCandidateKeys: Set<string>;
};

type AcquisitionSuccessPayload = {
  content: string;
  format: FullTextFormat;
  method: FullTextAcquisitionMethod;
  locatorKind: FullTextAcquisitionSelectedLocatorKind;
  selectedUrl: string;
};

type AcquisitionCandidateResult =
  | {
      kind: "selected";
      payload: AcquisitionSuccessPayload;
    }
  | {
      kind: "continue";
      failureReason?: string;
    };

type AcquisitionAttemptInput = {
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
};

// --- bioRxiv: resolve DOI -> jatsxml URL via API, then fetch ---

const biorxivDetailSchema = z.object({
  collection: z.array(z.object({ jatsxml: z.string().min(1) }).passthrough()),
});

// --- PMC: resolve DOI -> PMCID, then fetch JATS XML via efetch ---

const pmcIdConverterSchema = z.object({
  records: z.array(
    z
      .object({
        pmcid: z.string().optional(),
        errmsg: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough(),
  ),
});

// --- Public API ---

export type CacheOptions = {
  db: Database.Database;
  cachePolicy: CachePolicy;
};

function parsePmcidFromText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/\bPMC\d+\b/i);
  return match?.[0]?.toUpperCase();
}

function isPdfBuffer(body: Buffer): boolean {
  return body.subarray(0, 5).toString("ascii") === "%PDF-";
}

function decodeBody(body: Buffer): string {
  return body.toString("utf8");
}

function looksLikeHtml(body: Buffer, contentType: string | undefined): boolean {
  const normalizedContentType = contentType?.toLowerCase() ?? "";
  if (normalizedContentType.includes("text/html")) {
    return true;
  }
  const snippet = decodeBody(body).slice(0, 512).toLowerCase();
  return (
    snippet.includes("<html") ||
    snippet.includes("<!doctype html") ||
    snippet.includes("<head")
  );
}

function looksLikeXml(body: Buffer, contentType: string | undefined): boolean {
  const normalizedContentType = contentType?.toLowerCase() ?? "";
  if (
    normalizedContentType.includes("xml") ||
    normalizedContentType.includes("application/jats+xml")
  ) {
    return true;
  }
  const snippet = decodeBody(body).slice(0, 1024).toLowerCase();
  return (
    snippet.includes("<?xml") ||
    snippet.includes("<article") ||
    snippet.includes("<pmc-articleset") ||
    snippet.includes("<tei")
  );
}

function classifyHtmlDocument(html: string): string {
  const normalized = html.toLowerCase();
  if (
    normalized.includes("pow_challenge") ||
    normalized.includes("cloudpmc") ||
    normalized.includes("captcha") ||
    normalized.includes("challenge")
  ) {
    return "html_challenge";
  }
  if (normalized.includes("preparing to download")) {
    return "html_interstitial";
  }
  return "html_landing_page";
}

function makeAcquisition(
  base: Pick<FullTextAcquisition, "materializationSource" | "attempts">,
  success:
    | {
        method: FullTextAcquisitionMethod;
        locatorKind: FullTextAcquisitionSelectedLocatorKind;
        selectedUrl: string;
        fullTextFormat: FullTextFormat;
      }
    | undefined,
  failureReason?: string,
): FullTextAcquisition {
  return {
    materializationSource: base.materializationSource,
    attempts: base.attempts,
    selectedMethod: success?.method,
    selectedLocatorKind: success?.locatorKind,
    selectedUrl: success?.selectedUrl,
    fullTextFormat: success?.fullTextFormat,
    failureReason,
  };
}

function pushAttempt(
  state: AcquisitionExecutionState,
  attempt: AcquisitionAttemptInput,
): void {
  state.attempts.push({
    attemptIndex: state.nextAttemptIndex,
    ...attempt,
  });
  state.nextAttemptIndex += 1;
}

function enqueueCandidate(
  state: AcquisitionExecutionState,
  candidate: AcquisitionCandidate,
): void {
  const key = [
    candidate.candidateKind,
    candidate.method ?? "",
    candidate.locatorKind,
    candidate.locatorValue,
    candidate.url ?? "",
    candidate.pmcid ?? "",
    candidate.doi ?? "",
  ].join("|");
  if (state.seenCandidateKeys.has(key)) {
    return;
  }
  state.seenCandidateKeys.add(key);
  state.candidates.push(candidate);
  state.candidates.sort((left, right) => left.priority - right.priority);
}

function resolveMaybeUrl(url: string, baseUrl: string): string | undefined {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function extractLandingPageLinks(
  html: string,
  pageUrl: string,
): {
  xmlUrls: string[];
  pdfUrls: string[];
} {
  const xmlUrls = new Set<string>();
  const pdfUrls = new Set<string>();

  const metaPatterns = [
    {
      regex:
        /<meta[^>]+name=["']citation_xml_url["'][^>]+content=["']([^"']+)["']/gi,
      target: xmlUrls,
    },
    {
      regex:
        /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/gi,
      target: pdfUrls,
    },
    {
      regex:
        /<link[^>]+type=["']application\/xml["'][^>]+href=["']([^"']+)["']/gi,
      target: xmlUrls,
    },
    {
      regex:
        /<link[^>]+type=["']application\/pdf["'][^>]+href=["']([^"']+)["']/gi,
      target: pdfUrls,
    },
    {
      regex: /<a[^>]+href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi,
      target: pdfUrls,
    },
  ] as const;

  for (const { regex, target } of metaPatterns) {
    for (const match of html.matchAll(regex)) {
      const raw = match[1];
      if (!raw) {
        continue;
      }
      const resolved = resolveMaybeUrl(raw, pageUrl);
      if (resolved) {
        target.add(resolved);
      }
    }
  }

  return {
    xmlUrls: [...xmlUrls],
    pdfUrls: [...pdfUrls],
  };
}

function buildInitialCandidates(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
): AcquisitionExecutionState {
  const state: AcquisitionExecutionState = {
    attempts: [],
    nextAttemptIndex: 0,
    candidates: [],
    seenCandidateKeys: new Set(),
  };
  const requestedDoi =
    paper.resolutionProvenance?.requestedIdentifierType === "doi"
      ? paper.resolutionProvenance.requestedIdentifier
      : undefined;
  const resolvedDoi = paper.doi;
  const sourceHint =
    paper.fullTextHints.providerSourceHint?.toLowerCase() ?? "";

  if (
    requestedDoi?.startsWith("10.1101/") ||
    resolvedDoi?.startsWith("10.1101/") ||
    sourceHint.includes("biorxiv")
  ) {
    const doi = requestedDoi ?? resolvedDoi;
    if (doi) {
      enqueueCandidate(state, {
        candidateKind: "biorxiv_xml",
        method: "biorxiv_xml",
        locatorKind: requestedDoi ? "doi_input" : "doi_resolved",
        locatorValue: doi,
        doi,
        url: `${biorxivBaseUrl}/details/biorxiv/${encodeURIComponent(doi)}`,
        priority: 10,
      });
    }
  }

  if (paper.pmcid) {
    enqueueCandidate(state, {
      candidateKind: "pmc_xml",
      method: "pmc_xml",
      locatorKind: "pmcid_metadata",
      locatorValue: paper.pmcid,
      pmcid: paper.pmcid,
      priority: 20,
    });
  }

  for (const maybeUrl of [
    paper.fullTextHints.pdfUrl,
    paper.fullTextHints.landingPageUrl,
    paper.fullTextHints.repositoryUrl,
  ]) {
    const derivedPmcid = parsePmcidFromText(maybeUrl);
    if (!derivedPmcid || derivedPmcid === paper.pmcid) {
      continue;
    }
    enqueueCandidate(state, {
      candidateKind: "pmc_xml",
      method: "pmc_xml",
      locatorKind: "pmcid_derived_url",
      locatorValue: derivedPmcid,
      pmcid: derivedPmcid,
      priority: 30,
    });
  }

  if (requestedDoi) {
    enqueueCandidate(state, {
      candidateKind: "pmc_xml",
      method: "pmc_xml",
      locatorKind: "doi_input",
      locatorValue: requestedDoi,
      doi: requestedDoi,
      priority: 40,
    });
  }

  if (resolvedDoi && resolvedDoi !== requestedDoi) {
    enqueueCandidate(state, {
      candidateKind: "pmc_xml",
      method: "pmc_xml",
      locatorKind: "doi_resolved",
      locatorValue: resolvedDoi,
      doi: resolvedDoi,
      priority: 50,
    });
  }

  for (const directPdfUrl of [
    paper.fullTextHints.pdfUrl,
    paper.fullTextHints.repositoryUrl,
  ]) {
    if (!directPdfUrl) {
      continue;
    }
    enqueueCandidate(state, {
      candidateKind: "direct_pdf",
      method: "direct_pdf_grobid",
      locatorKind: "direct_pdf_url",
      locatorValue: directPdfUrl,
      url: directPdfUrl,
      priority: 70,
    });
  }

  for (const discoveryUrl of [
    paper.fullTextHints.landingPageUrl,
    paper.fullTextHints.repositoryUrl,
  ]) {
    if (!discoveryUrl) {
      continue;
    }
    enqueueCandidate(state, {
      candidateKind: "landing_page_discovery",
      locatorKind: "landing_page_url",
      locatorValue: discoveryUrl,
      url: discoveryUrl,
      priority: 60,
    });
  }

  return state;
}

async function fetchUrlForXml(
  url: string,
  adapters: FullTextFetchAdapters,
): Promise<Result<FullTextFetchResponse>> {
  return adapters.fetchUrl(url, { accept: "application/xml, text/xml" });
}

function mapCandidateToSelectedLocatorKind(
  candidate: AcquisitionCandidate,
): FullTextAcquisitionSelectedLocatorKind | undefined {
  switch (candidate.locatorKind) {
    case "pmcid_metadata":
    case "pmcid_derived_url":
    case "doi_input":
    case "doi_resolved":
    case "direct_pdf_url":
    case "meta_pdf_url":
    case "meta_xml_url":
      return candidate.locatorKind;
    default:
      return undefined;
  }
}

async function executeBiorxivCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  const doi = candidate.doi ?? candidate.locatorValue;
  const stripped = doi.replace(/^10\.1101\//, "");
  const apiUrl = `https://api.biorxiv.org/details/biorxiv/10.1101/${stripped}/na/json`;
  const meta = await fetchJson(apiUrl, biorxivDetailSchema);
  if (!meta.ok) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: apiUrl,
      probeClassification: "json_lookup_failed",
      success: false,
      failureReason: meta.error,
    });
    return { kind: "continue", failureReason: meta.error };
  }

  const entry = meta.data.collection[0];
  if (!entry?.jatsxml) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: apiUrl,
      probeClassification: "xml_url_missing",
      success: false,
      failureReason: "No bioRxiv JATS XML URL found",
    });
    return {
      kind: "continue",
      failureReason: "No bioRxiv JATS XML URL found",
    };
  }

  const xmlResponse = await fetchUrlForXml(entry.jatsxml, adapters);
  if (!xmlResponse.ok) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: entry.jatsxml,
      probeClassification: "network_error",
      success: false,
      failureReason: xmlResponse.error,
    });
    return { kind: "continue", failureReason: xmlResponse.error };
  }

  if (xmlResponse.data.status >= 400) {
    const reason = `HTTP ${String(xmlResponse.data.status)} from ${entry.jatsxml}`;
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: entry.jatsxml,
      probeClassification: "http_error",
      httpStatus: xmlResponse.data.status,
      contentType: xmlResponse.data.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  if (!looksLikeXml(xmlResponse.data.body, xmlResponse.data.contentType)) {
    const reason = "bioRxiv XML candidate did not return XML";
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: entry.jatsxml,
      probeClassification: looksLikeHtml(
        xmlResponse.data.body,
        xmlResponse.data.contentType,
      )
        ? classifyHtmlDocument(decodeBody(xmlResponse.data.body))
        : "non_xml_body",
      httpStatus: xmlResponse.data.status,
      contentType: xmlResponse.data.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  pushAttempt(state, {
    candidateKind: candidate.candidateKind,
    method: candidate.method,
    locatorKind: candidate.locatorKind,
    locatorValue: candidate.locatorValue,
    url: entry.jatsxml,
    probeClassification: "xml",
    httpStatus: xmlResponse.data.status,
    contentType: xmlResponse.data.contentType,
    success: true,
  });
  return {
    kind: "selected",
    payload: {
      content: decodeBody(xmlResponse.data.body),
      format: "jats_xml",
      method: "biorxiv_xml",
      locatorKind:
        candidate.locatorKind === "doi_input" ? "doi_input" : "doi_resolved",
      selectedUrl: entry.jatsxml,
    },
  };
}

async function resolvePmcidFromDoi(
  doi: string,
  adapters: FullTextFetchAdapters,
): Promise<Result<string>> {
  const toolParam = "palimpsest";
  const emailParam = adapters.email
    ? `&email=${encodeURIComponent(adapters.email)}`
    : "";
  const idUrl = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(doi)}&format=json&tool=${toolParam}${emailParam}`;
  const idResult = await fetchJson(idUrl, pmcIdConverterSchema);
  if (!idResult.ok) {
    return idResult;
  }
  const record = idResult.data.records[0];
  const pmcid = record?.pmcid;
  if (!pmcid) {
    return {
      ok: false,
      error: record?.errmsg ?? "No PMCID found for DOI",
    };
  }
  return { ok: true, data: pmcid };
}

async function executePmcCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  let pmcid = candidate.pmcid;
  if (!pmcid) {
    const resolved = await resolvePmcidFromDoi(
      candidate.doi ?? candidate.locatorValue,
      adapters,
    );
    if (!resolved.ok) {
      pushAttempt(state, {
        candidateKind: candidate.candidateKind,
        method: candidate.method,
        locatorKind: candidate.locatorKind,
        locatorValue: candidate.locatorValue,
        probeClassification: "pmcid_not_found",
        success: false,
        failureReason: resolved.error,
      });
      return { kind: "continue", failureReason: resolved.error };
    }
    pmcid = resolved.data;
  }

  const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&rettype=xml`;
  const xmlResponse = await fetchUrlForXml(efetchUrl, adapters);
  if (!xmlResponse.ok) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: efetchUrl,
      probeClassification: "network_error",
      success: false,
      failureReason: xmlResponse.error,
    });
    return { kind: "continue", failureReason: xmlResponse.error };
  }

  if (xmlResponse.data.status >= 400) {
    const reason = `HTTP ${String(xmlResponse.data.status)} from ${efetchUrl}`;
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: efetchUrl,
      probeClassification: "http_error",
      httpStatus: xmlResponse.data.status,
      contentType: xmlResponse.data.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  if (!looksLikeXml(xmlResponse.data.body, xmlResponse.data.contentType)) {
    const reason = "PMC candidate did not return XML";
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: efetchUrl,
      probeClassification: looksLikeHtml(
        xmlResponse.data.body,
        xmlResponse.data.contentType,
      )
        ? classifyHtmlDocument(decodeBody(xmlResponse.data.body))
        : "non_xml_body",
      httpStatus: xmlResponse.data.status,
      contentType: xmlResponse.data.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  pushAttempt(state, {
    candidateKind: candidate.candidateKind,
    method: candidate.method,
    locatorKind: candidate.locatorKind,
    locatorValue: candidate.locatorValue,
    url: efetchUrl,
    probeClassification: "xml",
    httpStatus: xmlResponse.data.status,
    contentType: xmlResponse.data.contentType,
    success: true,
  });
  return {
    kind: "selected",
    payload: {
      content: decodeBody(xmlResponse.data.body),
      format: "jats_xml",
      method: "pmc_xml",
      locatorKind:
        mapCandidateToSelectedLocatorKind(candidate) ?? "doi_resolved",
      selectedUrl: efetchUrl,
    },
  };
}

async function executePdfCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  const url = candidate.url ?? candidate.locatorValue;
  const response = await adapters.fetchUrl(url, {
    accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.1",
  });
  if (!response.ok) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: "network_error",
      success: false,
      failureReason: response.error,
    });
    return { kind: "continue", failureReason: response.error };
  }

  const fetched = response.data;
  if (fetched.status >= 400) {
    const reason = `HTTP ${String(fetched.status)} from ${url}`;
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: "http_error",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  if (!isPdfBuffer(fetched.body)) {
    const probeClassification = looksLikeHtml(fetched.body, fetched.contentType)
      ? "html_instead_of_pdf"
      : "invalid_pdf_payload";
    const reason =
      probeClassification === "html_instead_of_pdf"
        ? "PDF candidate rejected: html_instead_of_pdf"
        : "PDF candidate rejected: invalid_pdf_payload";
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification,
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  const teiResult = await adapters.processPdfWithGrobid(fetched.body);
  if (!teiResult.ok) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: "pdf",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: teiResult.error,
    });
    return { kind: "continue", failureReason: teiResult.error };
  }

  pushAttempt(state, {
    candidateKind: candidate.candidateKind,
    method: candidate.method,
    locatorKind: candidate.locatorKind,
    locatorValue: candidate.locatorValue,
    url,
    probeClassification: "pdf",
    httpStatus: fetched.status,
    contentType: fetched.contentType,
    success: true,
  });
  return {
    kind: "selected",
    payload: {
      content: teiResult.data,
      format: "grobid_tei_xml",
      method: "direct_pdf_grobid",
      locatorKind:
        mapCandidateToSelectedLocatorKind(candidate) ?? "direct_pdf_url",
      selectedUrl: url,
    },
  };
}

async function executeLandingPageDiscoveryCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  const url = candidate.url ?? candidate.locatorValue;
  const response = await adapters.fetchUrl(url, {
    accept:
      "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
  });
  if (!response.ok) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: "network_error",
      success: false,
      failureReason: response.error,
    });
    return { kind: "continue", failureReason: response.error };
  }

  const fetched = response.data;
  if (fetched.status >= 400) {
    const reason = `HTTP ${String(fetched.status)} from ${url}`;
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: "http_error",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  if (!looksLikeHtml(fetched.body, fetched.contentType)) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: looksLikeXml(fetched.body, fetched.contentType)
        ? "xml_instead_of_landing_page"
        : "non_html_body",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: "Landing-page discovery URL did not return HTML",
    });
    return {
      kind: "continue",
      failureReason: "Landing-page discovery URL did not return HTML",
    };
  }

  const html = decodeBody(fetched.body);
  const probeClassification = classifyHtmlDocument(html);
  const discovered = extractLandingPageLinks(html, fetched.finalUrl);
  pushAttempt(state, {
    candidateKind: candidate.candidateKind,
    locatorKind: candidate.locatorKind,
    locatorValue: candidate.locatorValue,
    url,
    probeClassification,
    httpStatus: fetched.status,
    contentType: fetched.contentType,
    success: discovered.xmlUrls.length > 0 || discovered.pdfUrls.length > 0,
    failureReason:
      discovered.xmlUrls.length === 0 && discovered.pdfUrls.length === 0
        ? "No XML/PDF links found in landing page metadata"
        : undefined,
  });

  for (const xmlUrl of discovered.xmlUrls) {
    enqueueCandidate(state, {
      candidateKind: "landing_page_xml",
      method: "landing_page_xml",
      locatorKind: "meta_xml_url",
      locatorValue: xmlUrl,
      url: xmlUrl,
      priority: 65,
    });
  }
  for (const pdfUrl of discovered.pdfUrls) {
    enqueueCandidate(state, {
      candidateKind: "landing_page_pdf",
      method: "direct_pdf_grobid",
      locatorKind: "meta_pdf_url",
      locatorValue: pdfUrl,
      url: pdfUrl,
      priority: 80,
    });
  }

  if (discovered.xmlUrls.length === 0 && discovered.pdfUrls.length === 0) {
    return {
      kind: "continue",
      failureReason: "No XML/PDF links found in landing page metadata",
    };
  }

  return { kind: "continue" };
}

async function executeXmlUrlCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  const url = candidate.url ?? candidate.locatorValue;
  const response = await fetchUrlForXml(url, adapters);
  if (!response.ok) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: "network_error",
      success: false,
      failureReason: response.error,
    });
    return { kind: "continue", failureReason: response.error };
  }

  const fetched = response.data;
  if (fetched.status >= 400) {
    const reason = `HTTP ${String(fetched.status)} from ${url}`;
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: "http_error",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  if (!looksLikeXml(fetched.body, fetched.contentType)) {
    const reason = "Landing-page XML candidate did not return XML";
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url,
      probeClassification: looksLikeHtml(fetched.body, fetched.contentType)
        ? classifyHtmlDocument(decodeBody(fetched.body))
        : "non_xml_body",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue", failureReason: reason };
  }

  pushAttempt(state, {
    candidateKind: candidate.candidateKind,
    method: candidate.method,
    locatorKind: candidate.locatorKind,
    locatorValue: candidate.locatorValue,
    url,
    probeClassification: "xml",
    httpStatus: fetched.status,
    contentType: fetched.contentType,
    success: true,
  });
  return {
    kind: "selected",
    payload: {
      content: decodeBody(fetched.body),
      format: "jats_xml",
      method: "landing_page_xml",
      locatorKind: "meta_xml_url",
      selectedUrl: url,
    },
  };
}

function deriveLegacyAcquisition(
  fetchSourceUrl: string | undefined,
  format: FullTextFormat,
): FullTextAcquisition {
  const normalizedUrl = fetchSourceUrl ?? "legacy-cache";
  const isBiorxiv = /biorxiv/i.test(normalizedUrl);
  const isPmc = /pmc|ncbi|pubmed/i.test(normalizedUrl);
  const selectedMethod: FullTextAcquisitionMethod =
    format === "grobid_tei_xml"
      ? "direct_pdf_grobid"
      : isBiorxiv
        ? "biorxiv_xml"
        : isPmc
          ? "pmc_xml"
          : "landing_page_xml";
  const selectedLocatorKind: FullTextAcquisitionSelectedLocatorKind =
    format === "grobid_tei_xml"
      ? "direct_pdf_url"
      : isPmc
        ? "doi_resolved"
        : isBiorxiv
          ? "doi_resolved"
          : "meta_xml_url";

  return {
    materializationSource: "raw_cache",
    attempts: [],
    selectedMethod,
    selectedLocatorKind,
    selectedUrl: normalizedUrl,
    fullTextFormat: format,
    failureReason: undefined,
  };
}

function decodeCachedAcquisition(
  cached: ReturnType<typeof getCachedPaper>,
  fullTextFormat: FullTextFormat,
): FullTextAcquisition | undefined {
  if (!cached?.acquisitionProvenanceJson) {
    return cached?.fetchSourceUrl
      ? deriveLegacyAcquisition(cached.fetchSourceUrl, fullTextFormat)
      : undefined;
  }
  try {
    const parsed = JSON.parse(
      cached.acquisitionProvenanceJson,
    ) as FullTextAcquisition;
    return {
      ...parsed,
      materializationSource: "raw_cache",
      fullTextFormat,
    };
  } catch {
    return cached.fetchSourceUrl
      ? deriveLegacyAcquisition(cached.fetchSourceUrl, fullTextFormat)
      : undefined;
  }
}

async function acquireFullTextFromNetwork(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  adapters: FullTextFetchAdapters,
): Promise<FullTextAcquisitionResult> {
  const state = buildInitialCandidates(paper, biorxivBaseUrl);
  let lastFailureReason = "No fetchable full text candidates";

  while (state.candidates.length > 0) {
    const candidate = state.candidates.shift()!;
    let candidateResult: AcquisitionCandidateResult;

    if (candidate.candidateKind === "biorxiv_xml") {
      candidateResult = await executeBiorxivCandidate(
        candidate,
        adapters,
        state,
      );
    } else if (candidate.candidateKind === "pmc_xml") {
      candidateResult = await executePmcCandidate(candidate, adapters, state);
    } else if (
      candidate.candidateKind === "direct_pdf" ||
      candidate.candidateKind === "landing_page_pdf"
    ) {
      candidateResult = await executePdfCandidate(candidate, adapters, state);
    } else if (candidate.candidateKind === "landing_page_discovery") {
      candidateResult = await executeLandingPageDiscoveryCandidate(
        candidate,
        adapters,
        state,
      );
    } else {
      candidateResult = await executeXmlUrlCandidate(
        candidate,
        adapters,
        state,
      );
    }

    if (candidateResult.kind === "selected") {
      const acquisition = makeAcquisition(
        {
          materializationSource: "network",
          attempts: state.attempts,
        },
        {
          method: candidateResult.payload.method,
          locatorKind: candidateResult.payload.locatorKind,
          selectedUrl: candidateResult.payload.selectedUrl,
          fullTextFormat: candidateResult.payload.format,
        },
      );
      return {
        ok: true,
        data: {
          content: candidateResult.payload.content,
          format: candidateResult.payload.format,
          acquisition,
        },
      };
    }
    if (candidateResult.failureReason) {
      lastFailureReason = candidateResult.failureReason;
    }
  }

  const acquisition = makeAcquisition(
    {
      materializationSource: "network",
      attempts: state.attempts,
    },
    undefined,
    lastFailureReason,
  );
  return {
    ok: false,
    error: lastFailureReason,
    acquisition,
  };
}

export async function acquireFullText(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  adapters: FullTextFetchAdapters,
  cache?: CacheOptions,
): Promise<FullTextAcquisitionResult> {
  if (cache && cache.cachePolicy !== "force_refresh") {
    const cached = getCachedPaper(cache.db, paper.id, cache.cachePolicy);
    if (cached?.rawFullText && cached.fullTextFormat) {
      return {
        ok: true,
        data: {
          content: cached.rawFullText,
          format: cached.fullTextFormat as FullTextContent["format"],
          acquisition:
            decodeCachedAcquisition(
              cached,
              cached.fullTextFormat as FullTextContent["format"],
            ) ??
            deriveLegacyAcquisition(
              cached.fetchSourceUrl,
              cached.fullTextFormat as FullTextContent["format"],
            ),
        },
      };
    }
  }

  const result = await acquireFullTextFromNetwork(
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
        pmcid: paper.pmcid,
        title: paper.title,
        authorsJson: JSON.stringify(paper.authors),
        accessStatus: "available",
        rawFullText: result.data.content,
        fullTextFormat: result.data.format,
        fetchSourceUrl: result.data.acquisition.selectedUrl,
        fetchStatus: "success",
        contentHash: computeContentHash(result.data.content),
        fetchedAt: new Date().toISOString(),
        acquisitionProvenanceJson: JSON.stringify(result.data.acquisition),
        metadataJson: undefined,
      });
    } catch {
      // cache write failure is non-fatal
    }
  }

  return result;
}

export async function fetchFullText(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  adapters: FullTextFetchAdapters,
  cache?: CacheOptions,
): Promise<FullTextAcquisitionResult> {
  return acquireFullText(paper, biorxivBaseUrl, adapters, cache);
}

// --- Default adapter implementations using native fetch ---

const FETCH_OPTIONS: FetchJsonOptions = { timeoutMs: 30_000, maxRetries: 2 };

async function defaultFetchUrl(
  url: string,
  options?: { accept?: string },
): Promise<Result<FullTextFetchResponse>> {
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: options?.accept ?? "*/*",
        "User-Agent": "palimpsest/0.1",
      },
      signal: AbortSignal.timeout(FETCH_OPTIONS.timeoutMs ?? 30_000),
    });
    const arrayBuf = await resp.arrayBuffer();
    return {
      ok: true,
      data: {
        finalUrl: resp.url,
        status: resp.status,
        contentType: resp.headers.get("content-type") ?? undefined,
        body: Buffer.from(arrayBuf),
      },
    };
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
    fetchUrl: defaultFetchUrl,
    processPdfWithGrobid: (buffer) =>
      defaultProcessPdfWithGrobid(buffer, grobidBaseUrl),
    email,
  };
}

export function formatAcquisitionSummary(
  acquisition: FullTextAcquisition | undefined,
): string {
  if (!acquisition?.selectedMethod) {
    return acquisition?.failureReason ?? "acquisition unavailable";
  }
  const locator = acquisition.selectedLocatorKind
    ? ` (${acquisition.selectedLocatorKind})`
    : "";
  return `${acquisition.selectedMethod}${locator}`;
}
