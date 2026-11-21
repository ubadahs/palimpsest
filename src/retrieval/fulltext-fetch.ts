import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { Window } from "happy-dom";
import { z } from "zod";

import type { CachePolicy } from "../domain/classification.js";
import type {
  FullTextAcquisition,
  FullTextAcquisitionMethod,
  FullTextAcquisitionSelectedLocatorKind,
  FullTextLocation,
  ResolvedPaper,
  Result,
} from "../domain/common.js";
import type { FullTextFormat } from "../domain/parsing.js";
import { findEuropePmcFreePdfUrls } from "../integrations/europe-pmc.js";
import { fetchJson } from "../integrations/http-client.js";
import { createConcurrencyLimiter } from "../shared/concurrency.js";
import { sha256Text } from "../shared/stable-identity.js";
import {
  computeContentHash,
  getCachedPaper,
  upsertRawPaper,
} from "../storage/paper-cache.js";
import { tracedFetch } from "../telemetry/http.js";
import { rethrowTraceError } from "../telemetry/trace.js";
import { isAttachmentUrl } from "./attachment-url.js";
import { parsePdfWithGrobid } from "./grobid.js";

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
  /** EZproxy or similar prefix URL, e.g. "https://libproxy.example.edu/login?url=". */
  institutionalProxyUrl: string | undefined;
};

/**
 * Typed full-text acquisition failures. Publisher paywalls are `paywall`
 * (per-paper unavailable at the adapter boundary). Provider credential denial
 * for OpenAlex/Anthropic stays outside this surface.
 */
export type FullTextAcquisitionFailureCode =
  | "not_found"
  | "paywall"
  | "authentication"
  | "authorization"
  | "rate_limited"
  | "incomplete_content"
  | "invalid_content"
  | "transport";

type FullTextAcquisitionSuccess = {
  ok: true;
  data: FullTextContent & { acquisition: FullTextAcquisition };
};

type FullTextAcquisitionFailure = {
  ok: false;
  error: string;
  failureCode: FullTextAcquisitionFailureCode;
  acquisition: FullTextAcquisition | undefined;
};

export type FullTextAcquisitionResult =
  | FullTextAcquisitionSuccess
  | FullTextAcquisitionFailure;

export function classifyHttpAcquisitionFailure(
  status: number,
): FullTextAcquisitionFailureCode {
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "paywall";
  if (status === 429) return "rate_limited";
  return "transport";
}

export function classifyAcquisitionAttemptFailure(input: {
  httpStatus?: number | undefined;
  probeClassification?: string | undefined;
  failureReason?: string | undefined;
}): FullTextAcquisitionFailureCode {
  const probe = input.probeClassification ?? "";
  if (
    probe === "html_instead_of_pdf" ||
    probe === "invalid_pdf_payload" ||
    probe === "empty_xml" ||
    probe === "invalid_xml" ||
    probe === "invalid_pmc_html"
  ) {
    return "invalid_content";
  }
  if (probe === "incomplete_full_text") return "incomplete_content";
  if (probe === "network_error") {
    return "transport";
  }
  if (input.httpStatus != null && input.httpStatus >= 400) {
    return classifyHttpAcquisitionFailure(input.httpStatus);
  }
  const reason = (input.failureReason ?? "").toLowerCase();
  if (/no fetchable|no .*found|xml_url_missing|no pmcid/i.test(reason)) {
    return "not_found";
  }
  if (/rate limit|429|too many requests/i.test(reason)) {
    return "rate_limited";
  }
  if (/unauthorized|authentication|api key/i.test(reason)) {
    return "authentication";
  }
  if (/forbidden|permission/i.test(reason)) {
    return "authorization";
  }
  if (/invalid|parse|schema|html_instead|rejected/i.test(reason)) {
    return "invalid_content";
  }
  return "transport";
}

type AcquisitionCandidate = {
  candidateKind:
    | "biorxiv_xml"
    | "pmc_xml"
    | "pmc_html"
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
  followedMetaRefresh?: boolean;
  priority: number;
};

