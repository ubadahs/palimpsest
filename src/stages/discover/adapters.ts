/** Discover's production adapter: seed resolution, the citing neighborhood, full text, mention harvest, claim extraction, and clustering. */

import { type ArtifactReference } from "../../contract/artifacts/index.js";
import type { ResolvedPaper } from "../../domain/common.js";
import {
  resolveThinkingEffort,
  type LLMCallRecord,
} from "../../integrations/llm-client.js";
import * as openalex from "../../integrations/openalex.js";
import { resolvePaperByDoi } from "../../integrations/paper-resolver.js";
import {
  contentAddressedExternalExecution,
  contentAddressedModelExecution,
  type ProvenanceStore,
} from "../../pipeline/provenance-store.js";
import {
  matchReferenceByMetadata,
  materializeParsedPaper,
} from "../../retrieval/parsed-paper.js";
import {
  createAdapterSession,
  createFullTextAdapters,
  llmRequestProvenanceFields,
  mapFullTextAcquisitionFailure,
  mapLlmFailureCode,
  modelExecutionTelemetry,
  type ProductionAdapterDeps,
} from "../production.js";
import {
  buildClaimClusteringPrompt,
  buildSingleMentionExtractionPrompt,
  CLUSTERING_PROMPT_ID,
  CLUSTERING_PROMPT_VERSION,
  EXTRACTION_PROMPT_ID,
  EXTRACTION_PROMPT_VERSION,
  claimExtractionOutputSchema,
  claimClusteringOutputSchema,
} from "./prompts.js";
import type { DiscoverAdapters } from "./run.js";

type CitingYearRange = { fromYear?: number; toYear?: number };

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
  store: ProvenanceStore;
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
      stage: "discover",
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
      stage: "discover",
    });
    pageArtifacts.push(requestArtifact, responseArtifact);
    for (let i = 0; i < page.keptCount; i++) {
      responseArtifactByPaperIndex.push(responseArtifact);
    }
  }
  return { pageArtifacts, responseArtifactByPaperIndex };
}

function paperRecord(paper: ResolvedPaper) {
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

export function buildDiscoverAdapters(
  deps: ProductionAdapterDeps,
): DiscoverAdapters {
  const session = deps.session ?? createAdapterSession();
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
            stage: "discover",
          }),
        };
      }
      session.resolvedSeedsByDoi.set(doi.toLowerCase(), result.data);
      return {
        status: "resolved" as const,
        paper: paperRecord(result.data),
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
          stage: "discover",
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
          stage: "discover",
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
            stage: "discover",
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
            stage: "discover",
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
              stage: "discover",
            }),
        ];
        return {
          ...paperRecord(paper),
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
          stage: "discover",
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
            stage: "discover",
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
            stage: "discover",
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
        stage: "discover",
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
      const seedMatch = matchReferenceByMetadata(refs, seedPaper);
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
          ...(mention.markerSpan ? { markerSpan: mention.markerSpan } : {}),
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
      const effort = resolveThinkingEffort({
        enabled: deps.runConfig.discover.extractionThinking,
      });
      const requestBody = {
        mentionId: mention.mentionId,
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "attributed-claim-extraction",
          model,
          promptVersion: EXTRACTION_PROMPT_VERSION,
          effort,
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
          schema: claimExtractionOutputSchema,
          context: { stageKey: "discover" },
          effort,
          exactCache: { keyVersion: EXTRACTION_PROMPT_VERSION },
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
            promptId: EXTRACTION_PROMPT_ID,
            promptVersion: EXTRACTION_PROMPT_VERSION,
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
            stage: "discover",
          }),
        };
      }

      const execution = contentAddressedModelExecution({
        provider: "anthropic",
        model: result.record.model,
        ...modelExecutionTelemetry(result.record),
        promptId: EXTRACTION_PROMPT_ID,
        promptVersion: EXTRACTION_PROMPT_VERSION,
        promptText: prompt,
        requestBody,
        responseBody: {
          role: "normalized-attributed-claim-extraction-response",
          object: result.object,
        },
        store,
        requestRole: "normalized-attributed-claim-extraction-request",
        responseRole: "normalized-attributed-claim-extraction-response",
        stage: "discover",
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

    clusterClaims: async ({ seed, claims }) => {
      const prompt = buildClaimClusteringPrompt({
        seedTitle: seed.paper.title,
        seedDoi: seed.paper.doi,
        claims,
      });
      const model = deps.runConfig.discover.clusteringModel;
      const effort = resolveThinkingEffort({
        enabled: deps.runConfig.discover.clusteringThinking,
      });
      const requestBody = {
        seedId: seed.paper.paperId,
        claimRecordIds: claims.map((claim) => claim.claimRecordId),
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "claim-clustering",
          model,
          promptVersion: CLUSTERING_PROMPT_VERSION,
          effort,
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
          promptId: CLUSTERING_PROMPT_ID,
          promptVersion: CLUSTERING_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody,
          store,
          requestRole: "normalized-claim-clustering-request",
          responseRole: String(responseBody["role"]),
          stage: "discover",
        });
      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "claim-clustering",
          model,
          prompt,
          schema: claimClusteringOutputSchema,
          context: { stageKey: "discover" },
          effort,
          exactCache: { keyVersion: CLUSTERING_PROMPT_VERSION },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: executionFor({
            role: "normalized-claim-clustering-failure",
            error: mapped.reason,
            ...(mapped.responseText != null
              ? { modelText: mapped.responseText }
              : {}),
          }),
        };
      }

      const execution = executionFor(
        {
          role: "normalized-claim-clustering-response",
          object: result.object,
        },
        result.record,
      );
      return {
        status: "completed" as const,
        clusters: result.object.clusters.map((cluster) => ({
          claim: cluster.claim,
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
