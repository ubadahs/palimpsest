/** Scope's production adapter: seed text, grounding, the seed codebook, and codebook tagging. */

import type { z } from "zod";
import type {
  ModelExecution,
  ThinkingEffort,
} from "../../contract/model-execution.js";
import { inferSectionRoles } from "../../domain/section-patterns.js";
import { resolveThinkingEffort } from "../../integrations/llm-client.js";
import { resolvePaperByDoi } from "../../integrations/paper-resolver.js";
import {
  contentAddressedExternalExecution,
  contentAddressedModelExecution,
} from "../../pipeline/provenance-store.js";
import {
  materializeLocalPdf,
  materializeParsedPaper,
  PARSED_PAPER_PARSER_VERSION,
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
  buildScopeGroundingPrompt,
  CODEBOOK_TAGGING_PROMPT_ID,
  CODEBOOK_TAGGING_PROMPT_VERSION,
  GROUNDING_PROMPT_ID,
  GROUNDING_PROMPT_VERSION,
  SEED_CODEBOOK_PROMPT_ID,
  SEED_CODEBOOK_PROMPT_VERSION,
} from "./prompts.js";
import { scopeGroundingOutputSchema, type ScopeAdapters } from "./run.js";
import {
  buildCodebookTaggingPrefix,
  buildCodebookTaggingSuffix,
  codebookTaggingReplySchema,
  resolveSeedCodebook,
  runSeedCodebookProcedure,
  SEED_CODEBOOK_PROCEDURE_VERSION,
  type CodebookStep,
} from "./seed-codebook.js";

export function buildScopeAdapters(deps: ProductionAdapterDeps): ScopeAdapters {
  const session = deps.session ?? createAdapterSession();
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
            stage: "scope",
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
            implementation: "scope-seed-materialize-v1",
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
                stage: "scope",
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
                  stage: "scope",
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
            stage: "scope",
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
              stage: "scope",
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
            stage: "scope",
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
            implementation: "scope-seed-materialize-v1",
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
        stage: "scope",
      });
      const sourceArtifacts = [
        store.persist({
          role: "seed-materialization-source",
          body: {
            acquisition: materializeResult.data.acquisition,
            format: materializeResult.data.fullText.format,
          },
          stage: "scope",
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
            stage: "scope",
          }),
        },
      };
    },

    groundFamily: async ({ seed, family, seedText }) => {
      const promptParts = buildScopeGroundingPrompt({
        claim: family.claim,
        seedTitle:
          seed.resolution.status === "resolved"
            ? seed.resolution.paper.title
            : seed.doi,
        blocks: seedText.blocks,
      });
      const prompt = `${promptParts.prefix}${promptParts.suffix}`;
      const model = deps.runConfig.scope.groundingModel;
      const effort = resolveThinkingEffort({
        enabled: deps.runConfig.scope.groundingThinking,
      });
      const requestBody = {
        familyId: family.familyId,
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "seed-grounding",
          model,
          sharedPrefix: promptParts.prefix,
          batching: deps.llmClient.batching,
          promptVersion: GROUNDING_PROMPT_VERSION,
          effort,
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
          schema: scopeGroundingOutputSchema,
          context: { stageKey: "scope" },
          effort,
          exactCache: { keyVersion: GROUNDING_PROMPT_VERSION },
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
            promptId: GROUNDING_PROMPT_ID,
            promptVersion: GROUNDING_PROMPT_VERSION,
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
            stage: "scope",
          }),
        };
      }

      const execution = contentAddressedModelExecution({
        provider: "anthropic",
        model: result.record.model,
        ...modelExecutionTelemetry(result.record),
        promptId: GROUNDING_PROMPT_ID,
        promptVersion: GROUNDING_PROMPT_VERSION,
        promptText: prompt,
        requestBody,
        responseBody: {
          role: "normalized-scope-grounding-response",
          object: result.object,
        },
        store,
        requestRole: "normalized-scope-grounding-request",
        responseRole: "normalized-scope-grounding-response",
        stage: "scope",
      });
      return {
        status: "completed" as const,
        rawOutput: result.object,
        execution,
      };
    },

    buildCodebook: async ({ seed, seedText, seedTextHash }) => {
      const model = deps.runConfig.scope.codebookModel;
      const effort: ThinkingEffort = "medium";
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
            promptVersion: SEED_CODEBOOK_PROMPT_VERSION,
            effort,
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
            effort,
            maxOutputTokens: 24_000,
            // Regeneration must ask the model again, not replay the cache;
            // its reply then replaces the cached one.
            exactCache: {
              keyVersion: SEED_CODEBOOK_PROMPT_VERSION,
              ...(regenerate ? { refresh: true } : {}),
            },
          });
        } catch (error) {
          const mapped = mapLlmFailureCode(error);
          executions.push(
            contentAddressedModelExecution({
              provider: "anthropic",
              model,
              promptId: SEED_CODEBOOK_PROMPT_ID,
              promptVersion: SEED_CODEBOOK_PROMPT_VERSION,
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
              stage: "scope",
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
            promptId: SEED_CODEBOOK_PROMPT_ID,
            promptVersion: SEED_CODEBOOK_PROMPT_VERSION,
            promptText: prompt,
            requestBody,
            responseBody: {
              role: "normalized-seed-codebook-response",
              object: result.object,
            },
            store,
            requestRole: "normalized-seed-codebook-request",
            responseRole: "normalized-seed-codebook-response",
            stage: "scope",
          }),
        );
        return result.object;
      }
    },

    tagClaim: async ({ codebook, claimText }) => {
      const model = deps.runConfig.scope.taggingModel;
      const effort: ThinkingEffort = "low";
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
          promptVersion: CODEBOOK_TAGGING_PROMPT_VERSION,
          effort,
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
          effort,
          maxOutputTokens: 4_000,
          exactCache: { keyVersion: CODEBOOK_TAGGING_PROMPT_VERSION },
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
            promptId: CODEBOOK_TAGGING_PROMPT_ID,
            promptVersion: CODEBOOK_TAGGING_PROMPT_VERSION,
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
            stage: "scope",
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
          promptId: CODEBOOK_TAGGING_PROMPT_ID,
          promptVersion: CODEBOOK_TAGGING_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody: {
            role: "normalized-codebook-tagging-response",
            object: result.object,
          },
          store,
          requestRole: "normalized-codebook-tagging-request",
          responseRole: "normalized-codebook-tagging-response",
          stage: "scope",
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
