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
import { inferSectionRoles } from "../domain/section-patterns.js";
import { annotateCitingContext } from "../shared/citation-context-window.js";
import { CITATION_ROLE_DEFINITIONS } from "../shared/scientific-rubrics.js";
import {
  buildNormalizedLLMCallProvenance,
  classifyProviderError,
  resolveSentPromptCacheControl,
  resolveThinkingConfig,
  type LLMCallRecord,
  type LLMClient,
  type ThinkingConfig,
  type ThinkingEffort,
  LLMProviderError,
} from "../integrations/llm-client.js";
import { resolvePaperByDoi } from "../integrations/paper-resolver.js";
import * as openalex from "../integrations/openalex.js";
import { seedTextAdjudicateReplySchema } from "../adjudication/seed-text-adjudicate.js";
import type { CanonicalDiscoverAdapters } from "./canonical-discover.js";
import type {
  CanonicalEvidenceAdapters,
  CanonicalEvidenceRerankerInput,
} from "./canonical-evidence.js";
import {
  adjudicatePromptText,
  type CanonicalAdjudicateAdapterInput,
  type CanonicalAdjudicateAdapters,
} from "./canonical-adjudicate.js";
import {
  applyPrepareModelRole,
  classifyPrepareOccurrenceDeterministically,
  prepareRoleNeedsModelFallback,
  type CanonicalPrepareAdapters,
  type CanonicalPrepareClassifierInput,
} from "./canonical-prepare.js";
import {
  canonicalScopeGroundingOutputSchema,
  type CanonicalScopeAdapters,
} from "./canonical-scope.js";
import {
  SEED_CODEBOOK_PROCEDURE_VERSION,
  buildCodebookTaggingPrefix,
  buildCodebookTaggingSuffix,
  codebookTaggingReplySchema,
  resolveSeedCodebook,
  runSeedCodebookProcedure,
  type CodebookStep,
} from "./seed-codebook.js";
import type { ModelExecution } from "../contract/model-execution.js";
import type { SeedCodebookStore } from "../storage/seed-codebooks.js";
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
    grobidConcurrency: config.grobidConcurrency,
    email: config.openAlexEmail,
    institutionalProxyUrl: config.institutionalProxyUrl,
  });
}
import { canonicalSha256 } from "../shared/stable-identity.js";

const CANONICAL_EXTRACTION_PROMPT_ID =
  "canonical-attributed-claim-extraction" as const;
const CANONICAL_EXTRACTION_PROMPT_VERSION = LLM_PROMPT_VERSIONS.extraction;
const CANONICAL_CANONICALIZATION_PROMPT_ID =
  "canonical-claim-canonicalization" as const;
const CANONICAL_CANONICALIZATION_PROMPT_VERSION =
  LLM_PROMPT_VERSIONS.canonicalization;
const CANONICAL_SCOPE_GROUNDING_PROMPT_ID =
  "canonical-scope-grounding" as const;
const CANONICAL_SCOPE_GROUNDING_PROMPT_VERSION = LLM_PROMPT_VERSIONS.grounding;
const CANONICAL_ROLE_CLASSIFICATION_PROMPT_ID =
  "canonical-citation-role-classification" as const;
const CANONICAL_ROLE_CLASSIFICATION_PROMPT_VERSION =
  LLM_PROMPT_VERSIONS.roleClassification;
const CANONICAL_EVIDENCE_RERANK_PROMPT_ID =
  "canonical-evidence-relevance-rerank" as const;
const CANONICAL_EVIDENCE_RERANK_PROMPT_VERSION = "v2" as const;
const CANONICAL_SEED_CODEBOOK_PROMPT_ID = "canonical-seed-codebook" as const;
const CANONICAL_SEED_CODEBOOK_PROMPT_VERSION = LLM_PROMPT_VERSIONS.seedCodebook;
const CANONICAL_CODEBOOK_TAGGING_PROMPT_ID =
  "canonical-codebook-tagging" as const;
const CANONICAL_CODEBOOK_TAGGING_PROMPT_VERSION =
  LLM_PROMPT_VERSIONS.codebookTagging;

/**
 * How a call was served, as opposed to what it answered: the snapshot that
 * replied, whether the reply came from the exact-result cache, and the
 * thinking configuration in force. Excluded from result identity.
 */
function modelExecutionTelemetry(record: LLMCallRecord): {
  servedModel?: string;
  exactCacheHit: boolean;
  thinking?: ThinkingConfig;
} {
  const thinking: ThinkingConfig | undefined =
    record.thinkingType === "adaptive" && record.thinkingEffort != null
      ? { type: "adaptive", effort: record.thinkingEffort }
      : record.thinkingType === "enabled" && record.thinkingBudgetTokens != null
        ? { type: "enabled", budgetTokens: record.thinkingBudgetTokens }
        : undefined;
  return {
    ...(record.servedModel != null ? { servedModel: record.servedModel } : {}),
    exactCacheHit: record.exactCacheHit === true,
    ...(thinking != null ? { thinking } : {}),
  };
}

function mapLlmCallThinking(
  model: string,
  enabled: boolean,
  budgetTokens: number,
  effort?: ThinkingEffort,
): ThinkingConfig | undefined {
  return resolveThinkingConfig({
    model,
    enabled,
    budgetTokens,
    ...(effort != null ? { effort } : {}),
  });
}

