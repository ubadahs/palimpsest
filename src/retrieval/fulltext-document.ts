import type {
  FullTextAcquisitionSelectedLocatorKind,
  Result,
} from "../domain/common.js";
import type {
  FullTextFetchAdapters,
  FullTextFetchResponse,
} from "./fulltext-fetch.js";
import { isAttachmentUrl } from "./attachment-url.js";
import {
  arxivRevisionMismatch,
  candidateAttempt,
  pushAttempt,
  type AcquisitionCandidate,
  type AcquisitionCandidateResult,
  type AcquisitionExecutionState,
} from "./fulltext-policy.js";

export function isPdfBuffer(body: Buffer): boolean {
  return body.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function decodeBody(body: Buffer): string {
  return body.toString("utf8");
}

export function looksLikeHtml(
  body: Buffer,
  contentType: string | undefined,
): boolean {
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

export function looksLikeXml(
  body: Buffer,
  contentType: string | undefined,
): boolean {
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

export function classifyHtmlDocument(html: string): string {
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
    case "arxiv_identifier":
    case "meta_pdf_url":
    case "meta_xml_url":
      return candidate.locatorKind;
    default:
      return undefined;
  }
}

export async function executePdfCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  if (candidate.fetchedPdf) {
    return parsePdfResponse(candidate, adapters, state, candidate.fetchedPdf);
  }
  const url = candidate.url ?? candidate.locatorValue;
  const response = await adapters.fetchUrl(url, {
    accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.1",
  });
  if (!response.ok) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, url),
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
      ...candidateAttempt(candidate, fetched.finalUrl),
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
      ...candidateAttempt(candidate, url),
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
      ...candidateAttempt(candidate, url),
      probeClassification,
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue" };
  }

  const mismatch = arxivRevisionMismatch(state.target, fetched.finalUrl);
  if (mismatch) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, fetched.finalUrl),
      probeClassification: "version_mismatch",
      success: false,
      failureReason: mismatch,
    });
    return { kind: "continue" };
  }

  const teiResult = await adapters.processPdfWithGrobid(fetched.body);
  if (!teiResult.ok) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, url),
      probeClassification: "pdf",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: teiResult.error,
    });
    return { kind: "continue" };
  }

  pushAttempt(state, {
    ...candidateAttempt(candidate, url),
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

export async function executeXmlUrlCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  const url = candidate.url ?? candidate.locatorValue;
  const method = candidate.method;
  if (
    method !== "biorxiv_xml" &&
    method !== "pmc_xml" &&
    method !== "landing_page_xml"
  ) {
    throw new Error("Incomplete XML candidate");
  }
  const response = await fetchUrlForXml(url, adapters);
  if (!response.ok) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, url),
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
      ...candidateAttempt(candidate, url),
      probeClassification: "http_error",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: false,
      failureReason: reason,
    });
    return { kind: "continue" };
  }

  if (!looksLikeXml(fetched.body, fetched.contentType)) {
    const reason = "Article XML candidate did not return XML";
    pushAttempt(state, {
      ...candidateAttempt(candidate, url),
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

  const mismatch = arxivRevisionMismatch(state.target, fetched.finalUrl);
  if (mismatch) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, fetched.finalUrl),
      probeClassification: "version_mismatch",
      success: false,
      failureReason: mismatch,
    });
    return { kind: "continue" };
  }

  pushAttempt(state, {
    ...candidateAttempt(candidate, url),
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
      method,
      locatorKind:
        mapCandidateToSelectedLocatorKind(candidate) ?? "meta_xml_url",
      selectedUrl: fetched.finalUrl,
    },
  };
}
