import type Database from "better-sqlite3";

import type { CachePolicy } from "../domain/classification.js";
import type {
  FullTextAcquisition,
  FullTextAcquisitionMethod,
  FullTextAcquisitionSelectedLocatorKind,
  FullTextVersionEvidence,
  ResolvedPaper,
  Result,
} from "../domain/common.js";
import type { FullTextFormat } from "../domain/parsing.js";
import { findEuropePmcFreePdfUrls } from "../integrations/europe-pmc.js";
import { createConcurrencyLimiter } from "../shared/concurrency.js";
import {
  computeContentHash,
  getCachedPaper,
  upsertRawPaper,
} from "../storage/paper-cache.js";
import { tracedFetch } from "../telemetry/http.js";
import { rethrowTraceError } from "../telemetry/trace.js";
import { isAttachmentUrl } from "./attachment-url.js";
import {
  executeBiorxivCandidate,
  executePmcCandidate,
  executePmcHtmlCandidate,
} from "./fulltext-archives.js";
import { parsePdfWithGrobid } from "./grobid.js";
import {
  executePdfCandidate,
  executeXmlUrlCandidate,
} from "./fulltext-document.js";
import { executeLandingPageDiscoveryCandidate } from "./fulltext-landing-page.js";
import {
  buildInitialCandidates,
  buildProxyCandidates,
  arxivRevisionMismatch,
  candidateAttempt,
  enqueueCandidate,
  externalPdfCandidate,
  fullTextCacheKey,
  pushAttempt,
  requestedArxivRevision,
  retrievalTarget,
  selectedVersion,
  takeCandidate,
  type AcquisitionAttemptInput,
  type AcquisitionCandidateResult,
  type AcquisitionExecutionState,
  type AcquisitionSuccessPayload,
} from "./fulltext-policy.js";

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
    probe === "invalid_pmc_html" ||
    probe === "version_mismatch"
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

export type CacheOptions = {
  db: Database.Database;
  cachePolicy: CachePolicy;
};

function makeAcquisition(
  base: Pick<FullTextAcquisition, "materializationSource" | "attempts">,
  success:
    | {
        method: FullTextAcquisitionMethod;
        locatorKind: FullTextAcquisitionSelectedLocatorKind;
        selectedUrl: string;
        fullTextFormat: FullTextFormat;
        selectedVersion: FullTextVersionEvidence;
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
    selectedVersion: success?.selectedVersion,
    fullTextFormat: success?.fullTextFormat,
    failureReason,
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
): Promise<
  (AcquisitionSuccessPayload & { version: FullTextVersionEvidence }) | undefined
> {
  for (
    let candidate = takeCandidate(state);
    candidate;
    candidate = takeCandidate(state)
  ) {
    if (candidate.url && isAttachmentUrl(candidate.url)) {
      pushAttempt(state, {
        ...candidateAttempt(candidate, candidate.url),
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
      const { payload } = candidateResult;
      const version = selectedVersion(candidate, payload.selectedUrl);
      const rejected = inspect?.(payload);
      if (!rejected) return { ...payload, version };
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
    enqueueCandidate(state, externalPdfCandidate(url));
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
        attempt.probeClassification === "version_mismatch" ||
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
  target: ReturnType<typeof retrievalTarget>,
): Promise<FullTextAcquisitionResult> {
  const state = buildInitialCandidates(
    paper,
    target,
    biorxivBaseUrl,
    Boolean(inspect),
  );
  if (rejectedCache) pushAttempt(state, rejectedCache);
  const succeeded = (
    payload: AcquisitionSuccessPayload & { version: FullTextVersionEvidence },
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
            selectedVersion: payload.version,
          },
        ),
        accessChannel,
      },
    },
  });

  const openAccess = await executeCandidateQueue(state, adapters, inspect);
  if (openAccess) return succeeded(openAccess, "open_access");

  if (!requestedArxivRevision(target)) {
    await enqueueEuropePmcPdfCandidates(paper, state);
    const linkedPdf = await executeCandidateQueue(state, adapters, inspect);
    if (linkedPdf) return succeeded(linkedPdf, "open_access");

    if (adapters.institutionalProxyUrl) {
      for (const candidate of buildProxyCandidates(
        paper,
        target,
        adapters.institutionalProxyUrl,
      )) {
        enqueueCandidate(state, candidate);
      }
      const proxied = await executeCandidateQueue(state, adapters, inspect);
      if (proxied) return succeeded(proxied, "institutional_proxy");
    }
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
  const target = retrievalTarget(paper);
  const cacheKey = fullTextCacheKey(paper);
  let rejectedCache: AcquisitionAttemptInput | undefined;
  if (cache && cache.cachePolicy !== "force_refresh") {
    const cached = getCachedPaper(cache.db, cacheKey, cache.cachePolicy);
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
        const mismatch = arxivRevisionMismatch(target, acquisition.selectedUrl);
        const rejected = mismatch
          ? { probeClassification: "version_mismatch", failureReason: mismatch }
          : inspect?.(data);
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
    target,
  );

  if (result.ok && cache) {
    try {
      upsertRawPaper(cache.db, {
        paperId: cacheKey,
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