function llmRequestProvenanceFields(params: {
  purpose:
    | "attributed-claim-extraction"
    | "claim-canonicalization"
    | "citation-role-classification"
    | "seed-grounding"
    | "seed-codebook"
    | "codebook-tagging"
    | "evidence-rerank"
    | "adjudication";
  model: string;
  /** The part of the prompt other requests share, when there is one. */
  sharedPrefix?: string | undefined;
  promptVersion: string;
  exactCacheKeyVersion: string;
  thinking?: ThinkingConfig | undefined;
  forceRefresh?: boolean | undefined;
  /** Whether the client batches, which lengthens a shared prefix's cache TTL. */
  batching?: boolean | undefined;
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
    ...(params.sharedPrefix != null
      ? {
          promptCacheControl: resolveSentPromptCacheControl({
            purpose: params.purpose,
            promptPrefix: params.sharedPrefix,
            batching: params.batching,
          }),
        }
      : {}),
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
  /** Verified seed codebooks kept between runs; absent, each run generates. */
  codebookStore?: SeedCodebookStore;
  /** Generate and store a new codebook even when one is stored for the key. */
  regenerateCodebook?: boolean;
  /** Run that a newly generated codebook is attributed to. */
  runId?: string;
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
  /** Raw model text, when the provider answered but the reply was unusable. */
  responseText?: string;
} {
  const classified = classifyProviderError(error);
  const reason = classified.message;
  if (
    classified.classification === "invalid_request" ||
    classified.classification === "spend_limit"
  ) {
    // A malformed request fails every record the same way, and a spent limit
    // refuses every remaining one, so the stage aborts instead of recording
    // one typed failure per record. A resume picks up where it stopped.
    throw error;
  }
  if (classified.classification === "malformed_output") {
    const responseText =
      error instanceof LLMProviderError ? error.responseText : undefined;
    return {
      reasonCode: "invalid_response",
      reason,
      ...(responseText != null ? { responseText } : {}),
    };
  }
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
 * Persist each paginated citing-neighborhood page's normalized
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
        page: page.page,
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
        keptCount: page.keptCount,
        responseTotalCount: page.responseTotalCount,
      },
      canonicalStage: "discover",
    });
    pageArtifacts.push(requestArtifact, responseArtifact);
    for (let i = 0; i < page.keptCount; i++) {
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
          pageResponseArtifact ??
            store.persist({
              role: "normalized-citing-paper",
              body: { role: "normalized-citing-paper", paper },
              canonicalStage: "discover",
            }),
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

      // The one blob a citing paper earns: which bytes were parsed, from
      // where, and with what. Every occurrence harvested from this paper
      // points at it, so the ledger stays traceable without a file per mention.
      const parseArtifact = store.persist({
        role: "citing-paper-parse",
        body: {
          citingPaperId: citing.id,
          acquisition: materializeResult.data.acquisition,
          parserKind: materializeResult.data.parsedDocument.parserKind,
          parserVersion: materializeResult.data.parsedDocument.parserVersion,
          blockCount: materializeResult.data.parsedDocument.blocks.length,
          mentionCount: materializeResult.data.parsedDocument.mentions.length,
        },
        canonicalStage: "discover",
      });
      const materializationArtifacts = [parseArtifact];
      const acquisition = {
        accessChannel:
          materializeResult.data.acquisition.accessChannel ?? "open_access",
        ...(materializeResult.data.acquisition.fullTextFormat
          ? {
              fullTextFormat: materializeResult.data.acquisition.fullTextFormat,
            }
          : {}),
        ...(materializeResult.data.acquisition.selectedUrl
          ? { selectedUrl: materializeResult.data.acquisition.selectedUrl }
          : {}),
      };

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
        return {
          materialization: {
            status: "succeeded" as const,
            reason: "Citing paper text materialized.",
            provenanceArtifacts: materializationArtifacts,
          },
          harvest: {
            status: "no_mentions" as const,
            reason: "Seed paper not found in citing bibliography.",
            reasonCode: "not_found" as const,
            provenanceArtifacts: [parseArtifact],
          },
          mentions: [],
          acquisition,
        };
      }
      const seedRef = seedMatch.reference;

      const rawMentions = selectSeedReferenceMentions(
        materializeResult.data.parsedDocument.mentions,
        seedRef.refId,
      );
      if (rawMentions.length === 0) {
        return {
          materialization: {
            status: "succeeded" as const,
            reason: "Citing paper text materialized.",
            provenanceArtifacts: materializationArtifacts,
          },
          harvest: {
            status: "no_mentions" as const,
            reasonCode: "no_in_text_mentions" as const,
            reason:
              "Seed bibliography entry found but no in-text citation mentions.",
            provenanceArtifacts: [parseArtifact],
          },
          mentions: [],
          acquisition,
          bibliographyMatch: {
            method: seedMatch.method,
            refId: seedRef.refId,
          },
        };
      }

      const seedRefLabel = buildAuthorYearLabel(seedRef);

      return {
        materialization: {
          status: "succeeded" as const,
          reason: "Citing paper text materialized.",
          provenanceArtifacts: materializationArtifacts,
        },
        harvest: {
          status: "succeeded" as const,
          reason: `Harvested ${String(rawMentions.length)} citation occurrence(s).`,
          provenanceArtifacts: [parseArtifact],
        },
        acquisition,
        bibliographyMatch: { method: seedMatch.method, refId: seedRef.refId },
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
          provenanceArtifacts: [parseArtifact],
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
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "attributed-claim-extraction",
          model,
          promptVersion: CANONICAL_EXTRACTION_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.extraction,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "attributed-claim-extraction",
          model,
          prompt,
          schema: canonicalAttributedClaimExtractionOutputSchema,
          context: { stageKey: "discover" },
          ...(thinking != null ? { thinking } : {}),
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.extraction },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: contentAddressedModelExecution({
            provider: "anthropic",
            model,
            promptId: CANONICAL_EXTRACTION_PROMPT_ID,
            promptVersion: CANONICAL_EXTRACTION_PROMPT_VERSION,
            promptText: prompt,
            requestBody,
            responseBody: {
              role: "normalized-attributed-claim-extraction-failure",
              error: mapped.reason,
              ...(mapped.responseText != null
                ? { modelText: mapped.responseText }
                : {}),
            },
            store,
            requestRole: "normalized-attributed-claim-extraction-request",
            responseRole: "normalized-attributed-claim-extraction-failure",
            canonicalStage: "discover",
          }),
        };
      }

      const execution = contentAddressedModelExecution({
        provider: "anthropic",
        model: result.record.model,
        ...modelExecutionTelemetry(result.record),
        promptId: CANONICAL_EXTRACTION_PROMPT_ID,
        promptVersion: CANONICAL_EXTRACTION_PROMPT_VERSION,
        promptText: prompt,
        requestBody,
        responseBody: {
          role: "normalized-attributed-claim-extraction-response",
          object: result.object,
        },
        store,
        requestRole: "normalized-attributed-claim-extraction-request",
        responseRole: "normalized-attributed-claim-extraction-response",
        canonicalStage: "discover",
      });
      return {
        status: "completed" as const,
        reason:
          result.object.reason ??
          (result.object.claims.length === 0
            ? "Mention contains no in-scope empirical attribution."
            : `Extracted ${String(result.object.claims.length)} attributed claim(s).`),
        claims: result.object.claims.map((claim) => ({
          text: claim.text.trim(),
          ...(claim.supportSpanText
            ? { supportSpanText: claim.supportSpanText }
            : {}),
          ...(claim.confidence ? { confidence: claim.confidence } : {}),
        })),
        execution,
      };
    },

    canonicalizeClaims: async ({ seed, claims }) => {
      const prompt = buildClaimCanonicalizationPrompt({
        seedTitle: seed.paper.title,
        seedDoi: seed.paper.doi,
        claims,
      });
      const model = deps.runConfig.discover.canonicalizationModel;
      const thinking = mapLlmCallThinking(
        model,
        deps.runConfig.discover.canonicalizationThinking,
        8000,
      );
      const requestBody = {
        seedId: seed.paper.paperId,
        claimRecordIds: claims.map((claim) => claim.claimRecordId),
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "claim-canonicalization",
          model,
          promptVersion: CANONICAL_CANONICALIZATION_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.canonicalization,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      const executionFor = (
        responseBody: Record<string, unknown>,
        record?: LLMCallRecord,
      ) =>
        contentAddressedModelExecution({
          provider: "anthropic",
          model: record?.model ?? model,
          ...(record ? modelExecutionTelemetry(record) : {}),
          promptId: CANONICAL_CANONICALIZATION_PROMPT_ID,
          promptVersion: CANONICAL_CANONICALIZATION_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody,
          store,
          requestRole: "normalized-claim-canonicalization-request",
          responseRole: String(responseBody["role"]),
          canonicalStage: "discover",
        });
      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "claim-canonicalization",
          model,
          prompt,
          schema: claimCanonicalizationOutputSchema,
          context: { stageKey: "discover" },
          ...(thinking != null ? { thinking } : {}),
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.canonicalization },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: executionFor({
            role: "normalized-claim-canonicalization-failure",
            error: mapped.reason,
            ...(mapped.responseText != null
              ? { modelText: mapped.responseText }
              : {}),
          }),
        };
      }

      const execution = executionFor(
        {
          role: "normalized-claim-canonicalization-response",
          object: result.object,
        },
        result.record,
      );
      return {
        status: "completed" as const,
        clusters: result.object.clusters.map((cluster) => ({
          canonicalClaim: cluster.canonicalClaim,
          claimRecordIds: cluster.claims.flatMap((handle) => {
            const claim = claims[handle - 1];
            return claim ? [claim.claimRecordId] : [];
          }),
        })),
        execution,
      };
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

      const sectionRoles = inferSectionRoles(doc.blocks);
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
        blocks: doc.blocks.map((block, index) => ({
          blockId: block.blockId,
          text: block.text,
          ...(block.sectionTitle ? { sectionTitle: block.sectionTitle } : {}),
          blockKind: block.blockKind,
          sectionRole: sectionRoles[index]!,
          // The seed's own in-text citations per block: the signal that lets
          // downstream stages separate the seed's results from its summary of
          // prior work.
          citationMentionCount: doc.mentions.filter(
            (mention) => mention.blockId === block.blockId,
          ).length,
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
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "seed-grounding",
          model,
          sharedPrefix: promptParts.prefix,
          batching: deps.llmClient.batching,
          promptVersion: CANONICAL_SCOPE_GROUNDING_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.grounding,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "seed-grounding",
          model,
          promptPrefix: promptParts.prefix,
          promptSuffix: promptParts.suffix,
          schema: canonicalScopeGroundingOutputSchema,
          context: { stageKey: "scope" },
          ...(thinking != null ? { thinking } : {}),
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.grounding },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: contentAddressedModelExecution({
            provider: "anthropic",
            model,
            promptId: CANONICAL_SCOPE_GROUNDING_PROMPT_ID,
            promptVersion: CANONICAL_SCOPE_GROUNDING_PROMPT_VERSION,
            promptText: prompt,
            requestBody,
            responseBody: {
              role: "normalized-scope-grounding-failure",
              error: mapped.reason,
              ...(mapped.responseText != null
                ? { modelText: mapped.responseText }
                : {}),
            },
            store,
            requestRole: "normalized-scope-grounding-request",
            responseRole: "normalized-scope-grounding-failure",
            canonicalStage: "scope",
          }),
        };
      }

      const execution = contentAddressedModelExecution({
        provider: "anthropic",
        model: result.record.model,
        ...modelExecutionTelemetry(result.record),
        promptId: CANONICAL_SCOPE_GROUNDING_PROMPT_ID,
        promptVersion: CANONICAL_SCOPE_GROUNDING_PROMPT_VERSION,
        promptText: prompt,
        requestBody,
        responseBody: {
          role: "normalized-scope-grounding-response",
          object: result.object,
        },
        store,
        requestRole: "normalized-scope-grounding-request",
        responseRole: "normalized-scope-grounding-response",
        canonicalStage: "scope",
      });
      return {
        status: "completed" as const,
        rawOutput: result.object,
        execution,
      };
    },

    buildCodebook: async ({ seed, seedText, seedTextHash }) => {
      const model = deps.runConfig.scope.codebookModel;
      const thinking = mapLlmCallThinking(model, true, 10_000, "medium");
      const regenerate = deps.regenerateCodebook === true;
      const key = {
        seedId: seed.seedId,
        seedTextHash,
        procedureVersion: SEED_CODEBOOK_PROCEDURE_VERSION,
      };
      const executions: ModelExecution[] = [];
      const failed = (
        code:
          | "timeout"
          | "rate_limited"
          | "transport"
          | "invalid_response"
          | "provider_failure"
          | "no_verified_entries",
        reason: string,
      ) => ({
        status: "failed" as const,
        seedId: seed.seedId,
        procedureVersion: SEED_CODEBOOK_PROCEDURE_VERSION,
        seedTextHash,
        failure: { code, reason },
        executions,
      });
      return resolveSeedCodebook({
        store: deps.codebookStore,
        key,
        regenerate,
        generatedAt: new Date().toISOString(),
        runId: deps.runId,
        generate: async () => {
          try {
            const result = await runSeedCodebookProcedure({
              seedTitle:
                seed.resolution.status === "resolved"
                  ? seed.resolution.paper.title
                  : seed.doi,
              blocks: seedText.blocks,
              call: async ({ step, promptPrefix, promptSuffix, schema }) =>
                schema.parse(
                  await callCodebookStep({
                    step,
                    promptPrefix,
                    promptSuffix,
                    schema,
                  }),
                ),
            });
            if (!result.ok) {
              return failed("no_verified_entries", result.error);
            }
            return {
              status: "generated" as const,
              output: result.data,
              model,
              executions,
            };
          } catch (error) {
            if (error instanceof CodebookStepFailure) {
              return failed(error.code, error.message);
            }
            throw error;
          }
        },
      });

      async function callCodebookStep(input: {
        step: CodebookStep;
        promptPrefix: string;
        promptSuffix: string;
        schema: z.ZodType;
      }): Promise<unknown> {
        const prompt = `${input.promptPrefix}${input.promptSuffix}`;
        const requestBody = {
          seedId: seed.seedId,
          step: input.step,
          promptText: prompt,
          llm: llmRequestProvenanceFields({
            purpose: "seed-codebook",
            model,
            sharedPrefix: input.promptPrefix,
            batching: deps.llmClient.batching,
            promptVersion: CANONICAL_SEED_CODEBOOK_PROMPT_VERSION,
            exactCacheKeyVersion: LLM_CACHE_VERSIONS.seedCodebook,
            ...(thinking != null ? { thinking } : {}),
            forceRefresh: deps.forceRefresh === true || regenerate,
          }),
        };
        let result;
        try {
          result = await deps.llmClient.generateObject({
            purpose: "seed-codebook",
            model,
            promptPrefix: input.promptPrefix,
            promptSuffix: input.promptSuffix,
            schema: input.schema,
            context: { stageKey: "scope" },
            ...(thinking != null ? { thinking } : {}),
            maxOutputTokens: 24_000,
            // Regeneration must ask the model again, not replay the cache;
            // its reply then replaces the cached one.
            exactCache: {
              keyVersion: LLM_CACHE_VERSIONS.seedCodebook,
              ...(regenerate ? { refresh: true } : {}),
            },
          });
        } catch (error) {
          const mapped = mapLlmFailureCode(error);
          executions.push(
            contentAddressedModelExecution({
              provider: "anthropic",
              model,
              promptId: CANONICAL_SEED_CODEBOOK_PROMPT_ID,
              promptVersion: CANONICAL_SEED_CODEBOOK_PROMPT_VERSION,
              promptText: prompt,
              requestBody,
              responseBody: {
                role: "normalized-seed-codebook-failure",
                error: mapped.reason,
                ...(mapped.responseText != null
                  ? { modelText: mapped.responseText }
                  : {}),
              },
              store,
              requestRole: "normalized-seed-codebook-request",
              responseRole: "normalized-seed-codebook-failure",
              canonicalStage: "scope",
            }),
          );
          if (isFatalScopeCode(mapped.reasonCode)) {
            throw new Error(
              `Seed codebook provider failure (${mapped.reasonCode}): ${mapped.reason}`,
              { cause: error },
            );
          }
          throw new CodebookStepFailure(
            mapped.reasonCode as Exclude<
              typeof mapped.reasonCode,
              "authentication" | "authorization" | "billing" | "quota"
            >,
            mapped.reason,
          );
        }
        executions.push(
          contentAddressedModelExecution({
            provider: "anthropic",
            model: result.record.model,
            ...modelExecutionTelemetry(result.record),
            promptId: CANONICAL_SEED_CODEBOOK_PROMPT_ID,
            promptVersion: CANONICAL_SEED_CODEBOOK_PROMPT_VERSION,
            promptText: prompt,
            requestBody,
            responseBody: {
              role: "normalized-seed-codebook-response",
              object: result.object,
            },
            store,
            requestRole: "normalized-seed-codebook-request",
            responseRole: "normalized-seed-codebook-response",
            canonicalStage: "scope",
          }),
        );
        return result.object;
      }
    },

    tagClaim: async ({ codebook, claimText }) => {
      const model = deps.runConfig.scope.taggingModel;
      const thinking = mapLlmCallThinking(model, true, 2_000, "low");
      const promptPrefix = buildCodebookTaggingPrefix(codebook);
      const promptSuffix = buildCodebookTaggingSuffix(claimText);
      const prompt = `${promptPrefix}${promptSuffix}`;
      const requestBody = {
        codebookId: codebook.codebookId,
        claimText,
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "codebook-tagging",
          model,
          sharedPrefix: promptPrefix,
          batching: deps.llmClient.batching,
          promptVersion: CANONICAL_CODEBOOK_TAGGING_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.codebookTagging,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "codebook-tagging",
          model,
          promptPrefix,
          promptSuffix,
          schema: codebookTaggingReplySchema(codebook),
          context: { stageKey: "scope" },
          ...(thinking != null ? { thinking } : {}),
          maxOutputTokens: 4_000,
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.codebookTagging },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: contentAddressedModelExecution({
            provider: "anthropic",
            model,
            promptId: CANONICAL_CODEBOOK_TAGGING_PROMPT_ID,
            promptVersion: CANONICAL_CODEBOOK_TAGGING_PROMPT_VERSION,
            promptText: prompt,
            requestBody,
            responseBody: {
              role: "normalized-codebook-tagging-failure",
              error: mapped.reason,
              ...(mapped.responseText != null
                ? { modelText: mapped.responseText }
                : {}),
            },
            store,
            requestRole: "normalized-codebook-tagging-request",
            responseRole: "normalized-codebook-tagging-failure",
            canonicalStage: "scope",
          }),
        };
      }
      return {
        status: "completed" as const,
        rawOutput: result.object,
        execution: contentAddressedModelExecution({
          provider: "anthropic",
          model: result.record.model,
          ...modelExecutionTelemetry(result.record),
          promptId: CANONICAL_CODEBOOK_TAGGING_PROMPT_ID,
          promptVersion: CANONICAL_CODEBOOK_TAGGING_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody: {
            role: "normalized-codebook-tagging-response",
            object: result.object,
          },
          store,
          requestRole: "normalized-codebook-tagging-request",
          responseRole: "normalized-codebook-tagging-response",
          canonicalStage: "scope",
        }),
      };
    },
  };
}

