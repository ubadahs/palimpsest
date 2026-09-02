/**
 * Production adapters for the canonical six-stage executor.
 *
 * Reuses low-level resolution, acquisition, parsing, classification, and LLM
 * helpers. Does not route through shortlist/screen/extract/classify/curate
 * orchestration or artifact shapes.
 *
 * Provenance: when upstream APIs do not expose exact wire bodies, adapters
 * persist the normalized request / validated response that actually crosses the
 * adapter boundary and label roles accordingly (never fabricate raw HTTP).
 */

import { z } from "zod";

import type { AppConfig } from "../config/app-config.js";
import {
  LLM_CACHE_VERSIONS,
  LLM_PROMPT_VERSIONS,
} from "../config/llm-versions.js";
import type { AnalysisRunConfig } from "../contract/run-types.js";
import {
  canonicalAdjudicateModelOutputSchema,
  hashCanonicalAdjudicateRequest,
} from "../contract/canonical-adjudicate.js";
import {
  evidenceRerankOutputSchema,
  type ArtifactReference,
  type DiscoverCitationOccurrence,
} from "../contract/lean-artifacts.js";
import type { ResolvedPaper } from "../domain/common.js";
import { isReviewPaperType } from "../domain/attribution-signal.js";
import {
  buildNormalizedLLMCallProvenance,
  classifyProviderError,
  resolvePromptCacheControl,
  resolveThinkingConfig,
  type LLMClient,
  type ThinkingConfig,
} from "../integrations/llm-client.js";
import { resolvePaperByDoi } from "../integrations/paper-resolver.js";
import * as openalex from "../integrations/openalex.js";
import {
  CANONICAL_ADJUDICATE_PROMPT_ID,
  CANONICAL_ADJUDICATE_PROMPT_VERSION,
} from "../adjudication/canonical-adjudicate-packet.js";
import type { CanonicalDiscoverAdapters } from "./canonical-discover.js";
import type {
  CanonicalEvidenceAdapters,
  CanonicalEvidenceRerankerInput,
} from "./canonical-evidence.js";
import type {
  CanonicalAdjudicateAdapterInput,
  CanonicalAdjudicateAdapters,
} from "./canonical-adjudicate.js";
import {
  classifyPrepareOccurrenceDeterministically,
  type CanonicalPrepareAdapters,
} from "./canonical-prepare.js";
import {
  canonicalScopeGroundingOutputSchema,
  type CanonicalScopeAdapters,
} from "./canonical-scope.js";
import {
  contentAddressedExternalExecution,
  contentAddressedModelExecution,
  type CanonicalProvenanceStore,
} from "./canonical-provenance-store.js";
import {
  inferFirstAuthorSurname,
  matchReferenceByMetadata,
  materializeLocalPdf,
  materializeParsedPaper,
  PARSED_PAPER_PARSER_VERSION,
} from "../retrieval/parsed-paper.js";
import {
  createDefaultAdapters,
  type FullTextAcquisitionFailureCode,
  type FullTextFetchAdapters,
} from "../retrieval/fulltext-fetch.js";
import type { ParsedPaperCacheOptions } from "../retrieval/parsed-paper.js";

type CitingYearRange = { fromYear?: number; toYear?: number };

function createFullTextAdapters(config: AppConfig): FullTextFetchAdapters {
  return createDefaultAdapters({
    grobidBaseUrl: config.providerBaseUrls.grobid,
    email: config.openAlexEmail,
    institutionalProxyUrl: config.institutionalProxyUrl,
  });
}
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";
import { canonicalSha256 } from "../shared/stable-identity.js";

const CANONICAL_EXTRACTION_PROMPT_ID =
  "canonical-attributed-claim-extraction" as const;
const CANONICAL_EXTRACTION_PROMPT_VERSION = LLM_PROMPT_VERSIONS.extraction;
const CANONICAL_SCOPE_GROUNDING_PROMPT_ID =
  "canonical-scope-grounding" as const;
const CANONICAL_SCOPE_GROUNDING_PROMPT_VERSION = LLM_PROMPT_VERSIONS.grounding;
const CANONICAL_EVIDENCE_RERANK_PROMPT_ID =
  "canonical-evidence-relevance-rerank" as const;
const CANONICAL_EVIDENCE_RERANK_PROMPT_VERSION = "v1" as const;

function mapLlmCallThinking(
  model: string,
  enabled: boolean,
  budgetTokens: number,
): ThinkingConfig | undefined {
  return resolveThinkingConfig({ model, enabled, budgetTokens });
}

function llmRequestProvenanceFields(params: {
  purpose:
    | "attributed-claim-extraction"
    | "seed-grounding"
    | "evidence-rerank"
    | "adjudication";
  model: string;
  prompt: string;
  promptVersion: string;
  exactCacheKeyVersion: string;
  thinking?: ThinkingConfig | undefined;
  forceRefresh?: boolean | undefined;
}) {
  return buildNormalizedLLMCallProvenance({
    purpose: params.purpose,
    model: params.model,
    promptVersion: params.promptVersion,
    ...(params.thinking != null ? { thinking: params.thinking } : {}),
    exactCacheKeyVersion: params.exactCacheKeyVersion,
    ...(params.forceRefresh != null
      ? { forceRefresh: params.forceRefresh }
      : {}),
    promptCacheControl: resolvePromptCacheControl({
      purpose: params.purpose,
      prompt: params.prompt,
    }),
  });
}

type CanonicalAdapterSession = {
  resolvedSeedsByDoi: Map<string, ResolvedPaper>;
  citingPapersByProviderId: Map<string, ResolvedPaper>;
};

export type CanonicalProductionAdapterDeps = {
  config: AppConfig;
  runConfig: AnalysisRunConfig;
  llmClient: LLMClient;
  provenanceStore: CanonicalProvenanceStore;
  session?: CanonicalAdapterSession;
  fullTextAdapters?: FullTextFetchAdapters;
  paperCache?: ParsedPaperCacheOptions;
  forceRefresh?: boolean;
  paperProviders?: {
    resolvePaperByDoi: typeof resolvePaperByDoi;
    getCitingWorks: typeof openalex.getCitingWorks;
    resolveOpenAlexWorkByDoi?: typeof openalex.resolveWorkByDoi;
  };
};

function mapTransportFailure(error: string): {
  reasonCode:
    | "not_found"
    | "unavailable"
    | "timeout"
    | "rate_limited"
    | "transport"
    | "invalid_response"
    | "authentication"
    | "authorization"
    | "billing"
    | "quota";
  reason: string;
} {
  const normalized = error.toLowerCase();
  if (/not found|404|no .*match/i.test(normalized)) {
    return { reasonCode: "not_found", reason: error };
  }
  if (/timeout|timed out/i.test(normalized)) {
    return { reasonCode: "timeout", reason: error };
  }
  if (/rate limit|429|too many requests/i.test(normalized)) {
    return { reasonCode: "rate_limited", reason: error };
  }
  if (/unauthorized|authentication|api key|401/i.test(normalized)) {
    return { reasonCode: "authentication", reason: error };
  }
  if (/forbidden|403|permission/i.test(normalized)) {
    return { reasonCode: "authorization", reason: error };
  }
  if (/credit|billing|quota|payment/i.test(normalized)) {
    return { reasonCode: "billing", reason: error };
  }
  if (/invalid|parse|schema/i.test(normalized)) {
    return { reasonCode: "invalid_response", reason: error };
  }
  return { reasonCode: "transport", reason: error };
}

