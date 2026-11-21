import type {
  FullTextAcquisition,
  FullTextAcquisitionMethod,
  FullTextAcquisitionSelectedLocatorKind,
  FullTextLocation,
  FullTextVersionEvidence,
  ResolvedPaper,
} from "../domain/common.js";
import { normalizeDoi } from "../contract/artifacts/checks.js";
import type { FullTextFormat } from "../domain/parsing.js";
import { parseArxivDoi, parseBareArxivIdentifier } from "../shared/arxiv.js";
import type { FullTextFetchResponse } from "./fulltext-fetch.js";

export type AcquisitionCandidate = {
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
  host?: FullTextLocation["host"];
  version: FullTextVersionEvidence;
  fetchedPdf?: FullTextFetchResponse;
};

export type AcquisitionExecutionState = {
  attempts: FullTextAcquisition["attempts"];
  candidates: AcquisitionCandidate[];
  attemptedCandidateKeys: Set<string>;
  target: RetrievalTarget;
  paperDoi: string | undefined;
  tryPmcHtml: boolean;
};

export type AcquisitionSuccessPayload = {
  content: string;
  format: FullTextFormat;
  method: FullTextAcquisitionMethod;
  locatorKind: FullTextAcquisitionSelectedLocatorKind;
  selectedUrl: string;
};

export type AcquisitionCandidateResult =
  | {
      kind: "selected";
      payload: AcquisitionSuccessPayload;
    }
  /** Try the next candidate; the attempt log already says why. */
  | { kind: "continue" };

export type AcquisitionAttemptInput = {
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
  version?: FullTextVersionEvidence | undefined;
};

export function candidateAttempt(
  candidate: AcquisitionCandidate,
  url?: string,
) {
  return {
    candidateKind: candidate.candidateKind,
    method: candidate.method,
    locatorKind: candidate.locatorKind,
    locatorValue: candidate.locatorValue,
    url: url ?? candidate.url,
    version: candidate.version,
  };
}

type ArxivReference = NonNullable<ReturnType<typeof parseBareArxivIdentifier>>;

type RetrievalTarget = {
  doi: string | undefined;
  requestedDoi: string | undefined;
  arxiv: ArxivReference | undefined;
};

const unknownVersion = { version: "unknown" } as const;