/** A nonfatal provider failure on one codebook step; the seed gets none. */
class CodebookStepFailure extends Error {
  override readonly name = "CodebookStepFailure";

  constructor(
    readonly code:
      | "timeout"
      | "rate_limited"
      | "transport"
      | "invalid_response",
    message: string,
  ) {
    super(message);
  }
}

function isFatalScopeCode(code: string): boolean {
  return (
    code === "authentication" ||
    code === "authorization" ||
    code === "billing" ||
    code === "quota"
  );
}

/**
 * Deterministic regex first, model second. The regex pass costs nothing and
 * settles most occurrences; only the ones it calls `unclear` reach a small
 * model, which is where the deterministic classifier lost the most records.
 */
export function buildCanonicalPrepareAdapters(
  deps: CanonicalProductionAdapterDeps,
): CanonicalPrepareAdapters {
  const store = deps.provenanceStore;
  const model = deps.runConfig.prepare.roleClassifierModel;
  // Naming a citation's role is a quick judgment; no call asks for thinking.
  const thinking = resolveThinkingConfig({ model, enabled: false });

  return {
    classifyCitation: async (input) => {
      const deterministic = classifyPrepareOccurrenceDeterministically(
        input.citationOccurrence,
        {
          isReviewMediated: isReviewPaperType(
            input.citingPaper.paper.paperType,
          ),
          occurrenceSourceClaimRecords: input.occurrenceSourceClaimRecords,
        },
      );
      if (!prepareRoleNeedsModelFallback(deterministic)) {
        return deterministic;
      }

      const prompt = buildCitationRolePrompt(input);
      const requestBody = {
        familyId: input.family.familyId,
        citationOccurrenceId: input.citationOccurrence.mentionId,
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "citation-role-classification",
          model,
          promptVersion: CANONICAL_ROLE_CLASSIFICATION_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.roleClassification,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      const modelExecution = (
        responseBody: Record<string, unknown>,
        record?: LLMCallRecord,
      ) =>
        contentAddressedModelExecution({
          provider: "anthropic",
          model: record?.model ?? model,
          ...(record ? modelExecutionTelemetry(record) : {}),
          promptId: CANONICAL_ROLE_CLASSIFICATION_PROMPT_ID,
          promptVersion: CANONICAL_ROLE_CLASSIFICATION_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody,
          store,
          requestRole: "normalized-citation-role-request",
          responseRole: String(responseBody["role"]),
          canonicalStage: "prepare",
        });

      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "citation-role-classification",
          model,
          prompt,
          schema: citationRoleResponseSchema,
          context: { stageKey: "prepare" },
          ...(thinking != null ? { thinking } : {}),
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.roleClassification },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return applyPrepareModelRole(deterministic, {
          citationRole: "unclear",
          rationale: `Model role fallback failed (${mapped.reasonCode}): ${mapped.reason}`,
          signals: [`model-role:${mapped.reasonCode}`],
          execution: modelExecution({
            role: "normalized-citation-role-failure",
            error: mapped.reason,
            ...(mapped.responseText != null
              ? { modelText: mapped.responseText }
              : {}),
          }),
        });
      }

      return applyPrepareModelRole(deterministic, {
        citationRole: result.object.citationRole,
        rationale: result.object.rationale,
        signals: [`model-role:${result.object.citationRole}`],
        execution: modelExecution(
          {
            role: "normalized-citation-role-response",
            object: result.object,
          },
          result.record,
        ),
      });
    },
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
  // Ranking passages is a quick judgment; no call asks the reranker to think.
  const thinking = resolveThinkingConfig({ model, enabled: false });

  return {
    rerank: async (input: CanonicalEvidenceRerankerInput) => {
      const prompt = buildRelevanceRerankPrompt(input);
      const requestBody = {
        familyId: input.familyId,
        bm25RunId: input.bm25RunId,
        topN: input.topN,
        candidateChunkIds: input.candidates.map((c) => c.chunkId),
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "evidence-rerank",
          model,
          promptVersion: CANONICAL_EVIDENCE_RERANK_PROMPT_VERSION,
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.rerank,
          ...(thinking != null ? { thinking } : {}),
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "evidence-rerank",
          model,
          prompt,
          schema: rerankModelResponseSchema,
          context: { stageKey: "evidence" },
          ...(thinking != null ? { thinking } : {}),
          exactCache: { keyVersion: LLM_CACHE_VERSIONS.rerank },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: contentAddressedModelExecution({
            provider: "anthropic",
            model,
            promptId: CANONICAL_EVIDENCE_RERANK_PROMPT_ID,
            promptVersion: CANONICAL_EVIDENCE_RERANK_PROMPT_VERSION,
            promptText: prompt,
            requestBody,
            responseBody: {
              role: "normalized-evidence-rerank-failure",
              error: mapped.reason,
              ...(mapped.responseText != null
                ? { modelText: mapped.responseText }
                : {}),
            },
            store,
            requestRole: "normalized-evidence-rerank-request",
            responseRole: "normalized-evidence-rerank-failure",
            canonicalStage: "evidence",
          }),
        };
      }

      const parsed = mapRerankResponse(result.object, input.candidates);
      const execution = contentAddressedModelExecution({
        provider: "anthropic",
        model: result.record.model,
        ...modelExecutionTelemetry(result.record),
        promptId: CANONICAL_EVIDENCE_RERANK_PROMPT_ID,
        promptVersion: CANONICAL_EVIDENCE_RERANK_PROMPT_VERSION,
        promptText: prompt,
        requestBody,
        responseBody: {
          role: "normalized-evidence-rerank-response",
          object: result.object,
          mapped: parsed.ok ? parsed.data : { mappingError: parsed.error },
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
    },
  };
}

export function buildCanonicalAdjudicateAdapters(
  deps: CanonicalProductionAdapterDeps,
): CanonicalAdjudicateAdapters {
  const store = deps.provenanceStore;
  const model = deps.runConfig.adjudicate.model;
  // The first request that carries a seed text writes the provider's cache;
  // the rest of that seed's records wait for it so they read the cache
  // instead of each paying to write it.
  const cacheWrites = new Map<string, Promise<unknown>>();

  return {
    adjudicate: async (input: CanonicalAdjudicateAdapterInput) => {
      const promptText = adjudicatePromptText(input);
      const expectedRequestHash = hashCanonicalAdjudicateRequest(input);
      const thinking = mapLlmCallThinking(
        model,
        deps.runConfig.adjudicate.thinking,
        12_000,
        deps.runConfig.adjudicate.effort,
      );
      // A whole-seed-text request names the seed text by its hash: it keys
      // the cache write below, and stands in for the text in the stored
      // request, because the Evidence artifact this stage reads already
      // holds it.
      const seedTextContentHash =
        input.evidence === "seed_text"
          ? canonicalSha256(input.promptPrefix)
          : undefined;
      const llm = llmRequestProvenanceFields({
        purpose: "adjudication",
        model,
        ...(input.evidence === "seed_text"
          ? {
              sharedPrefix: input.promptPrefix,
              batching: deps.llmClient.batching,
            }
          : {}),
        promptVersion: input.promptVersion,
        exactCacheKeyVersion: LLM_CACHE_VERSIONS.adjudication,
        ...(thinking != null ? { thinking } : {}),
        forceRefresh: deps.forceRefresh === true,
      });
      const requestBody = {
        purpose: input.purpose,
        recordId: input.recordId,
        promptId: input.promptId,
        promptVersion: input.promptVersion,
        ...(input.evidence === "seed_text"
          ? { seedTextContentHash, promptSuffix: input.promptSuffix }
          : { promptText }),
        llm,
      };
      const executionOf = (
        responseRole: string,
        responseBody: Record<string, unknown>,
        served: { model: string } & Partial<
          ReturnType<typeof modelExecutionTelemetry>
        >,
      ) =>
        contentAddressedModelExecution({
          provider: "anthropic",
          ...served,
          promptId: input.promptId,
          promptVersion: input.promptVersion,
          promptText,
          requestBody,
          responseBody: { role: responseRole, ...responseBody },
          store,
          requestRole: "normalized-canonical-adjudicate-request",
          responseRole,
          requestHash: expectedRequestHash,
          canonicalStage: "adjudicate",
        });
      const request = {
        purpose: "adjudication" as const,
        model,
        context: { stageKey: "adjudicate" as const },
        ...(thinking != null ? { thinking } : {}),
        exactCache: { keyVersion: LLM_CACHE_VERSIONS.adjudication },
      };

      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let reply: { object: unknown; record: LLMCallRecord; rawOutput: unknown };
      try {
        if (input.evidence === "seed_text") {
          const cacheWrite = cacheWrites.get(seedTextContentHash!);
          if (cacheWrite) await cacheWrite;
          const sent = deps.llmClient.generateObject({
            ...request,
            promptPrefix: input.promptPrefix,
            promptSuffix: input.promptSuffix,
            schema: seedTextAdjudicateReplySchema,
          });
          if (!cacheWrite)
            cacheWrites.set(
              seedTextContentHash!,
              sent.catch(() => undefined),
            );
          const result = await sent;
          // The stage verifies the quotes against the seed text.
          reply = { ...result, rawOutput: result.object };
        } else {
          const result = await deps.llmClient.generateObject({
            ...request,
            prompt: input.promptText,
            schema: adjudicateModelResponseSchema,
          });
          const mapped = mapAdjudicateResponse(result.object, input.packet);
          reply = {
            ...result,
            rawOutput: mapped.ok ? mapped.data : { mappingError: mapped.error },
          };
        }
      } catch (error) {
        const failure = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: failure.reasonCode,
          reason: failure.reason,
          execution: executionOf(
            "normalized-canonical-adjudicate-failure",
            {
              error: failure.reason,
              ...(failure.responseText != null
                ? { modelText: failure.responseText }
                : {}),
            },
            { model },
          ),
        };
      }

      return {
        status: "completed" as const,
        rawOutput: reply.rawOutput,
        execution: executionOf(
          "normalized-canonical-adjudicate-response",
          {
            object: reply.object,
            ...(input.evidence === "seed_text"
              ? {}
              : { mapped: reply.rawOutput }),
          },
          {
            model: reply.record.model,
            ...modelExecutionTelemetry(reply.record),
          },
        ),
      };
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
    prepare: buildCanonicalPrepareAdapters(withSession),
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

function buildClaimCanonicalizationPrompt(input: {
  seedTitle: string;
  seedDoi?: string | undefined;
  claims: Array<{
    claimRecordId: string;
    extractedClaimText: string;
    citingPaperTitle: string;
    sectionTitle?: string | undefined;
  }>;
}): string {
  const claimLines = input.claims
    .map((claim, index) => {
      const where = claim.sectionTitle
        ? `${claim.citingPaperTitle} — ${claim.sectionTitle}`
        : claim.citingPaperTitle;
      return `#${String(index + 1)}: "${claim.extractedClaimText}"\n   (from: ${where})`;
    })
    .join("\n");

  return `You are clustering claims that citing papers attribute to one seed paper, for a metascience project that measures how claims drift as they are cited.

## Seed paper

Title: ${input.seedTitle}
DOI: ${input.seedDoi ?? "unknown"}

## Attributed claims

${claimLines}

## Task

Group the claims that attribute the SAME underlying finding of the seed paper. Claims belong together even when they differ in wording, strength, scope, certainty, population, or specificity; those differences are measured downstream and must not split a group. Split groups only when the claims concern different findings, variables, methods, or materials of the seed. A claim that shares no finding with any other stays in a group of one.

Every claim number above must appear in exactly one group; do not invent numbers.

For each group write one canonicalClaim: a neutral, specific sentence naming the seed finding the group is about. Do not adopt any single citer's exaggeration or hedge; describe what the group has in common.

Respond with JSON (no markdown fences), referring to claims by their numbers:
{
  "clusters": [
    { "canonicalClaim": "…", "claims": [1, 4, 7] }
  ]
}

Prompt template lineage: ${CANONICAL_CANONICALIZATION_PROMPT_ID}@${CANONICAL_CANONICALIZATION_PROMPT_VERSION}`;
}

const claimCanonicalizationOutputSchema = z
  .object({
    clusters: z.array(
      z
        .object({
          canonicalClaim: z.string().trim().min(1),
          /** 1-based handles from the prompt; hashes are too error-prone for a model to echo. */
          claims: z.array(z.number().int().positive()).min(1),
        })
        .strict(),
    ),
  })
  .strict();

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

/**
 * Asks for one citation role from the same five-value taxonomy the regex pass
 * uses. Shows the verified support span (what the extractor bound to the seed),
 * the marked sentences, and the section heading — nothing about the seed's own
 * content, because the question is what this citer is doing with the seed, not
 * whether it is right.
 */
export function buildCitationRolePrompt(
  input: CanonicalPrepareClassifierInput,
): string {
  const occurrence = input.citationOccurrence;
  const section = occurrence.sectionTitle
    ? `Section heading: ${occurrence.sectionTitle}`
    : "Section heading: (not recorded)";
  const refLabel = occurrence.seedRefLabel
    ? `\nSeed reference as it appears in this paper: ${occurrence.seedRefLabel}`
    : "";
  const bundle = occurrence.isBundledCitation
    ? `\nThis marker is shared with ${String(occurrence.bundleSize)} references.`
    : "";
  const spans = input.occurrenceSourceClaimRecords
    .map((claim, index) => {
      const span = claim.supportSpan?.text ?? claim.extractedClaimText;
      return `${String(index + 1)}. ${span}`;
    })
    .join("\n");

  return `You are classifying what a citing paper is doing with one cited reference.

${section}${refLabel}${bundle}

Citing context (sentences attributed to the cited reference are wrapped in ▶ ... ◀):
${annotateCitingContext(
  occurrence.rawContext,
  occurrence.citationMarker,
  occurrence.seedRefLabel,
  input.occurrenceSourceClaimRecords.flatMap((claim) =>
    claim.supportSpan ? [claim.supportSpan] : [],
  ),
)}

Text the extractor bound to the cited reference:
${spans}

${CITATION_ROLE_DEFINITIONS}

Respond with JSON (no markdown fences):
{ "citationRole": "...", "rationale": "one sentence" }`;
}

export const citationRoleResponseSchema = z
  .object({
    citationRole: z.enum([
      "substantive_attribution",
      "background_context",
      "methods_materials",
      "acknowledgment_or_low_information",
      "unclear",
    ]),
    rationale: z.string().min(1),
  })
  .strict();

export function buildRelevanceRerankPrompt(input: {
  query: { text: string };
  topN: number;
  candidates: readonly {
    text: string;
    sourceBlockKind: string;
    sourceSectionTitle?: string | undefined;
    sourceSectionRole?: string | undefined;
    sourceCitesOtherWork?: boolean | undefined;
  }[];
}): string {
  // The reranker is an independent ranking: BM25 scores and ranks are withheld
  // so it cannot anchor on the ordering it exists to correct. Block kind and
  // section let it prefer the seed's own results over its background prose.
  const candidates = input.candidates
    .map((candidate, index) => {
      const section = candidate.sourceSectionTitle
        ? `, section="${candidate.sourceSectionTitle}"`
        : "";
      const role = candidate.sourceSectionRole
        ? `, role=${candidate.sourceSectionRole}`
        : "";
      const cites = candidate.sourceCitesOtherWork ? ", cites other work" : "";
      return `#${String(index + 1)} (${candidate.sourceBlockKind}${role}${section}${cites})\n${candidate.text}`;
    })
    .join("\n\n");

  return `You are ranking cited-paper chunks by relevance to a claim query.

Query: "${input.query.text}"

Return the top ${String(input.topN)} most relevant chunks. Relevance only — ignore citation fidelity judgments. Prefer chunks with role=results, figure, or table, and prefer chunks that do not cite other work: a passage marked "cites other work" is likely the cited paper summarizing prior findings rather than reporting its own. Candidate order carries no information.

Candidates:
${candidates}

Respond with JSON (no markdown fences), referring to candidates by their numbers:
{
  "results": [
    { "candidate": 3, "relevanceScore": 0-100, "rank": 1, "rationale": "..." }
  ]
}

Use only candidate numbers from the list above, each at most once. Ranks must be contiguous from 1.`;
}

/**
 * The model refers to candidates by number; 64-hex chunk ids were echoed
 * with typos often enough to lose a third of rerank calls. Out-of-range or
 * repeated numbers are dropped, results are ordered by score, and ranks are
 * reassigned contiguously before the contract schema is applied.
 */
export const rerankModelResponseSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            candidate: z.number().int().positive(),
            relevanceScore: z.number().min(0).max(100),
            rank: z.number().int().positive().optional(),
            rationale: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/**
 * Turns the model's candidate numbers into chunk ids. The reply's shape is
 * guaranteed by the output schema; what can still go wrong is a number that
 * names no candidate, or a set that names none of them.
 */
function mapRerankResponse(
  reply: z.infer<typeof rerankModelResponseSchema>,
  candidates: CanonicalEvidenceRerankerInput["candidates"],
):
  | { ok: true; data: z.infer<typeof evidenceRerankOutputSchema> }
  | { ok: false; error: string } {
  const seen = new Set<string>();
  const mapped = reply.results.flatMap((entry) => {
    const candidate = candidates[entry.candidate - 1];
    if (!candidate || seen.has(candidate.chunkId)) return [];
    seen.add(candidate.chunkId);
    return [
      {
        chunkId: candidate.chunkId,
        relevanceScore: entry.relevanceScore,
        rationale: entry.rationale?.trim() || "(no rationale given)",
      },
    ];
  });
  mapped.sort((left, right) => right.relevanceScore - left.relevanceScore);
  const result = evidenceRerankOutputSchema.safeParse({
    results: mapped.map((entry, index) => ({ ...entry, rank: index + 1 })),
  });
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  return {
    ok: false,
    error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
  };
}

/** Model reply with chunks referenced by number; mapped to ids before the contract schema. */
export const adjudicateModelResponseSchema = z
  .object({
    citingAssertion: z.string().min(1),
    sourceStatement: z.string().min(1),
    verdict: z.string().min(1),
    mutationKinds: z.array(z.string()).default([]),
    direction: z.string().min(1),
    rationale: z.string().min(1),
    confidence: z.string().min(1),
    citedChunks: z.array(z.number().int().positive()).min(1),
  })
  .strict();

/**
 * Turns the model's chunk numbers into ids and applies the contract schema.
 * The reply's field shape is guaranteed by the output schema; the verdict
 * vocabulary and the chunk references are not.
 */
function mapAdjudicateResponse(
  reply: z.infer<typeof adjudicateModelResponseSchema>,
  packet: CanonicalAdjudicateAdapterInput["packet"],
):
  | { ok: true; data: z.infer<typeof canonicalAdjudicateModelOutputSchema> }
  | { ok: false; error: string } {
  const { citedChunks, ...rest } = reply;
  const citedChunkIds = [
    ...new Set(
      citedChunks.flatMap((handle) => {
        const chunk = packet.selectedChunks[handle - 1];
        return chunk ? [chunk.chunkId] : [];
      }),
    ),
  ];
  const result = canonicalAdjudicateModelOutputSchema.safeParse({
    ...rest,
    citedChunkIds,
  });
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  return {
    ok: false,
    error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
  };
}
