import { createHash } from "node:crypto";
import {
  findBiorxivXmlUrl,
  resolvePmcidFromDoi,
} from "../integrations/paper-archives.js";
import { sha256Text } from "../shared/stable-identity.js";
import {
  decodeBody,
  executeXmlUrlCandidate,
  looksLikeHtml,
} from "./fulltext-document.js";
import type { FullTextFetchAdapters } from "./fulltext-fetch.js";
import {
  candidateAttempt,
  enqueueCandidate,
  pushAttempt,
  type AcquisitionCandidate,
  type AcquisitionCandidateResult,
  type AcquisitionExecutionState,
} from "./fulltext-policy.js";

export async function executeBiorxivCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  const apiUrl = candidate.url;
  if (!apiUrl) throw new Error("Incomplete bioRxiv candidate");
  const meta = await findBiorxivXmlUrl(apiUrl);
  if (!meta.ok) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, apiUrl),
      probeClassification: "json_lookup_failed",
      success: false,
      failureReason: meta.error,
    });
    return { kind: "continue" };
  }

  const xmlUrl = meta.data;
  if (!xmlUrl) {
    pushAttempt(state, {
      ...candidateAttempt(candidate, apiUrl),
      probeClassification: "xml_url_missing",
      success: false,
      failureReason: "No bioRxiv JATS XML URL found",
    });
    return { kind: "continue" };
  }

  return executeXmlUrlCandidate({ ...candidate, url: xmlUrl }, adapters, state);
}

export async function executePmcCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  let pmcid = candidate.pmcid;
  if (!pmcid) {
    const resolved = await resolvePmcidFromDoi(
      candidate.doi ?? candidate.locatorValue,
      adapters.email,
    );
    if (!resolved.ok) {
      pushAttempt(state, {
        ...candidateAttempt(candidate),
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
      version: candidate.version,
    });
  }

  const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&rettype=xml`;
  return executeXmlUrlCandidate(
    { ...candidate, url: efetchUrl },
    adapters,
    state,
  );
}

export async function executePmcHtmlCandidate(
  candidate: AcquisitionCandidate,
  adapters: FullTextFetchAdapters,
  state: AcquisitionExecutionState,
): Promise<AcquisitionCandidateResult> {
  const { url, doi, pmcid } = candidate;
  if (!url || !doi || !pmcid) throw new Error("Incomplete PMC HTML candidate");
  const attempt = {
    ...candidateAttempt(candidate, url),
    method: "pmc_html_projection" as const,
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