/**
 * Map typed full-text acquisition failures onto Discover/Scope reason codes.
 * Publisher paywalls are per-paper unavailable outcomes. OpenAlex/Anthropic
 * credential denial stays on mapTransportFailure / mapLlmFailureCode.
 */
export function mapFullTextAcquisitionFailure(failure: {
  failureCode: FullTextAcquisitionFailureCode;
  error: string;
}): {
  reasonCode:
    | "not_found"
    | "unavailable"
    | "timeout"
    | "rate_limited"
    | "transport"
    | "invalid_response"
    | "authentication"
    | "authorization"
    | "billing"
    | "quota";
  reason: string;
} {
  switch (failure.failureCode) {
    case "not_found":
      return { reasonCode: "not_found", reason: failure.error };
    case "paywall":
      return { reasonCode: "unavailable", reason: failure.error };
    case "rate_limited":
      return { reasonCode: "rate_limited", reason: failure.error };
    case "invalid_content":
      return { reasonCode: "invalid_response", reason: failure.error };
    case "authentication":
    case "authorization":
      // Acquisition-layer authz is publisher/proxy access denial for a paper.
      return { reasonCode: "unavailable", reason: failure.error };
    case "transport":
      return { reasonCode: "transport", reason: failure.error };
  }
}

/**
 * Map provider errors to adapter reason codes. Fatal propagation
 * (auth/authorization/billing/quota) is owned by stage `throwIfFatal*`
 * boundaries that inspect `reasonCode` — adapters do not double-flag it.
 */
function mapLlmFailureCode(error: unknown): {
  reasonCode:
    | "authentication"
    | "authorization"
    | "billing"
    | "quota"
    | "timeout"
    | "rate_limited"
    | "transport"
    | "invalid_response";
  reason: string;
} {
  const classified = classifyProviderError(error);
  const reason = classified.message;
  switch (classified.classification) {
    case "authentication":
      return { reasonCode: "authentication", reason };
    case "authorization":
      return { reasonCode: "authorization", reason };
    case "billing_or_quota":
      return {
        reasonCode: /quota/i.test(reason) ? "quota" : "billing",
        reason,
      };
    case "rate_limit":
      return { reasonCode: "rate_limited", reason };
    case "network_or_transport":
      return {
        reasonCode: /timeout/i.test(reason) ? "timeout" : "transport",
        reason,
      };
    default:
      return { reasonCode: "invalid_response", reason };
  }
}

function fullTextAvailability(
  paper: ResolvedPaper,
): "available" | "abstract_only" | "unavailable" | "unknown" {
  const availability = paper.fullTextHints.providerAvailability;
  if (availability === "available") return "available";
  if (availability === "abstract_only") return "abstract_only";
  if (availability === "unavailable") return "unavailable";
  return "unknown";
}

/**
 * Persist each cursor-paginated citing-neighborhood page's normalized
 * request/response as its own provenance artifact, and align each returned
 * paper (in provider order) with the page response artifact that produced
 * it. Never fabricate a single-page shape when the provider paginated.
 */
function persistCitingNeighborhoodPages(input: {
  pages: readonly openalex.OpenAlexCitingWorksPage[];
  store: CanonicalProvenanceStore;
  seedProviderRecordId: string;
}): {
  pageArtifacts: ArtifactReference[];
  responseArtifactByPaperIndex: ArtifactReference[];
} {
  const pageArtifacts: ArtifactReference[] = [];
  const responseArtifactByPaperIndex: ArtifactReference[] = [];
  for (const page of input.pages) {
    const requestArtifact = input.store.persist({
      role: "normalized-citing-neighborhood-page-request",
      body: {
        role: "normalized-citing-neighborhood-page-request",
        seedProviderRecordId: input.seedProviderRecordId,
        pageIndex: page.pageIndex,
        requestUrl: page.requestUrl,
        cursor: page.cursor,
        perPage: page.perPage,
      },
      canonicalStage: "discover",
    });
    const responseArtifact = input.store.persist({
      role: "normalized-citing-neighborhood-page-response",
      body: {
        role: "normalized-citing-neighborhood-page-response",
        pageIndex: page.pageIndex,
        returnedCount: page.returnedCount,
        nextCursor: page.nextCursor,
        responseTotalCount: page.responseTotalCount,
      },
      canonicalStage: "discover",
    });
    pageArtifacts.push(requestArtifact, responseArtifact);
    for (let i = 0; i < page.returnedCount; i++) {
      responseArtifactByPaperIndex.push(responseArtifact);
    }
  }
  return { pageArtifacts, responseArtifactByPaperIndex };
}

function paperToCanonical(paper: ResolvedPaper) {
  return {
    paperId: paper.id,
    providerRecordId: paper.id,
    title: paper.title,
    ...(paper.doi ? { doi: paper.doi } : {}),
    authors: paper.authors,
    ...(paper.publicationYear != null
      ? { publicationYear: paper.publicationYear }
      : {}),
    ...(paper.paperType ? { paperType: paper.paperType } : {}),
    ...(paper.referencedWorksCount != null
      ? { referencedWorksCount: paper.referencedWorksCount }
      : {}),
  };
}

export function openAlexNeighborhoodSeedId(input: {
  provider: string;
  providerRecordId: string;
}): string | undefined {
  if (input.provider !== "openalex") return undefined;
  return /^(?:https:\/\/openalex\.org\/)?W\d+$/i.test(input.providerRecordId)
    ? input.providerRecordId
    : undefined;
}

/**
 * Keep one harvested mention per citation group whose exact target refs include
 * the seed bibliography id. Sibling refs stay on bundleRefIds for context only.
 */
export function selectSeedReferenceMentions<
  T extends {
    refId?: string | undefined;
    targetRefIds?: readonly string[] | undefined;
    bundleRefIds: readonly string[];
  },
>(mentions: readonly T[], seedRefId: string): T[] {
  return mentions.filter((mention) => {
    const targetRefIds =
      mention.targetRefIds ?? (mention.refId != null ? [mention.refId] : []);
    return targetRefIds.includes(seedRefId);
  });
}

function createCanonicalAdapterSession(): CanonicalAdapterSession {
  return {
    resolvedSeedsByDoi: new Map(),
    citingPapersByProviderId: new Map(),
  };
}