type AcquisitionExecutionState = {
  attempts: FullTextAcquisition["attempts"];
  nextAttemptIndex: number;
  candidates: AcquisitionCandidate[];
  seenCandidateKeys: Set<string>;
  paperDoi: string | undefined;
  tryPmcHtml: boolean;
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
  /** Try the next candidate; the attempt log already says why. */
  | { kind: "continue" };

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
  contentHash?: string | undefined;
  rawHtmlSha256?: string | undefined;
  derivedXmlSha256?: string | undefined;
  projectionVersion?: string | undefined;
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

function resolveHttpUrl(url: string, baseUrl: string): URL | undefined {
  try {
    const resolved = new URL(url, baseUrl);
    if (
      (resolved.protocol === "https:" || resolved.protocol === "http:") &&
      !resolved.username &&
      !resolved.password
    )
      return resolved;
  } catch {
    return undefined;
  }
  return undefined;
}

function readSameOriginMetaRefreshUrl(
  html: string,
  pageUrl: string,
): string | undefined {
  if (!/\bhttp-equiv\b/i.test(html)) {
    return undefined;
  }

  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
    },
  });
  try {
    const document = new window.DOMParser().parseFromString(html, "text/html");
    const refresh = [
      ...document.head.querySelectorAll("meta[http-equiv]"),
    ].find(
      (meta) =>
        meta.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh",
    );
    const content = refresh?.getAttribute("content");
    const target = content?.match(
      /^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/i,
    )?.[1];
    if (!target) return undefined;
    const next = resolveHttpUrl(
      target.replace(/^(['"])(.*)\1$/, "$2"),
      pageUrl,
    );
    if (!next) return undefined;

    const page = new URL(pageUrl);
    next.hash = "";
    page.hash = "";
    if (next.origin !== page.origin || next.href === page.href) {
      return undefined;
    }
    return next.href;
  } finally {
    window.close();
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
      const resolved = resolveHttpUrl(raw, pageUrl);
      if (resolved) {
        target.add(resolved.href);
      }
    }
  }

  return {
    xmlUrls: [...xmlUrls],
    // Supplementary/peer-review attachments are not fallback article texts.
    pdfUrls: [...pdfUrls].filter((url) => !isAttachmentUrl(url)),
  };
}

/**
 * Queue order for a provider location. The publisher's version of record is
 * what citing authors published, so its landing page (60, whose discovered
 * XML runs at 65 and PDFs at 80) and direct PDF (70) go first; a repository
 * copy such as an arXiv preprint (85, landing page 90) is the fallback, still
 * ahead of the institutional proxy (110+).
 */
const LOCATION_PRIORITY: Record<
  FullTextLocation["host"],
  Record<FullTextLocation["kind"], number>
> = {
  publisher: { landing_page: 60, pdf: 70 },
  repository: { pdf: 85, landing_page: 90 },
};

function locationCandidate(
  location: FullTextLocation,
  url: string,
  priorityOffset = 0,
): AcquisitionCandidate {
  const priority =
    LOCATION_PRIORITY[location.host][location.kind] + priorityOffset;
  return location.kind === "pdf"
    ? {
        candidateKind: "direct_pdf",
        method: "direct_pdf_grobid",
        locatorKind: "direct_pdf_url",
        locatorValue: location.url,
        url,
        priority,
      }
    : {
        candidateKind: "landing_page_discovery",
        locatorKind: "landing_page_url",
        locatorValue: location.url,
        url,
        priority,
      };
}

function buildInitialCandidates(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  tryPmcHtml: boolean,
): AcquisitionExecutionState {
  const state: AcquisitionExecutionState = {
    attempts: [],
    nextAttemptIndex: 0,
    candidates: [],
    seenCandidateKeys: new Set(),
    paperDoi: paper.doi,
    tryPmcHtml,
  };
  const requestedDoi =
    paper.resolutionProvenance?.requestedIdentifierType === "doi"
      ? paper.resolutionProvenance.requestedIdentifier
      : undefined;
  const resolvedDoi = paper.doi;
  const { locations } = paper.fullTextHints;

  if (
    requestedDoi?.startsWith("10.1101/") ||
    resolvedDoi?.startsWith("10.1101/") ||
    locations.some((location) => /biorxiv\.org/i.test(location.url))
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

  for (const { url } of locations) {
    const derivedPmcid = parsePmcidFromText(url);
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

  for (const location of locations) {
    enqueueCandidate(state, locationCandidate(location, location.url));
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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
      return { kind: "continue" };
    }
    pmcid = resolved.data;
  }

  if (state.tryPmcHtml && state.paperDoi && /^PMC\d+$/i.test(pmcid)) {
    const normalizedPmcid = pmcid.toUpperCase();
    enqueueCandidate(state, {
      candidateKind: "pmc_html",
      method: "pmc_html_projection",
      locatorKind: "pmc_article_url",
      locatorValue: normalizedPmcid,
      pmcid: normalizedPmcid,
      doi: state.paperDoi,
      url: `https://pmc.ncbi.nlm.nih.gov/articles/${normalizedPmcid}/`,
      priority: 55,
    });
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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

async function executePmcHtmlCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  const { url, doi, pmcid } = candidate;
  if (!url || !doi || !pmcid) throw new Error("Incomplete PMC HTML candidate");
  const attempt = {
    candidateKind: candidate.candidateKind,
    method: "pmc_html_projection" as const,
    locatorKind: candidate.locatorKind,
    locatorValue: candidate.locatorValue,
    url,
  };
  const response = await adapters.fetchUrl(url, { accept: "text/html" });
  if (!response.ok) {
    pushAttempt(state, {
      ...attempt,
      probeClassification: "network_error",
      success: false,
      failureReason: response.error,
    });
    return { kind: "continue" };
  }

  const { status, contentType, body, finalUrl } = response.data;
  const fetched = { ...attempt, httpStatus: status, contentType };
  if (status >= 400) {
    pushAttempt(state, {
      ...fetched,
      probeClassification: "http_error",
      success: false,
      failureReason: `HTTP ${String(status)} from ${url}`,
    });
    return { kind: "continue" };
  }

  const { projectPmcArticleHtml, PMC_HTML_PROJECTION_VERSION } =
    await import("./pmc-html.js");
  const rawHtmlSha256 = createHash("sha256").update(body).digest("hex");
  const projection = {
    rawHtmlSha256,
    projectionVersion: PMC_HTML_PROJECTION_VERSION,
  };
  if (
    (finalUrl !== url && finalUrl !== url.slice(0, -1)) ||
    !looksLikeHtml(body, contentType)
  ) {
    pushAttempt(state, {
      ...fetched,
      ...projection,
      probeClassification: "invalid_pmc_html",
      success: false,
      failureReason:
        "PMC HTML response was not the requested official article page",
    });
    return { kind: "continue" };
  }

  const projected = projectPmcArticleHtml(decodeBody(body), doi);
  if (!projected.ok) {
    pushAttempt(state, {
      ...fetched,
      ...projection,
      probeClassification: "invalid_pmc_html",
      success: false,
      failureReason: projected.error,
    });
    return { kind: "continue" };
  }

  pushAttempt(state, {
    ...fetched,
    ...projection,
    derivedXmlSha256: sha256Text(projected.data),
    probeClassification: "pmc_html_projected",
    success: true,
  });
  return {
    kind: "selected",
    payload: {
      content: projected.data,
      format: "jats_xml",
      method: "pmc_html_projection",
      locatorKind: "pmc_article_url",
      selectedUrl: finalUrl,
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
    return { kind: "continue" };
  }

  return parsePdfResponse(candidate, adapters, state, response.data);
}

async function parsePdfResponse(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
  fetched: FullTextFetchResponse,
): Promise<AcquisitionCandidateResult> {
  const url = candidate.url ?? candidate.locatorValue;
  if (isAttachmentUrl(fetched.finalUrl)) {
    pushAttempt(state, {
      candidateKind: candidate.candidateKind,
      method: candidate.method,
      locatorKind: candidate.locatorKind,
      locatorValue: candidate.locatorValue,
      url: fetched.finalUrl,
      probeClassification: "attachment_url",
      success: false,
      failureReason:
        "Redirect returned a supplementary or peer-review attachment",
    });
    return { kind: "continue" };
  }
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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
      selectedUrl: fetched.finalUrl,
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
    return { kind: "continue" };
  }

  const fetched = response.data;
  if (isPdfBuffer(fetched.body)) {
    return parsePdfResponse(
      { ...candidate, method: "direct_pdf_grobid" },
      adapters,
      state,
      fetched,
    );
  }
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
    return { kind: "continue" };
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
    return { kind: "continue" };
  }

  const html = decodeBody(fetched.body);
  const probeClassification = classifyHtmlDocument(html);
  const discovered = extractLandingPageLinks(html, fetched.finalUrl);
  const foundLinks =
    discovered.xmlUrls.length > 0 || discovered.pdfUrls.length > 0;
  // Some DOI landing pages use a browser refresh before issuing their HTTP redirect.
  const refreshUrl =
    !foundLinks &&
    !candidate.followedMetaRefresh &&
    probeClassification === "html_landing_page"
      ? readSameOriginMetaRefreshUrl(html, fetched.finalUrl)
      : undefined;
  pushAttempt(state, {
    candidateKind: candidate.candidateKind,
    locatorKind: candidate.locatorKind,
    locatorValue: candidate.locatorValue,
    url,
    probeClassification: refreshUrl ? "html_meta_refresh" : probeClassification,
    httpStatus: fetched.status,
    contentType: fetched.contentType,
    success: foundLinks || Boolean(refreshUrl),
    failureReason:
      foundLinks || refreshUrl
        ? undefined
        : "No XML/PDF links found in landing page metadata",
  });

  if (refreshUrl) {
    enqueueCandidate(state, {
      ...candidate,
      url: refreshUrl,
      followedMetaRefresh: true,
    });
  }
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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
    return { kind: "continue" };
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

function isSupportedFullTextFormat(format: string): format is FullTextFormat {
  return format === "jats_xml" || format === "grobid_tei_xml";
}

function decodeCachedAcquisition(
  cached: ReturnType<typeof getCachedPaper>,
  fullTextFormat: FullTextFormat,
): FullTextAcquisition | undefined {
  if (!cached?.acquisitionProvenanceJson) {
    return undefined;
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
    return undefined;
  }
}

/** Proxy candidates run after every open-access one (publisher 110/120). */
const PROXY_PRIORITY_OFFSET = 50;

/**
 * Proxy-prefixed retries of the publisher's locations, plus the DOI landing
 * page for papers whose provider lists none. Only queued after open access
 * failed and a proxy URL is configured; repository copies need no proxy.
 */
function buildProxyCandidates(
  paper: ResolvedPaper,
  proxyUrl: string,
): AcquisitionCandidate[] {
  const prefix = proxyUrl.replace(/\/+$/, "");
  const candidates = paper.fullTextHints.locations
    .filter((location) => location.host === "publisher")
    .map((location) =>
      locationCandidate(
        location,
        `${prefix}${location.url}`,
        PROXY_PRIORITY_OFFSET,
      ),
    );
  if (paper.doi) {
    candidates.push({
      candidateKind: "landing_page_discovery",
      locatorKind: "doi_resolved",
      locatorValue: paper.doi,
      url: `${prefix}https://doi.org/${paper.doi}`,
      priority: 115,
    });
  }
  return candidates;
}

type FullTextInspection = (content: FullTextContent) =>
  | {
      probeClassification: "incomplete_full_text" | "invalid_xml";
      failureReason: string;
    }
  | undefined;

async function executeCandidateQueue(
  state: AcquisitionExecutionState,
  adapters: FullTextFetchAdapters,
  inspect: FullTextInspection | undefined,
): Promise<AcquisitionSuccessPayload | undefined> {
  while (state.candidates.length > 0) {
    const candidate = state.candidates.shift()!;
    if (candidate.url && isAttachmentUrl(candidate.url)) {
      pushAttempt(state, {
        candidateKind: candidate.candidateKind,
        method: candidate.method,
        locatorKind: candidate.locatorKind,
        locatorValue: candidate.locatorValue,
        url: candidate.url,
        probeClassification: "attachment_url",
        success: false,
        failureReason:
          "Supplementary or peer-review attachment is not article full text",
      });
      continue;
    }
    let candidateResult: AcquisitionCandidateResult;

    if (candidate.candidateKind === "biorxiv_xml") {
      candidateResult = await executeBiorxivCandidate(
        candidate,
        adapters,
        state,
      );
    } else if (candidate.candidateKind === "pmc_xml") {
      candidateResult = await executePmcCandidate(candidate, adapters, state);
    } else if (candidate.candidateKind === "pmc_html") {
      candidateResult = await executePmcHtmlCandidate(
        candidate,
        adapters,
        state,
      );
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
      const rejected = inspect?.(candidateResult.payload);
      if (!rejected) return candidateResult.payload;
      const attempt = state.attempts.at(-1)!;
      Object.assign(attempt, rejected, {
        success: false,
        contentHash: computeContentHash(candidateResult.payload.content),
      });
    }
  }
  return undefined;
}

async function enqueueEuropePmcPdfCandidates(
  paper: ResolvedPaper,
  state: AcquisitionExecutionState,
): Promise<void> {
  if (!paper.pmid || !/^\d+$/.test(paper.pmid) || !paper.doi) return;

  const { searchUrl, result } = await findEuropePmcFreePdfUrls(
    paper.pmid,
    paper.doi,
  );
  const urls = result.ok ? result.data : [];
  pushAttempt(state, {
    candidateKind: "europe_pmc_pdf_lookup",
    locatorKind: "pmid_metadata",
    locatorValue: paper.pmid,
    url: searchUrl,
    probeClassification: result.ok ? "metadata" : "lookup_error",
    success: urls.length > 0,
    failureReason: result.ok ? undefined : result.error,
  });
  for (const url of urls) {
    enqueueCandidate(state, {
      candidateKind: "direct_pdf",
      method: "direct_pdf_grobid",
      locatorKind: "direct_pdf_url",
      locatorValue: url,
      url,
      priority: 100,
    });
  }
}

/**
 * The failed attempt that got furthest. A PDF or XML that arrived and then
 * failed to parse explains the loss better than a challenge page tried after
 * it, so it wins over the last attempt.
 */
function mostInformativeFailure(
  attempts: FullTextAcquisition["attempts"],
): FullTextAcquisition["attempts"][number] | undefined {
  const failures = attempts.filter(
    (attempt) =>
      !attempt.success &&
      attempt.failureReason &&
      attempt.probeClassification !== "lookup_error",
  );
  return (
    failures.find(
      (attempt) => attempt.probeClassification === "incomplete_full_text",
    ) ??
    failures.find(
      (attempt) =>
        attempt.probeClassification === "invalid_xml" ||
        attempt.probeClassification === "pdf" ||
        attempt.probeClassification === "xml",
    ) ??
    failures.at(-1)
  );
}

async function acquireFullTextFromNetwork(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  adapters: FullTextFetchAdapters,
  inspect: FullTextInspection | undefined,
  rejectedCache: AcquisitionAttemptInput | undefined,
): Promise<FullTextAcquisitionResult> {
  const state = buildInitialCandidates(paper, biorxivBaseUrl, Boolean(inspect));
  if (rejectedCache) pushAttempt(state, rejectedCache);
  const succeeded = (
    payload: AcquisitionSuccessPayload,
    accessChannel: "open_access" | "institutional_proxy",
  ): FullTextAcquisitionResult => ({
    ok: true,
    data: {
      content: payload.content,
      format: payload.format,
      acquisition: {
        ...makeAcquisition(
          { materializationSource: "network", attempts: state.attempts },
          {
            method: payload.method,
            locatorKind: payload.locatorKind,
            selectedUrl: payload.selectedUrl,
            fullTextFormat: payload.format,
          },
        ),
        accessChannel,
      },
    },
  });

  const openAccess = await executeCandidateQueue(state, adapters, inspect);
  if (openAccess) return succeeded(openAccess, "open_access");

  await enqueueEuropePmcPdfCandidates(paper, state);
  const linkedPdf = await executeCandidateQueue(state, adapters, inspect);
  if (linkedPdf) return succeeded(linkedPdf, "open_access");

  if (adapters.institutionalProxyUrl) {
    for (const candidate of buildProxyCandidates(
      paper,
      adapters.institutionalProxyUrl,
    )) {
      enqueueCandidate(state, candidate);
    }
    const proxied = await executeCandidateQueue(state, adapters, inspect);
    if (proxied) return succeeded(proxied, "institutional_proxy");
  }

  const failure = mostInformativeFailure(state.attempts);
  const failureReason =
    failure?.failureReason ?? "No fetchable full text candidates";
  return {
    ok: false,
    error: failureReason,
    failureCode: failure
      ? classifyAcquisitionAttemptFailure(failure)
      : "not_found",
    acquisition: makeAcquisition(
      { materializationSource: "network", attempts: state.attempts },
      undefined,
      failureReason,
    ),
  };
}

export async function acquireFullText(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  adapters: FullTextFetchAdapters,
  cache?: CacheOptions,
  inspect?: FullTextInspection,
): Promise<FullTextAcquisitionResult> {
  let rejectedCache: AcquisitionAttemptInput | undefined;
  if (cache && cache.cachePolicy !== "force_refresh") {
    const cached = getCachedPaper(cache.db, paper.id, cache.cachePolicy);
    if (
      cached?.rawFullText &&
      cached.fullTextFormat &&
      isSupportedFullTextFormat(cached.fullTextFormat)
    ) {
      const acquisition = decodeCachedAcquisition(
        cached,
        cached.fullTextFormat,
      );
      // Missing or invalid provenance is treated as a cache miss so we do not
      // fabricate acquisition metadata for pre-provenance rows.
      if (acquisition) {
        const data = {
          content: cached.rawFullText,
          format: cached.fullTextFormat,
          acquisition,
        };
        const rejected = inspect?.(data);
        if (!rejected) return { ok: true, data };
        rejectedCache = {
          candidateKind: "raw_cache",
          method: acquisition.selectedMethod,
          locatorKind: acquisition.selectedLocatorKind ?? "paper_id",
          locatorValue: acquisition.selectedUrl ?? paper.id,
          url: acquisition.selectedUrl,
          contentHash:
            cached.contentHash ?? computeContentHash(cached.rawFullText),
          ...rejected,
          success: false,
        };
      }
    }
  }

  const result = await acquireFullTextFromNetwork(
    paper,
    biorxivBaseUrl,
    adapters,
    inspect,
    rejectedCache,
  );

  if (result.ok && cache) {
    try {
      upsertRawPaper(cache.db, {
        paperId: paper.id,
        rawFullText: result.data.content,
        fullTextFormat: result.data.format,
        contentHash: computeContentHash(result.data.content),
        acquisitionProvenanceJson: JSON.stringify(result.data.acquisition),
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

const FULL_TEXT_REQUEST_TIMEOUT_MS = 30_000;

async function defaultFetchUrl(
  url: string,
  options?: { accept?: string },
): Promise<Result<FullTextFetchResponse>> {
  try {
    const resp = await tracedFetch(url, {
      headers: {
        Accept: options?.accept ?? "*/*",
        "User-Agent": "palimpsest/0.1",
      },
      signal: AbortSignal.timeout(FULL_TEXT_REQUEST_TIMEOUT_MS),
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
    rethrowTraceError(err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Concurrent GROBID parses when the caller names no bound. */
const DEFAULT_GROBID_CONCURRENCY = 2;

export type CreateAdaptersOptions = {
  grobidBaseUrl: string;
  /**
   * PDFs sent to GROBID at once. Separate from Discover's fetch concurrency:
   * a local GROBID container times out when several papers fetched side by
   * side all reach it together. Waiting for a slot does not count against the
   * request timeout, which starts when the PDF is sent.
   */
  grobidConcurrency?: number | undefined;
  email: string | undefined;
  institutionalProxyUrl?: string | undefined;
};

export function createDefaultAdapters(
  options: CreateAdaptersOptions,
): FullTextFetchAdapters {
  const limitGrobid = createConcurrencyLimiter(
    options.grobidConcurrency ?? DEFAULT_GROBID_CONCURRENCY,
  );
  return {
    fetchUrl: defaultFetchUrl,
    processPdfWithGrobid: (buffer) =>
      limitGrobid(() => parsePdfWithGrobid(buffer, options.grobidBaseUrl)),
    email: options.email,
    institutionalProxyUrl: options.institutionalProxyUrl,
  };
}
