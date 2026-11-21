import { Window } from "happy-dom";
import { isAttachmentUrl } from "./attachment-url.js";
import {
  classifyHtmlDocument,
  decodeBody,
  isPdfBuffer,
  looksLikeHtml,
  looksLikeXml,
} from "./fulltext-document.js";
import type { FullTextFetchAdapters } from "./fulltext-fetch.js";
import {
  candidateAttempt,
  enqueueCandidate,
  pushAttempt,
  selectedVersion,
  type AcquisitionCandidate,
  type AcquisitionCandidateResult,
  type AcquisitionExecutionState,
} from "./fulltext-policy.js";

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

export async function executeLandingPageDiscoveryCandidate(
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
      ...candidateAttempt(candidate, url),
      probeClassification: "network_error",
      success: false,
      failureReason: response.error,
    });
    return { kind: "continue" };
  }

  const fetched = response.data;
  if (isPdfBuffer(fetched.body)) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, fetched.finalUrl),
      probeClassification: "pdf_at_landing_page",
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      success: true,
    });
    enqueueCandidate(state, {
      ...candidate,
      candidateKind: "direct_pdf",
      method: "direct_pdf_grobid",
      url: fetched.finalUrl,
      fetchedPdf: fetched,
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

  if (!looksLikeHtml(fetched.body, fetched.contentType)) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, url),
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
    ...candidateAttempt(candidate, url),
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
      ...candidate,
      candidateKind: "landing_page_xml",
      method: "landing_page_xml",
      locatorKind: "meta_xml_url",
      locatorValue: xmlUrl,
      url: xmlUrl,
      version: selectedVersion(candidate, xmlUrl),
    });
  }
  for (const pdfUrl of discovered.pdfUrls) {
    enqueueCandidate(state, {
      ...candidate,
      candidateKind: "landing_page_pdf",
      method: "direct_pdf_grobid",
      locatorKind: "meta_pdf_url",
      locatorValue: pdfUrl,
      url: pdfUrl,
      version: selectedVersion(candidate, pdfUrl),
    });
  }

  return { kind: "continue" };
}