export function buildCanonicalDiscoverAdapters(
  deps: CanonicalProductionAdapterDeps,
): CanonicalDiscoverAdapters {
  const session = deps.session ?? createCanonicalAdapterSession();
  const store = deps.provenanceStore;
  const fullText = deps.fullTextAdapters ?? createFullTextAdapters(deps.config);
  const paperProviders = deps.paperProviders ?? {
    resolvePaperByDoi,
    getCitingWorks: openalex.getCitingWorks,
    resolveOpenAlexWorkByDoi: openalex.resolveWorkByDoi,
  };
  const resolveOpenAlexWorkByDoi =
    paperProviders.resolveOpenAlexWorkByDoi ?? openalex.resolveWorkByDoi;
  const yearRange: CitingYearRange | undefined =
    deps.runConfig.discover.fromYear != null ||
    deps.runConfig.discover.toYear != null
      ? {
          ...(deps.runConfig.discover.fromYear != null
            ? { fromYear: deps.runConfig.discover.fromYear }
            : {}),
          ...(deps.runConfig.discover.toYear != null
            ? { toYear: deps.runConfig.discover.toYear }
            : {}),
        }
      : undefined;

  return {
    resolveSeed: async ({ doi }) => {
      const requestBody = {
        role: "normalized-doi-resolution-request",
        doi,
        providers: ["openalex", "semantic-scholar"],
      };
      const result = await paperProviders.resolvePaperByDoi(doi, {
        openAlexBaseUrl: deps.config.providerBaseUrls.openAlex,
        semanticScholarBaseUrl: deps.config.providerBaseUrls.semanticScholar,
        openAlexEmail: deps.config.openAlexEmail,
        semanticScholarApiKey: deps.config.semanticScholarApiKey,
      });
      if (!result.ok) {
        const mapped = mapTransportFailure(result.error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: contentAddressedExternalExecution({
            provider: "paper-resolver",
            requestBody,
            responseBody: {
              role: "normalized-doi-resolution-failure",
              error: result.error,
            },
            store,
            requestRole: "normalized-doi-resolution-request",
            responseRole: "normalized-doi-resolution-failure",
            canonicalStage: "discover",
          }),
        };
      }
      session.resolvedSeedsByDoi.set(doi.toLowerCase(), result.data);
      return {
        status: "resolved" as const,
        paper: paperToCanonical(result.data),
        execution: contentAddressedExternalExecution({
          provider: result.data.source,
          requestBody,
          responseBody: {
            role: "normalized-resolved-paper",
            paper: result.data,
          },
          store,
          requestRole: "normalized-doi-resolution-request",
          responseRole: "normalized-resolved-paper",
          canonicalStage: "discover",
        }),
      };
    },

    retrieveCitingNeighborhood: async ({ seed, boundary }) => {
      let openAlexId =
        boundary.provider === "openalex"
          ? openAlexNeighborhoodSeedId({
              provider: seed.execution.provider,
              providerRecordId: seed.paper.providerRecordId,
            })
          : undefined;
      let openAlexDoiLookup:
        | {
            attempted: true;
            requestArtifact: ArtifactReference;
            responseArtifact: ArtifactReference;
          }
        | { attempted: false } = { attempted: false };
      let openAlexDoiLookupError: string | undefined;

      // When DOI resolution fell back to Semantic Scholar but neighborhood
      // retrieval is OpenAlex, re-resolve the DOI against OpenAlex before
      // declaring the neighborhood unavailable. Never fabricate empty citers.
      if (
        !openAlexId &&
        boundary.provider === "openalex" &&
        seed.paper.doi != null &&
        seed.paper.doi.trim().length > 0
      ) {
        const lookup = await resolveOpenAlexWorkByDoi(
          seed.paper.doi,
          deps.config.providerBaseUrls.openAlex,
          deps.config.openAlexEmail,
        );
        const lookupExecution = contentAddressedExternalExecution({
          provider: "openalex",
          requestBody: {
            role: "normalized-openalex-doi-resolution-request",
            doi: seed.paper.doi,
          },
          responseBody: lookup.ok
            ? {
                role: "normalized-openalex-doi-resolution-response",
                status: "resolved",
                paper: lookup.data,
              }
            : {
                role: "normalized-openalex-doi-resolution-response",
                status: "failed",
                error: lookup.error,
              },
          store,
          requestRole: "normalized-openalex-doi-resolution-request",
          responseRole: "normalized-openalex-doi-resolution-response",
          canonicalStage: "discover",
        });
        openAlexDoiLookup = {
          attempted: true,
          requestArtifact: lookupExecution.requestArtifact,
          responseArtifact: lookupExecution.responseArtifact,
        };
        if (lookup.ok) {
          openAlexId = lookup.data.id;
        } else {
          openAlexDoiLookupError = lookup.error;
        }
      }

      const requestBody = {
        role: "normalized-citing-neighborhood-request",
        provider: boundary.provider,
        query: boundary.query,
        seedProvider: seed.execution.provider,
        seedProviderRecordId: seed.paper.providerRecordId,
        seedDoi: seed.paper.doi,
        openAlexSeedId: openAlexId,
        openAlexDoiLookup,
        limit: boundary.limit,
        yearRange: boundary.yearRange,
      };
      if (!openAlexId) {
        const reason =
          boundary.provider !== "openalex"
            ? `No production citing-neighborhood adapter is configured for provider ${boundary.provider}.`
            : openAlexDoiLookup.attempted && openAlexDoiLookupError
              ? `OpenAlex DOI re-resolution failed for seed ${seed.paper.doi ?? "(missing)"}: ${openAlexDoiLookupError}.`
              : "OpenAlex citing-neighborhood retrieval requires an OpenAlex seed identity; DOI resolution returned a different provider and no seed DOI was available for OpenAlex re-resolution.";
        return {
          status: "failed" as const,
          reasonCode: "unavailable" as const,
          reason,
          execution: contentAddressedExternalExecution({
            provider: boundary.provider,
            requestBody,
            responseBody: {
              role: "normalized-citing-neighborhood-failure",
              error: reason,
            },
            store,
            requestRole: "normalized-citing-neighborhood-request",
            responseRole: "normalized-citing-neighborhood-failure",
            canonicalStage: "discover",
          }),
        };
      }
      const result = await paperProviders.getCitingWorks(
        openAlexId,
        deps.config.providerBaseUrls.openAlex,
        boundary.limit,
        deps.config.openAlexEmail,
        yearRange,
      );
      if (!result.ok) {
        const mapped = mapTransportFailure(result.error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: contentAddressedExternalExecution({
            provider: boundary.provider,
            requestBody,
            responseBody: {
              role: "normalized-citing-neighborhood-failure",
              error: result.error,
            },
            store,
            requestRole: "normalized-citing-neighborhood-request",
            responseRole: "normalized-citing-neighborhood-failure",
            canonicalStage: "discover",
          }),
        };
      }

      const { pageArtifacts, responseArtifactByPaperIndex } =
        persistCitingNeighborhoodPages({
          pages: result.data.pages,
          store,
          seedProviderRecordId: openAlexId,
        });

      const papers = result.data.papers.map((paper, paperIndex) => {
        session.citingPapersByProviderId.set(paper.id, paper);
        const pageResponseArtifact = responseArtifactByPaperIndex[paperIndex];
        const provenanceArtifacts = [
          store.persist({
            role: "normalized-citing-paper",
            body: { role: "normalized-citing-paper", paper },
            canonicalStage: "discover",
          }),
          ...(pageResponseArtifact ? [pageResponseArtifact] : []),
        ];
        return {
          ...paperToCanonical(paper),
          fullTextAvailability: fullTextAvailability(paper),
          provenanceArtifacts,
        };
      });

      return {
        status: "completed" as const,
        providerReportedTotal: result.data.providerReportedTotal,
        coverage: result.data.coverage,
        papers,
        pageArtifacts,
        execution: contentAddressedExternalExecution({
          provider: boundary.provider,
          requestBody,
          responseBody: {
            role: "normalized-citing-neighborhood-response",
            returnedCount: papers.length,
            paperIds: papers.map((paper) => paper.providerRecordId),
            providerReportedTotal: result.data.providerReportedTotal,
            coverage: result.data.coverage,
            pageCount: result.data.pages.length,
          },
          store,
          requestRole: "normalized-citing-neighborhood-request",
          responseRole: "normalized-citing-neighborhood-response",
          canonicalStage: "discover",
        }),
      };
    },

    harvestMentions: async ({ seed, citingPaper }) => {
      const seedPaper =
        session.resolvedSeedsByDoi.get(seed.paper.doi?.toLowerCase() ?? "") ??
        [...session.resolvedSeedsByDoi.values()].find(
          (paper) => paper.id === seed.paper.paperId,
        );
      const citing = session.citingPapersByProviderId.get(
        citingPaper.providerRecordId,
      );
      if (!seedPaper || !citing) {
        const missing = !seedPaper ? "seed" : "citing";
        const provenanceArtifacts = [
          store.persist({
            role: "mention-harvest-session-miss",
            body: { missing, citingPaperId: citingPaper.providerRecordId },
            canonicalStage: "discover",
          }),
        ];
        return {
          materialization: {
            status: "failed" as const,
            reasonCode: "unavailable" as const,
            reason: `Adapter session missing ${missing} ResolvedPaper for harvest.`,
            provenanceArtifacts,
          },
          harvest: {
            status: "not_attempted" as const,
            reason: "Harvest skipped because materialization could not start.",
            provenanceArtifacts,
          },
          mentions: [],
        };
      }

      const materializeResult = await materializeParsedPaper(
        citing,
        deps.config.providerBaseUrls.bioRxiv,
        fullText,
        deps.paperCache,
      );

      if (!materializeResult.ok) {
        const mapped = mapFullTextAcquisitionFailure({
          failureCode: materializeResult.failureCode,
          error: materializeResult.error,
        });
        const provenanceArtifacts = [
          store.persist({
            role: "citing-paper-materialization-failure",
            body: {
              citingPaperId: citing.id,
              error: materializeResult.error,
              failureCode: materializeResult.failureCode,
              acquisition: materializeResult.acquisition,
            },
            canonicalStage: "discover",
          }),
        ];
        return {
          materialization: {
            status:
              mapped.reasonCode === "not_found" ||
              mapped.reasonCode === "unavailable"
                ? ("unavailable" as const)
                : ("failed" as const),
            reasonCode: mapped.reasonCode,
            reason: mapped.reason,
            provenanceArtifacts,
          },
          harvest: {
            status: "not_attempted" as const,
            reason: "Harvest not attempted after materialization failure.",
            provenanceArtifacts,
          },
          mentions: [],
        };
      }

      const materializationArtifacts = [
        store.persist({
          role: "citing-paper-materialization",
          body: {
            citingPaperId: citing.id,
            acquisition: materializeResult.data.acquisition,
            parserKind: materializeResult.data.parsedDocument.parserKind,
            parserVersion: materializeResult.data.parsedDocument.parserVersion,
            blockCount: materializeResult.data.parsedDocument.blocks.length,
            mentionCount: materializeResult.data.parsedDocument.mentions.length,
          },
          canonicalStage: "discover",
        }),
      ];

      const refs = materializeResult.data.parsedDocument.references;
      const firstAuthorSurname = inferFirstAuthorSurname(seedPaper.authors[0]);
      const seedMatch = matchReferenceByMetadata(refs, {
        title: seedPaper.title,
        ...(seedPaper.doi ? { doi: seedPaper.doi } : {}),
        ...(seedPaper.publicationYear != null
          ? { publicationYear: seedPaper.publicationYear }
          : {}),
        ...(firstAuthorSurname ? { firstAuthorSurname } : {}),
      });
      if (!seedMatch) {
        const harvestArtifacts = [
          store.persist({
            role: "mention-harvest-no-reference",
            body: {
              citingPaperId: citing.id,
              referenceCount: refs.length,
              matchMethod: null,
            },
            canonicalStage: "discover",
          }),
        ];
        return {
          materialization: {
            status: "succeeded" as const,
            reason: "Citing paper text materialized.",
            provenanceArtifacts: materializationArtifacts,
          },
          harvest: {
            status: "no_mentions" as const,
            reason: "Seed paper not found in citing bibliography.",
            provenanceArtifacts: harvestArtifacts,
          },
          mentions: [],
        };
      }
      const seedRef = seedMatch.reference;

      const rawMentions = selectSeedReferenceMentions(
        materializeResult.data.parsedDocument.mentions,
        seedRef.refId,
      );
      if (rawMentions.length === 0) {
        const harvestArtifacts = [
          store.persist({
            role: "mention-harvest-empty",
            body: {
              citingPaperId: citing.id,
              seedRefId: seedRef.refId,
              matchMethod: seedMatch.method,
            },
            canonicalStage: "discover",
          }),
        ];
        return {
          materialization: {
            status: "succeeded" as const,
            reason: "Citing paper text materialized.",
            provenanceArtifacts: materializationArtifacts,
          },
          harvest: {
            status: "no_mentions" as const,
            reason:
              "Seed bibliography entry found but no in-text citation mentions.",
            provenanceArtifacts: harvestArtifacts,
          },
          mentions: [],
        };
      }

      const seedRefLabel = buildAuthorYearLabel(seedRef);
      const harvestArtifacts = [
        store.persist({
          role: "mention-harvest",
          body: {
            citingPaperId: citing.id,
            seedRefId: seedRef.refId,
            matchMethod: seedMatch.method,
            mentionCount: rawMentions.length,
          },
          canonicalStage: "discover",
        }),
      ];

      return {
        materialization: {
          status: "succeeded" as const,
          reason: "Citing paper text materialized.",
          provenanceArtifacts: materializationArtifacts,
        },
        harvest: {
          status: "succeeded" as const,
          reason: `Harvested ${String(rawMentions.length)} citation occurrence(s).`,
          provenanceArtifacts: harvestArtifacts,
        },
        mentions: rawMentions.map((mention) => ({
          mentionIndex: mention.mentionIndex,
          ...(mention.refId ? { refId: mention.refId } : {}),
          targetRefIds: mention.targetRefIds,
          // Drop malformed parser offsets rather than failing Discover.
          ...(mention.charOffsetStart != null &&
          mention.charOffsetEnd != null &&
          mention.charOffsetEnd > mention.charOffsetStart
            ? {
                charOffsetStart: mention.charOffsetStart,
                charOffsetEnd: mention.charOffsetEnd,
              }
            : {}),
          ...(mention.sourceLocator
            ? { sourceLocator: mention.sourceLocator }
            : {}),
          locationQuality: mention.locationQuality,
          citationGroupOrdinal: mention.citationGroupOrdinal,
          citationMarker: mention.citationMarker,
          rawContext: mention.rawContext,
          ...(mention.sectionTitle
            ? { sectionTitle: mention.sectionTitle }
            : {}),
          ...(seedRefLabel ? { seedRefLabel } : {}),
          isBundledCitation: mention.isBundledCitation,
          bundleSize: mention.bundleSize,
          bundleRefIds: mention.bundleRefIds,
          bundlePattern: mention.bundlePattern,
          sourceType: mention.sourceType,
          parser: mention.parser,
          parserVersion: materializeResult.data.parsedDocument.parserVersion,
          provenanceArtifacts: [
            store.persist({
              role: "citation-occurrence-source",
              body: {
                citingPaperId: citing.id,
                mentionIndex: mention.mentionIndex,
                targetRefIds: mention.targetRefIds,
                citationGroupOrdinal: mention.citationGroupOrdinal,
                sourceLocator: mention.sourceLocator,
                citationMarker: mention.citationMarker,
                rawContext: mention.rawContext,
              },
              canonicalStage: "discover",
            }),
          ],
        })),
      };
    },

    extractAttributedClaims: async ({ seed, citingPaper, mention }) => {
      const prompt = buildSingleMentionExtractionPrompt({
        seedTitle: seed.paper.title,
        seedDoi: seed.paper.doi,
        citingTitle: citingPaper.title,
        mention,
      });
      const model = deps.runConfig.discover.extractionModel;
      const thinking = mapLlmCallThinking(
        model,
        deps.runConfig.discover.extractionThinking,
        8000,
      );
      const requestBody = {
        mentionId: mention.mentionId,
        llm: llmRequestProvenanceFields({
          purpose: "attributed-claim-extraction",
          model,
          prompt,
          promptVersion: CANONICAL_EXTRACTION_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.extraction,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      try {
        const result = await deps.llmClient.generateText({
          purpose: "attributed-claim-extraction",
          model,
          prompt,
          context: { stageKey: "discover" },
          ...(thinking != null ? { thinking } : {}),
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.extraction },
        });
        const parsed = parseCanonicalAttributedClaimExtractionResponse(
          result.text,
        );
        const execution = contentAddressedModelExecution({
          provider: "anthropic",
          model: result.record.model,
          promptId: CANONICAL_EXTRACTION_PROMPT_ID,
          promptVersion: CANONICAL_EXTRACTION_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody: {
            role: "normalized-attributed-claim-extraction-response",
            text: result.text,
            parsed: parsed.ok ? parsed.data : { parseError: parsed.error },
          },
          store,
          requestRole: "normalized-attributed-claim-extraction-request",
          responseRole: "normalized-attributed-claim-extraction-response",
          canonicalStage: "discover",
        });
        if (!parsed.ok) {
          return {
            status: "failed" as const,
            reasonCode: "invalid_response" as const,
            reason: parsed.error,
            execution,
          };
        }
        return {
          status: "completed" as const,
          reason:
            parsed.data.reason ??
            (parsed.data.claims.length === 0
              ? "Mention contains no in-scope empirical attribution."
              : `Extracted ${String(parsed.data.claims.length)} attributed claim(s).`),
          claims: parsed.data.claims.map((claim) => ({
            text: claim.text.trim(),
            ...(claim.supportSpanText
              ? { supportSpanText: claim.supportSpanText }
              : {}),
            ...(claim.confidence ? { confidence: claim.confidence } : {}),
          })),
          execution,
        };
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        const execution = contentAddressedModelExecution({
          provider: "anthropic",
          model,
          promptId: CANONICAL_EXTRACTION_PROMPT_ID,
          promptVersion: CANONICAL_EXTRACTION_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody: {
            role: "normalized-attributed-claim-extraction-failure",
            error: mapped.reason,
          },
          store,
          requestRole: "normalized-attributed-claim-extraction-request",
          responseRole: "normalized-attributed-claim-extraction-failure",
          canonicalStage: "discover",
        });
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution,
        };
      }
    },
  };
}

export function buildCanonicalScopeAdapters(
  deps: CanonicalProductionAdapterDeps,
): CanonicalScopeAdapters {
  const session = deps.session ?? createCanonicalAdapterSession();
  const store = deps.provenanceStore;
  const fullText = deps.fullTextAdapters ?? createFullTextAdapters(deps.config);
  const seedPdfPath = deps.runConfig.scope.seedPdfPath;

  return {
    materializeSeed: async ({ seed }) => {
      const seedResolution = seed.resolution;
      if (seedResolution.status !== "resolved") {
        const sourceArtifacts = [
          store.persist({
            role: "seed-materialization-unresolved",
            body: { seedId: seed.seedId, doi: seed.doi },
            canonicalStage: "scope",
          }),
        ];
        return {
          seedId: seed.seedId,
          status: "seed_text_unavailable" as const,
          reasonCode: "unavailable" as const,
          reason: "Seed DOI did not resolve; cannot materialize seed text.",
          provenanceArtifacts: sourceArtifacts,
          execution: {
            kind: "deterministic" as const,
            implementation: "canonical-scope-seed-materialize-v1",
            sourceArtifacts,
          },
        };
      }

      let materializeResult;
      const requestBody = {
        role: "normalized-seed-materialization-request",
        seedId: seed.seedId,
        doi: seed.doi,
        seedPdfPath: seedPdfPath ?? null,
      };

      if (seedPdfPath) {
        materializeResult = await materializeLocalPdf(seedPdfPath, fullText);
      } else {
        let resolved =
          session.resolvedSeedsByDoi.get(seed.doi.toLowerCase()) ??
          [...session.resolvedSeedsByDoi.values()].find(
            (paper) => paper.id === seedResolution.paper.paperId,
          );
        if (!resolved) {
          const resolution = await resolvePaperByDoi(seed.doi, {
            openAlexBaseUrl: deps.config.providerBaseUrls.openAlex,
            semanticScholarBaseUrl:
              deps.config.providerBaseUrls.semanticScholar,
            openAlexEmail: deps.config.openAlexEmail,
            semanticScholarApiKey: deps.config.semanticScholarApiKey,
          });
          if (!resolution.ok) {
            const sourceArtifacts = [
              store.persist({
                role: "seed-materialization-reresolve-failure",
                body: { doi: seed.doi, error: resolution.error },
                canonicalStage: "scope",
              }),
            ];
            return {
              seedId: seed.seedId,
              status: "acquisition_failed" as const,
              reasonCode: "unavailable" as const,
              reason: resolution.error,
              provenanceArtifacts: sourceArtifacts,
              execution: {
                kind: "external" as const,
                ...contentAddressedExternalExecution({
                  provider: "paper-resolver",
                  requestBody,
                  responseBody: { error: resolution.error },
                  store,
                  requestRole: "normalized-seed-materialization-request",
                  responseRole: "seed-materialization-reresolve-failure",
                  canonicalStage: "scope",
                }),
              },
            };
          }
          resolved = resolution.data;
          session.resolvedSeedsByDoi.set(seed.doi.toLowerCase(), resolved);
        }
        materializeResult = await materializeParsedPaper(
          resolved,
          deps.config.providerBaseUrls.bioRxiv,
          fullText,
          deps.paperCache,
        );
      }

      if (!materializeResult.ok) {
        const mapped = mapFullTextAcquisitionFailure({
          failureCode: materializeResult.failureCode,
          error: materializeResult.error,
        });
        const provenanceArtifacts = [
          store.persist({
            role: "seed-materialization-failure",
            body: {
              seedId: seed.seedId,
              error: materializeResult.error,
              failureCode: materializeResult.failureCode,
              acquisition: materializeResult.acquisition,
            },
            canonicalStage: "scope",
          }),
        ];
        return {
          seedId: seed.seedId,
          status: "acquisition_failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          provenanceArtifacts,
          execution: {
            kind: "external" as const,
            ...contentAddressedExternalExecution({
              provider: seedPdfPath
                ? "local-pdf-grobid"
                : "fulltext-acquisition",
              requestBody,
              responseBody: {
                error: materializeResult.error,
                failureCode: materializeResult.failureCode,
              },
              store,
              requestRole: "normalized-seed-materialization-request",
              responseRole: "seed-materialization-failure",
              canonicalStage: "scope",
            }),
          },
        };
      }

      const doc = materializeResult.data.parsedDocument;
      if (doc.blocks.length === 0) {
        const sourceArtifacts = [
          store.persist({
            role: "seed-materialization-empty",
            body: { seedId: seed.seedId },
            canonicalStage: "scope",
          }),
        ];
        return {
          seedId: seed.seedId,
          status: "seed_text_unavailable" as const,
          reasonCode: "unavailable" as const,
          reason: "Parsed seed document contained no text blocks.",
          provenanceArtifacts: sourceArtifacts,
          execution: {
            kind: "deterministic" as const,
            implementation: "canonical-scope-seed-materialize-v1",
            sourceArtifacts,
          },
        };
      }

      const seedTextArtifact = store.persist({
        role: "immutable-seed-text",
        body: {
          seedId: seed.seedId,
          blocks: doc.blocks,
          parserKind: doc.parserKind,
          parserVersion: doc.parserVersion,
        },
        canonicalStage: "scope",
      });
      const sourceArtifacts = [
        store.persist({
          role: "seed-materialization-source",
          body: {
            acquisition: materializeResult.data.acquisition,
            format: materializeResult.data.fullText.format,
          },
          canonicalStage: "scope",
        }),
        seedTextArtifact,
      ];

      return {
        seedId: seed.seedId,
        status: "materialized" as const,
        reason: seedPdfPath
          ? "Seed text materialized from local PDF via GROBID."
          : "Seed text materialized from open-access acquisition.",
        seedTextArtifact,
        sourceArtifacts,
        parser: {
          kind: doc.parserKind,
          version: doc.parserVersion || PARSED_PAPER_PARSER_VERSION,
        },
        blocks: doc.blocks.map((block) => ({
          blockId: block.blockId,
          text: block.text,
          ...(block.sectionTitle ? { sectionTitle: block.sectionTitle } : {}),
          blockKind: block.blockKind,
          charOffsetStart: block.charOffsetStart,
          charOffsetEnd: block.charOffsetEnd,
        })),
        execution: {
          kind: "external" as const,
          ...contentAddressedExternalExecution({
            provider: seedPdfPath ? "local-pdf-grobid" : "fulltext-acquisition",
            requestBody,
            responseBody: {
              role: "normalized-seed-materialization-response",
              blockCount: doc.blocks.length,
              parserKind: doc.parserKind,
            },
            store,
            requestRole: "normalized-seed-materialization-request",
            responseRole: "normalized-seed-materialization-response",
            canonicalStage: "scope",
          }),
        },
      };
    },

    groundFamily: async ({ seed, family, seedText }) => {
      const promptParts = buildScopeGroundingPrompt({
        trackedClaim: family.trackedClaim,
        seedTitle:
          seed.resolution.status === "resolved"
            ? seed.resolution.paper.title
            : seed.doi,
        blocks: seedText.blocks,
      });
      const prompt = `${promptParts.prefix}${promptParts.suffix}`;
      const model = deps.runConfig.scope.groundingModel;
      const thinking = mapLlmCallThinking(
        model,
        deps.runConfig.scope.groundingThinking,
        10_000,
      );
      const requestBody = {
        familyId: family.familyId,
        llm: llmRequestProvenanceFields({
          purpose: "seed-grounding",
          model,
          prompt,
          promptVersion: CANONICAL_SCOPE_GROUNDING_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.grounding,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      try {
        const result = await deps.llmClient.generateText({
          purpose: "seed-grounding",
          model,
          promptPrefix: promptParts.prefix,
          promptSuffix: promptParts.suffix,
          context: { stageKey: "scope" },
          ...(thinking != null ? { thinking } : {}),
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.grounding },
        });
        const parsed = parseScopeGroundingResponse(result.text);
        const execution = contentAddressedModelExecution({
          provider: "anthropic",
          model: result.record.model,
          promptId: CANONICAL_SCOPE_GROUNDING_PROMPT_ID,
          promptVersion: CANONICAL_SCOPE_GROUNDING_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody: {
            role: "normalized-scope-grounding-response",
            text: result.text,
            parsed: parsed.ok ? parsed.data : { parseError: parsed.error },
          },
          store,
          requestRole: "normalized-scope-grounding-request",
          responseRole: "normalized-scope-grounding-response",
          canonicalStage: "scope",
        });
        if (!parsed.ok) {
          return {
            status: "failed" as const,
            reasonCode: "invalid_response" as const,
            reason: parsed.error,
            execution,
          };
        }
        return {
          status: "completed" as const,
          rawOutput: parsed.data,
          execution,
        };
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        const execution = contentAddressedModelExecution({
          provider: "anthropic",
          model,
          promptId: CANONICAL_SCOPE_GROUNDING_PROMPT_ID,
          promptVersion: CANONICAL_SCOPE_GROUNDING_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody: {
            role: "normalized-scope-grounding-failure",
            error: mapped.reason,
          },
          store,
          requestRole: "normalized-scope-grounding-request",
          responseRole: "normalized-scope-grounding-failure",
          canonicalStage: "scope",
        });
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution,
        };
      }
    },
  };
}

export function buildCanonicalPrepareAdapters(): CanonicalPrepareAdapters {
  return {
    classifyCitation: (input) =>
      Promise.resolve(
        classifyPrepareOccurrenceDeterministically(input.citationOccurrence, {
          isReviewMediated: isReviewPaperType(
            input.citingPaper.paper.paperType,
          ),
          occurrenceSourceClaimRecords: input.occurrenceSourceClaimRecords,
        }),
      ),
  };
}

function buildCanonicalEvidenceAdapters(
  deps: CanonicalProductionAdapterDeps,
): CanonicalEvidenceAdapters {
  if (!deps.runConfig.evidence.rerankEnabled) {
    return {};
  }
  const store = deps.provenanceStore;
  const model = deps.runConfig.evidence.rerankModel;

  return {
    rerank: async (input: CanonicalEvidenceRerankerInput) => {
      const prompt = buildRelevanceRerankPrompt(input);
      const requestBody = {
        familyId: input.familyId,
        bm25RunId: input.bm25RunId,
        topN: input.topN,
        candidateChunkIds: input.candidates.map((c) => c.chunkId),
        llm: llmRequestProvenanceFields({
          purpose: "evidence-rerank",
          model,
          prompt,
          promptVersion: CANONICAL_EVIDENCE_RERANK_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.rerank,
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      try {
        const result = await deps.llmClient.generateText({
          purpose: "evidence-rerank",
          model,
          prompt,
          context: { stageKey: "evidence" },
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.rerank },
        });
        const parsed = parseRerankResponse(result.text);
        const execution = contentAddressedModelExecution({
          provider: "anthropic",
          model: result.record.model,
          promptId: CANONICAL_EVIDENCE_RERANK_PROMPT_ID,
          promptVersion: CANONICAL_EVIDENCE_RERANK_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody: {
            role: "normalized-evidence-rerank-response",
            text: result.text,
            parsed: parsed.ok ? parsed.data : { parseError: parsed.error },
          },
          store,
          requestRole: "normalized-evidence-rerank-request",
          responseRole: "normalized-evidence-rerank-response",
          canonicalStage: "evidence",
        });
        if (!parsed.ok) {
          return {
            status: "failed" as const,
            reasonCode: "invalid_response" as const,
            reason: parsed.error,
            execution,
          };
        }
        return {
          status: "completed" as const,
          rawOutput: parsed.data,
          execution,
        };
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        const execution = contentAddressedModelExecution({
          provider: "anthropic",
          model,
          promptId: CANONICAL_EVIDENCE_RERANK_PROMPT_ID,
          promptVersion: CANONICAL_EVIDENCE_RERANK_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody: {
            role: "normalized-evidence-rerank-failure",
            error: mapped.reason,
          },
          store,
          requestRole: "normalized-evidence-rerank-request",
          responseRole: "normalized-evidence-rerank-failure",
          canonicalStage: "evidence",
        });
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution,
        };
      }
    },
  };
}

export function buildCanonicalAdjudicateAdapters(
  deps: CanonicalProductionAdapterDeps,
): CanonicalAdjudicateAdapters {
  const store = deps.provenanceStore;
  const model = deps.runConfig.adjudicate.model;

  return {
    adjudicate: async (input: CanonicalAdjudicateAdapterInput) => {
      const promptText = input.promptText;
      const expectedRequestHash = hashCanonicalAdjudicateRequest(input);
      const thinking = mapLlmCallThinking(
        model,
        deps.runConfig.adjudicate.thinking,
        12_000,
      );
      const requestBody = {
        purpose: input.purpose,
        recordId: input.recordId,
        promptId: input.promptId,
        promptVersion: input.promptVersion,
        promptText,
        packet: input.packet,
        llm: llmRequestProvenanceFields({
          purpose: "adjudication",
          model,
          prompt: promptText,
          promptVersion: input.promptVersion,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.adjudication,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      try {
        const result = await deps.llmClient.generateText({
          purpose: "adjudication",
          model,
          prompt: promptText,
          context: { stageKey: "adjudicate" },
          ...(thinking != null ? { thinking } : {}),
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.adjudication },
        });
        const parsed = parseAdjudicateResponse(result.text);
        const execution = contentAddressedModelExecution({
          provider: "anthropic",
          model: result.record.model,
          promptId: CANONICAL_ADJUDICATE_PROMPT_ID,
          promptVersion: CANONICAL_ADJUDICATE_PROMPT_VERSION,
          promptText,
          requestBody,
          responseBody: {
            role: "normalized-canonical-adjudicate-response",
            text: result.text,
            parsed: parsed.ok ? parsed.data : { parseError: parsed.error },
          },
          store,
          requestRole: "normalized-canonical-adjudicate-request",
          responseRole: "normalized-canonical-adjudicate-response",
          requestHash: expectedRequestHash,
          canonicalStage: "adjudicate",
        });
        // Ensure prompt content hash matches the adapter input prompt text.
        if (
          execution.promptContentHash !== canonicalSha256(promptText) ||
          execution.promptId !== input.promptId ||
          execution.promptVersion !== input.promptVersion
        ) {
          return {
            status: "failed" as const,
            reasonCode: "invalid_response" as const,
            reason: "Adjudicate adapter execution provenance mismatch.",
            execution,
          };
        }
        if (!parsed.ok) {
          return {
            status: "completed" as const,
            rawOutput: { parseError: parsed.error, text: result.text },
            execution,
          };
        }
        return {
          status: "completed" as const,
          rawOutput: parsed.data,
          execution,
        };
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        const execution = contentAddressedModelExecution({
          provider: "anthropic",
          model,
          promptId: CANONICAL_ADJUDICATE_PROMPT_ID,
          promptVersion: CANONICAL_ADJUDICATE_PROMPT_VERSION,
          promptText,
          requestBody,
          responseBody: {
            role: "normalized-canonical-adjudicate-failure",
            error: mapped.reason,
          },
          store,
          requestRole: "normalized-canonical-adjudicate-request",
          responseRole: "normalized-canonical-adjudicate-failure",
          requestHash: expectedRequestHash,
          canonicalStage: "adjudicate",
        });
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution,
        };
      }
    },
  };
}

export type CanonicalProductionAdapters = {
  session: CanonicalAdapterSession;
  discover: CanonicalDiscoverAdapters;
  scope: CanonicalScopeAdapters;
  prepare: CanonicalPrepareAdapters;
  evidence: CanonicalEvidenceAdapters;
  adjudicate: CanonicalAdjudicateAdapters;
};

export function buildCanonicalProductionAdapters(
  deps: CanonicalProductionAdapterDeps,
): CanonicalProductionAdapters {
  const session = deps.session ?? createCanonicalAdapterSession();
  const withSession = { ...deps, session };
  return {
    session,
    discover: buildCanonicalDiscoverAdapters(withSession),
    scope: buildCanonicalScopeAdapters(withSession),
    prepare: buildCanonicalPrepareAdapters(),
    evidence: buildCanonicalEvidenceAdapters(withSession),
    adjudicate: buildCanonicalAdjudicateAdapters(withSession),
  };
}

// ---------------------------------------------------------------------------
// Prompt / parse helpers
// ---------------------------------------------------------------------------

function buildAuthorYearLabel(ref: {
  authorSurnames: string[];
  year?: number | undefined;
}): string | undefined {
  if (ref.authorSurnames.length === 0) return undefined;
  const year = ref.year != null ? String(ref.year) : undefined;
  let authors: string;
  if (ref.authorSurnames.length === 1) {
    authors = ref.authorSurnames[0]!;
  } else if (ref.authorSurnames.length === 2) {
    authors = `${ref.authorSurnames[0]!} and ${ref.authorSurnames[1]!}`;
  } else {
    authors = `${ref.authorSurnames[0]!} et al.`;
  }
  return year != null ? `${authors}, ${year}` : authors;
}

function buildSingleMentionExtractionPrompt(input: {
  seedTitle: string;
  seedDoi?: string | undefined;
  citingTitle: string;
  mention: DiscoverCitationOccurrence;
}): string {
  const seedLabel = input.mention.seedRefLabel
    ? `\nSeed reference as it appears in this paper: ${input.mention.seedRefLabel}`
    : "";
  const bundleNote = input.mention.isBundledCitation
    ? `\nThis marker is shared with ${String(input.mention.bundleSize)} references. Attribute to the seed only what the sentence credits to the seed; a bundle-mate's finding is not the seed's.`
    : "";
  return `You are a scientific attribution extraction agent for a metascience project that audits citation fidelity.

## Task

Extract every distinct empirical claim that the citing paper attributes to the seed paper in this single mention. Only the sentence(s) that carry the seed's citation marker count; neighbouring sentences that cite other work are out of scope even if they appear in the context. Return zero claims when there is no in-scope attribution; do not merge distinct claims.

## Seed paper

Title: ${input.seedTitle}
DOI: ${input.seedDoi ?? "unknown"}

## Citing paper

Title: ${input.citingTitle}

## Mention

Section: ${input.mention.sectionTitle ?? "unknown"}
Citation marker: ${input.mention.citationMarker}${seedLabel}${bundleNote}
Context:
> ${input.mention.rawContext}

## Response format

Respond with JSON (no markdown fences):
{
  "claims": [
    {
      "text": "Self-contained statement of what the citing paper claims the seed paper showed",
      "supportSpanText": "Verbatim span from the mention context",
      "confidence": "high"
    }
  ],
  "reason": "Brief extraction or exclusion reason"
}

Each claim must preserve its own source text, support span, and confidence. The supportSpanText must be copied verbatim from the sentence that carries the seed's marker. Confidence is required: "high" when the sentence plainly credits the seed with the claim, "medium" when the attribution is implied, "low" when the mention is a bare acknowledgment or the claim is uncertain. If no empirical claim is attributed to the seed, return an empty claims array.

Prompt template lineage: ${CANONICAL_EXTRACTION_PROMPT_ID}@${CANONICAL_EXTRACTION_PROMPT_VERSION}`;
}

export const canonicalAttributedClaimExtractionOutputSchema = z
  .object({
    claims: z.array(
      z
        .object({
          text: z.string().trim().min(1),
          supportSpanText: z.string().min(1).optional(),
          confidence: z.enum(["high", "medium", "low"]).optional(),
        })
        .strict(),
    ),
    reason: z.string().min(1).optional(),
  })
  .strict();

export function parseCanonicalAttributedClaimExtractionResponse(
  rawText: string,
):
  | {
      ok: true;
      data: z.infer<typeof canonicalAttributedClaimExtractionOutputSchema>;
    }
  | { ok: false; error: string } {
  try {
    const jsonSlice = extractJsonFromModelText(rawText);
    const parsed: unknown = JSON.parse(jsonSlice);
    const result =
      canonicalAttributedClaimExtractionOutputSchema.safeParse(parsed);
    if (result.success) return { ok: true, data: result.data };
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "JSON parse failed",
    };
  }
}

/**
 * The grounding prompt is split so the seed text (identical for every family
 * of a seed) is a cacheable prefix and only the tracked claim varies.
 */
function buildScopeGroundingPrompt(input: {
  trackedClaim: string;
  seedTitle: string;
  blocks: Array<{
    blockId: string;
    text: string;
    sectionTitle?: string | undefined;
    blockKind: string;
  }>;
}): { prefix: string; suffix: string } {
  const blockText = input.blocks
    .map((block) => {
      const section = block.sectionTitle
        ? ` section="${block.sectionTitle}"`
        : "";
      return `### blockId=${block.blockId} (${block.blockKind}${section})\n${block.text}`;
    })
    .join("\n\n");

  const prefix = `You are assisting a metascience project that audits citation fidelity.

Ground the tracked claim against the immutable seed-text blocks below. Quotes must be exact contiguous substrings of the referenced block.

## Seed paper

Title: ${input.seedTitle}

## Seed-text blocks

${blockText}

`;
  const suffix = `## Tracked claim

"${input.trackedClaim}"

## Response format

Respond with JSON (no markdown fences):
{
  "status": "grounded" | "ambiguous" | "not_found",
  "detailReason": "string",
  "supportSpans": [ { "verbatimQuote": "exact substring", "blockId": "block id from above" } ]
}

Rules:
- grounded/ambiguous require at least one supportSpan with an exact quote and correct blockId
- not_found must use an empty supportSpans array
- never invent blockIds`;
  return { prefix, suffix };
}

function parseScopeGroundingResponse(
  rawText: string,
):
  | { ok: true; data: z.infer<typeof canonicalScopeGroundingOutputSchema> }
  | { ok: false; error: string } {
  try {
    const jsonSlice = extractJsonFromModelText(rawText);
    const parsed: unknown = JSON.parse(jsonSlice);
    const result = canonicalScopeGroundingOutputSchema.safeParse(parsed);
    if (result.success) return { ok: true, data: result.data };
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "JSON parse failed",
    };
  }
}

function buildRelevanceRerankPrompt(
  input: CanonicalEvidenceRerankerInput,
): string {
  // The reranker is an independent ranking: BM25 scores and ranks are withheld
  // so it cannot anchor on the ordering it exists to correct. Block kind and
  // section let it prefer the seed's own results over its background prose.
  const candidates = input.candidates
    .map((candidate, index) => {
      const section = candidate.sourceSectionTitle
        ? `, section="${candidate.sourceSectionTitle}"`
        : "";
      return `${String(index + 1)}. chunkId=${candidate.chunkId} (${candidate.sourceBlockKind}${section})\n${candidate.text}`;
    })
    .join("\n\n");

  return `You are ranking cited-paper chunks by relevance to a claim query.

Query: "${input.query.text}"

Return the top ${String(input.topN)} most relevant chunks. Relevance only — ignore citation fidelity judgments. Prefer chunks that report the cited paper's own results over chunks where it summarizes prior work; candidate order carries no information.

Candidates:
${candidates}

Respond with JSON (no markdown fences):
{
  "results": [
    { "chunkId": "...", "relevanceScore": 0-100, "rank": 1, "rationale": "..." }
  ]
}

Use only candidate chunkIds. ranks must be contiguous from 1.`;
}

function parseRerankResponse(
  rawText: string,
):
  | { ok: true; data: z.infer<typeof evidenceRerankOutputSchema> }
  | { ok: false; error: string } {
  try {
    const jsonSlice = extractJsonFromModelText(rawText);
    const parsed: unknown = JSON.parse(jsonSlice);
    const result = evidenceRerankOutputSchema.safeParse(parsed);
    if (result.success) return { ok: true, data: result.data };
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "JSON parse failed",
    };
  }
}

function parseAdjudicateResponse(
  rawText: string,
):
  | { ok: true; data: z.infer<typeof canonicalAdjudicateModelOutputSchema> }
  | { ok: false; error: string } {
  try {
    const jsonSlice = extractJsonFromModelText(rawText);
    const parsed: unknown = JSON.parse(jsonSlice);
    const result = canonicalAdjudicateModelOutputSchema.safeParse(parsed);
    if (result.success) return { ok: true, data: result.data };
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "JSON parse failed",
    };
  }
}