function identifyArxivUrl(url: string): ArxivReference | undefined {
  const parsed = URL.parse(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return undefined;
  if (/^(?:(?:www|export)\.)?arxiv\.org$/i.test(parsed.hostname)) {
    const identifier = parsed.pathname.match(/^\/(?:abs|pdf|html)\/(.+)$/)?.[1];
    return identifier
      ? parseBareArxivIdentifier(identifier.replace(/\.pdf$/i, ""))
      : undefined;
  }
  if (parsed.hostname === "doi.org")
    return parseArxivDoi(parsed.pathname.slice(1));
  return undefined;
}

export function retrievalTarget(paper: ResolvedPaper): RetrievalTarget {
  const requestedDoi =
    paper.resolutionProvenance?.requestedIdentifierType === "doi"
      ? paper.resolutionProvenance.requestedIdentifier
      : undefined;
  const doi = requestedDoi ?? paper.doi;
  const arxiv = parseArxivDoi(doi);
  // A provider's preprint identifier beside a journal DOI describes an
  // alternate copy. A versioned arXiv DOI is an explicit revision request.
  const identifiesPublishedCopy =
    doi ||
    paper.fullTextHints.locations.some(
      ({ version }) => version === "published",
    );
  return {
    doi,
    requestedDoi,
    arxiv:
      arxiv ??
      (identifiesPublishedCopy ? undefined : providerArxivReference(paper)),
  };
}

function providerArxivReference(
  paper: ResolvedPaper,
): ArxivReference | undefined {
  const identifier = paper.arxivVersionedId ?? paper.arxivId;
  return identifier ? parseBareArxivIdentifier(identifier) : undefined;
}

export function requestedArxivRevision(
  target: RetrievalTarget,
): string | undefined {
  return target.arxiv && target.arxiv.identifier !== target.arxiv.id
    ? target.arxiv.identifier
    : undefined;
}

export function arxivRevisionMismatch(
  target: RetrievalTarget,
  url: string | undefined,
): string | undefined {
  const revision = requestedArxivRevision(target);
  if (revision && (!url || identifyArxivUrl(url)?.identifier !== revision)) {
    return `Source URL did not identify the requested arXiv revision ${revision}`;
  }
  return undefined;
}

export function fullTextCacheKey(paper: ResolvedPaper): string {
  const arxiv = retrievalTarget(paper).arxiv;
  return arxiv ? `${paper.id}:arxiv:${arxiv.identifier}` : paper.id;
}

export function selectedVersion(
  candidate: AcquisitionCandidate,
  finalUrl: string,
): FullTextVersionEvidence {
  const arxiv = identifyArxivUrl(finalUrl);
  if (arxiv) return arxivVersion(arxiv);
  // A redirect to a different service no longer identifies an arXiv revision.
  return candidate.version.version === "submitted" &&
    candidate.version.source === "arxiv_identifier"
    ? unknownVersion
    : candidate.version;
}

function arxivVersion(reference: ArxivReference): FullTextVersionEvidence {
  return {
    version: "submitted",
    source: "arxiv_identifier",
    identifier: reference.identifier,
  };
}

function locationVersion(location: FullTextLocation): FullTextVersionEvidence {
  const arxiv = identifyArxivUrl(location.url);
  if (arxiv) return arxivVersion(arxiv);
  return location.version
    ? {
        version: location.version,
        source: "openalex_location",
        ...(location.doi ? { doi: location.doi } : {}),
      }
    : unknownVersion;
}

function matchesArxivTarget(
  version: FullTextVersionEvidence,
  target: ArxivReference,
): boolean {
  return (
    version.version === "submitted" &&
    version.source === "arxiv_identifier" &&
    (version.identifier === target.identifier ||
      (target.identifier === target.id &&
        version.identifier.startsWith(target.id + "v")))
  );
}

function versionOrder(
  candidate: AcquisitionCandidate,
  target: RetrievalTarget,
): number {
  const version = candidate.version;
  if (target.arxiv && matchesArxivTarget(version, target.arxiv)) return 0;
  if (
    version.version === "published" &&
    version.doi &&
    target.doi &&
    normalizeDoi(version.doi) === normalizeDoi(target.doi)
  )
    return 0;
  if (
    version.version === "submitted" &&
    version.source === "biorxiv_doi" &&
    version.identifier === target.doi
  )
    return 0;
  switch (version.version) {
    case "published":
      return 1;
    case "accepted":
      return 3;
    case "submitted":
      return 4;
    case "unknown":
      // Publisher and PMC material are reasonable first tries when the
      // catalog has no version label. Their provenance still says unknown.
      return candidate.host === "publisher" ||
        candidate.method === "pmc_xml" ||
        candidate.method === "pmc_html_projection"
        ? 2
        : 5;
  }
}

const FORMAT_ORDER: Record<AcquisitionCandidate["candidateKind"], number> = {
  biorxiv_xml: 0,
  pmc_xml: 0,
  pmc_html: 1,
  landing_page_xml: 1,
  landing_page_discovery: 2,
  direct_pdf: 3,
  landing_page_pdf: 3,
};

function compareCandidates(
  left: AcquisitionCandidate,
  right: AcquisitionCandidate,
  target: RetrievalTarget,
): number {
  return (
    versionOrder(left, target) - versionOrder(right, target) ||
    FORMAT_ORDER[left.candidateKind] - FORMAT_ORDER[right.candidateKind]
  );
}

function candidateKey(candidate: AcquisitionCandidate): string {
  if (candidate.candidateKind === "pmc_xml") {
    return candidate.pmcid
      ? "pmc_xml:" + candidate.pmcid.toUpperCase()
      : "pmc_doi:" + candidate.doi;
  }
  const kind =
    candidate.method === "direct_pdf_grobid" ? "pdf" : candidate.candidateKind;
  return kind + ":" + (candidate.url ?? candidate.locatorValue);
}

export function pushAttempt(
  state: AcquisitionExecutionState,
  attempt: AcquisitionAttemptInput,
): void {
  state.attempts.push({ attemptIndex: state.attempts.length, ...attempt });
}

export function enqueueCandidate(
  state: AcquisitionExecutionState,
  candidate: AcquisitionCandidate,
): void {
  const revision = requestedArxivRevision(state.target);
  if (
    revision &&
    (candidate.version.version !== "submitted" ||
      candidate.version.source !== "arxiv_identifier" ||
      candidate.version.identifier !== revision)
  )
    return;

  const key = candidateKey(candidate);
  if (state.attemptedCandidateKeys.has(key)) return;
  const index = state.candidates.findIndex(
    (queued) => candidateKey(queued) === key,
  );
  const existing = state.candidates[index];
  if (existing) {
    const order = compareCandidates(candidate, existing, state.target);
    if (order > 0 || (order === 0 && !candidate.fetchedPdf)) return;
    state.candidates[index] = candidate;
  } else {
    state.candidates.push(candidate);
  }
  state.candidates.sort((left, right) =>
    compareCandidates(left, right, state.target),
  );
}

export function takeCandidate(
  state: AcquisitionExecutionState,
): AcquisitionCandidate | undefined {
  const candidate = state.candidates.shift();
  if (candidate) state.attemptedCandidateKeys.add(candidateKey(candidate));
  return candidate;
}

function locationCandidate(
  location: FullTextLocation,
  url = location.url,
): AcquisitionCandidate {
  const description = {
    locatorValue: location.url,
    url,
    host: location.host,
    version: locationVersion(location),
  };
  return location.kind === "pdf"
    ? {
        ...description,
        candidateKind: "direct_pdf",
        method: "direct_pdf_grobid",
        locatorKind: "direct_pdf_url",
      }
    : {
        ...description,
        candidateKind: "landing_page_discovery",
        locatorKind: "landing_page_url",
      };
}

function pmcIdInUrl(url: string): string | undefined {
  const parsed = URL.parse(url);
  if (
    !parsed ||
    !/(^|\.)(ncbi\.nlm\.nih\.gov|europepmc\.org)$/i.test(parsed.hostname)
  )
    return undefined;
  return parsed.pathname.match(/\bPMC\d+\b/i)?.[0]?.toUpperCase();
}

export function buildInitialCandidates(
  paper: ResolvedPaper,
  target: RetrievalTarget,
  biorxivBaseUrl: string,
  tryPmcHtml: boolean,
): AcquisitionExecutionState {
  const state: AcquisitionExecutionState = {
    attempts: [],
    candidates: [],
    attemptedCandidateKeys: new Set(),
    target,
    paperDoi: paper.doi,
    tryPmcHtml,
  };
  const { locations } = paper.fullTextHints;
  const { requestedDoi } = target;
  const effectiveDoi = requestedDoi ?? paper.doi;
  const preprintDoi = [effectiveDoi, paper.doi].find((doi) =>
    doi?.startsWith("10.1101/"),
  );
  if (preprintDoi) {
    enqueueCandidate(state, {
      candidateKind: "biorxiv_xml",
      method: "biorxiv_xml",
      locatorKind: requestedDoi === preprintDoi ? "doi_input" : "doi_resolved",
      locatorValue: preprintDoi,
      url: `${biorxivBaseUrl.replace(/\/+$/, "")}/details/biorxiv/${preprintDoi}/na/json`,
      version: {
        version: "submitted",
        source: "biorxiv_doi",
        identifier: preprintDoi,
      },
    });
  }

  if (paper.pmcid) {
    enqueueCandidate(state, {
      candidateKind: "pmc_xml",
      method: "pmc_xml",
      locatorKind: "pmcid_metadata",
      locatorValue: paper.pmcid,
      pmcid: paper.pmcid,
      version: unknownVersion,
    });
  }

  for (const location of locations) {
    const pmcid = pmcIdInUrl(location.url);
    if (pmcid) {
      enqueueCandidate(state, {
        candidateKind: "pmc_xml",
        method: "pmc_xml",
        locatorKind: "pmcid_derived_url",
        locatorValue: pmcid,
        pmcid,
        version: locationVersion(location),
      });
    }
    enqueueCandidate(state, locationCandidate(location));
  }

  for (const doi of new Set([requestedDoi, paper.doi])) {
    if (doi && !parseArxivDoi(doi)) {
      enqueueCandidate(state, {
        candidateKind: "pmc_xml",
        method: "pmc_xml",
        locatorKind: doi === requestedDoi ? "doi_input" : "doi_resolved",
        locatorValue: doi,
        doi,
        version: unknownVersion,
      });
    }
  }

  const linkedArxivCopies = locations
    .map(({ url }) => identifyArxivUrl(url))
    .filter((reference) => reference !== undefined);
  const arxiv =
    target.arxiv ?? providerArxivReference(paper) ?? linkedArxivCopies[0];
  if (arxiv) {
    const pinned =
      arxiv.identifier === arxiv.id
        ? linkedArxivCopies.find(
            (reference) =>
              reference.id === arxiv.id && reference.identifier !== arxiv.id,
          )
        : undefined;
    const reference = pinned ?? arxiv;
    enqueueCandidate(state, {
      candidateKind: "direct_pdf",
      method: "direct_pdf_grobid",
      locatorKind: "arxiv_identifier",
      locatorValue: reference.identifier,
      url: "https://arxiv.org/pdf/" + reference.identifier,
      host: "repository",
      version: arxivVersion(reference),
    });
  }

  return state;
}

export function externalPdfCandidate(url: string): AcquisitionCandidate {
  return locationCandidate({ url, kind: "pdf", host: "repository" });
}

/** Retry publisher locations and the DOI through the configured institution. */
export function buildProxyCandidates(
  paper: ResolvedPaper,
  target: RetrievalTarget,
  proxyUrl: string,
): AcquisitionCandidate[] {
  const prefix = proxyUrl.replace(/\/+$/, "");
  const candidates = paper.fullTextHints.locations
    .filter((location) => location.host === "publisher")
    .map((location) => locationCandidate(location, prefix + location.url));
  const doi = target.requestedDoi ?? paper.doi;
  if (doi) {
    candidates.push({
      candidateKind: "landing_page_discovery",
      locatorKind: target.requestedDoi ? "doi_input" : "doi_resolved",
      locatorValue: doi,
      url: prefix + "https://doi.org/" + doi,
      host: "publisher",
      version: unknownVersion,
    });
  }
  return candidates;
}
