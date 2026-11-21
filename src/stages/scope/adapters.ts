/** Scope's production adapter: seed text and grounding. */

import { inferSectionRoles } from "../../domain/section-patterns.js";
import { resolvePaperByDoi } from "../../integrations/paper-resolver.js";
import { contentAddressedExternalExecution } from "../../pipeline/provenance-store.js";
import {
  materializeLocalPdf,
  materializeParsedPaper,
  PARSED_PAPER_PARSER_VERSION,
} from "../../retrieval/parsed-paper.js";
import { sha256Text } from "../../shared/stable-identity.js";
import {
  createAdapterSession,
  createFullTextAdapters,
  mapFullTextAcquisitionFailure,
  type ProductionAdapterDeps,
} from "../production.js";
import { createScopeModelRunner } from "./model-call.js";
import {
  buildScopeGroundingPrompt,
  buildScopeInventoryPrompt,
  buildScopeStatementMatchingPrompt,
  GROUNDING_PROMPT_ID,
  GROUNDING_PROMPT_VERSION,
  INVENTORY_PROMPT_ID,
  INVENTORY_PROMPT_VERSION,
  MATCHING_PROMPT_ID,
  MATCHING_PROMPT_VERSION,
} from "./prompts.js";
import { scopeGroundingOutputSchema, type ScopeAdapters } from "./run.js";
import {
  scopeInventoryOutputSchema,
  scopeStatementMatchingOutputSchema,
} from "./statements.js";

export function buildScopeAdapters(deps: ProductionAdapterDeps) {
  const session = deps.session ?? createAdapterSession();
  const store = deps.provenanceStore;
  const fullText = deps.fullTextAdapters ?? createFullTextAdapters(deps.config);
  const seedPdfPath = deps.runConfig.scope.seedPdfPath;

  const runScopeModel = createScopeModelRunner(deps);

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

      const sourceTextHash = sha256Text(
        materializeResult.data.fullText.content,
      );
      const seedTextArtifact = store.persist({
        role: "immutable-seed-text",
        body: {
          seedId: seed.seedId,
          blocks: doc.blocks,
          sourceTextHash,
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

    groundFamily: ({ seed, family, seedText }) =>
      runScopeModel({
        purpose: "seed-grounding",
        promptId: GROUNDING_PROMPT_ID,
        promptVersion: GROUNDING_PROMPT_VERSION,
        promptParts: buildScopeGroundingPrompt({
          claim: family.claim,
          seedTitle:
            seed.resolution.status === "resolved"
              ? seed.resolution.paper.title
              : seed.doi,
          blocks: seedText.blocks,
        }),
        schema: scopeGroundingOutputSchema,
        identity: { familyId: family.familyId },
        role: "normalized-scope-grounding",
      }),

    inventorySeed: ({ seed, seedText }) =>
      runScopeModel({
        purpose: "seed-grounding",
        promptId: INVENTORY_PROMPT_ID,
        promptVersion: INVENTORY_PROMPT_VERSION,
        promptParts: buildScopeInventoryPrompt({
          seedTitle:
            seed.resolution.status === "resolved"
              ? seed.resolution.paper.title
              : seed.doi,
          blocks: seedText.blocks,
        }),
        schema: scopeInventoryOutputSchema,
        identity: {
          seedId: seed.seedId,
          seedTextArtifact: seedText.seedTextArtifact,
        },
        role: "normalized-scope-seed-inventory",
      }),

    matchStatements: ({ findings, statements }) =>
      runScopeModel({
        purpose: "seed-claim-matching",
        promptId: MATCHING_PROMPT_ID,
        promptVersion: MATCHING_PROMPT_VERSION,
        promptParts: buildScopeStatementMatchingPrompt({
          findings,
          statements,
        }),
        schema: scopeStatementMatchingOutputSchema,
        identity: {
          findingIds: findings.map((finding) => finding.findingId),
          statementIds: statements.map((statement) => statement.statementId),
        },
        role: "normalized-scope-statement-matching",
      }),
  } satisfies ScopeAdapters;
}
