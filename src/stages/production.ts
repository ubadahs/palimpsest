/**
 * What every stage's production adapter shares: its dependencies, the session
 * that carries resolved papers between stages, failure mapping, and the
 * provenance recorded for each model call.
 *
 * When an upstream API does not expose exact wire bodies, adapters persist the
 * normalized request and validated response that cross the adapter boundary,
 * labelled as such; they never fabricate raw HTTP.
 */

import type { AppConfig } from "../config/app-config.js";
import type { ThinkingEffort } from "../contract/model-execution.js";
import type { AnalysisRunConfig } from "../contract/run-types.js";
import type { ResolvedPaper } from "../domain/common.js";
import {
  buildNormalizedLLMCallProvenance,
  classifyProviderError,
  LLMProviderError,
  resolveSentPromptCacheControl,
  type LLMCallRecord,
  type LLMClient,
} from "../integrations/llm-client.js";
import type * as openalex from "../integrations/openalex.js";
import type { resolvePaperByDoi } from "../integrations/paper-resolver.js";
import { type ProvenanceStore } from "../pipeline/provenance-store.js";
import {
  createDefaultAdapters,
  type FullTextAcquisitionFailureCode,
  type FullTextFetchAdapters,
} from "../retrieval/fulltext-fetch.js";
import type { ParsedPaperCacheOptions } from "../retrieval/parsed-paper.js";
import type { SeedCodebookStore } from "../storage/seed-codebooks.js";

export function createFullTextAdapters(
  config: AppConfig,
): FullTextFetchAdapters {
  return createDefaultAdapters({
    grobidBaseUrl: config.providerBaseUrls.grobid,
    grobidConcurrency: config.grobidConcurrency,
    email: config.openAlexEmail,
    institutionalProxyUrl: config.institutionalProxyUrl,
  });
}

/**
 * How a call was served, as opposed to what it answered: the snapshot that
 * replied, whether the reply came from the exact-result cache, and the
 * thinking effort in force. Excluded from result identity.
 */
export function modelExecutionTelemetry(record: LLMCallRecord): {
  servedModel?: string;
  exactCacheHit: boolean;
  effort?: ThinkingEffort;
} {
  return {
    ...(record.servedModel != null ? { servedModel: record.servedModel } : {}),
    exactCacheHit: record.exactCacheHit === true,
    ...(record.thinkingEffort != null ? { effort: record.thinkingEffort } : {}),
  };
}

export function llmRequestProvenanceFields(params: {
  purpose:
    | "attributed-claim-extraction"
    | "claim-clustering"
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
  effort?: ThinkingEffort | undefined;
  forceRefresh?: boolean | undefined;
  /** Whether the client batches, which lengthens a shared prefix's cache TTL. */
  batching?: boolean | undefined;
}) {
  return buildNormalizedLLMCallProvenance({
    purpose: params.purpose,
    model: params.model,
    promptVersion: params.promptVersion,
    effort: params.effort,
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

export type AdapterSession = {
  resolvedSeedsByDoi: Map<string, ResolvedPaper>;
  citingPapersByProviderId: Map<string, ResolvedPaper>;
};

export type ProductionAdapterDeps = {
  config: AppConfig;
  runConfig: AnalysisRunConfig;
  llmClient: LLMClient;
  provenanceStore: ProvenanceStore;
  session?: AdapterSession;
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

export function mapLlmFailureCode(error: unknown): {
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

export function createAdapterSession(): AdapterSession {
  return {
    resolvedSeedsByDoi: new Map(),
    citingPapersByProviderId: new Map(),
  };
}
