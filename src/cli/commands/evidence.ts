import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { familyClassificationResultSchema } from "../../domain/types.js";
import {
  resolvePaperByDoi,
  resolvePaperByMetadata,
} from "../../integrations/paper-resolver.js";
import { resolveCitedPaperSource } from "../../pipeline/evidence.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { createLocalReranker } from "../../retrieval/local-reranker.js";
import { createLLMClient } from "../../integrations/llm-client.js";
import { materializeParsedPaper } from "../../retrieval/parsed-paper.js";
import { retrieveEvidence } from "../../retrieval/evidence-retrieval.js";
import {
  createDefaultAdapters,
  formatAcquisitionSummary,
} from "../../retrieval/fulltext-fetch.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import { writeEvidenceArtifacts } from "../stage-artifact-writers.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  classificationPath: string;
  output: string;
  forceRefresh: boolean;
  llmRerank: boolean;
  rerankModel: string | undefined;
  rerankTopN: number | undefined;
  rerankThinking: boolean;
} {
  let classificationPath: string | undefined;
  let output = "data/evidence";
  let forceRefresh = false;
  let llmRerank = true;
  let rerankModel: string | undefined;
  let rerankTopN: number | undefined;
  let rerankThinking = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--classification" && i + 1 < argv.length) {
      classificationPath = argv[i + 1];
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    } else if (arg === "--force-refresh") {
      forceRefresh = true;
    } else if (arg === "--no-llm-rerank") {
      llmRerank = false;
    } else if (arg === "--rerank-model" && i + 1 < argv.length) {
      rerankModel = argv[i + 1];
      i++;
    } else if (arg === "--rerank-top-n" && i + 1 < argv.length) {
      rerankTopN = Math.max(1, parseInt(argv[i + 1]!, 10) || 5);
      i++;
    } else if (arg === "--rerank-thinking") {
      rerankThinking = true;
    } else if (arg === "--no-rerank-thinking") {
      rerankThinking = false;
    }
  }

  if (!classificationPath) {
    console.error(
      "Usage: evidence --classification <path> [--output <dir>] [--force-refresh] [--no-llm-rerank] [--rerank-model <id>] [--rerank-top-n <n>] [--rerank-thinking]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return {
    classificationPath,
    output,
    forceRefresh,
    llmRerank,
    rerankModel,
    rerankTopN,
    rerankThinking,
  };
}

export async function runEvidenceCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const database = openDatabase(config.databasePath);
  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("evidence");

  try {
    runMigrations(database);

    const classification = loadJsonArtifact(
      args.classificationPath,
      familyClassificationResultSchema,
      "classification results",
    );
    const title = classification.resolvedSeedPaperTitle;
    console.info(`Evidence retrieval for: ${title}`);

    const adapters = createDefaultAdapters(
      config.providerBaseUrls.grobid,
      config.openAlexEmail,
    );
    const reranker = createLocalReranker(config.localRerankerBaseUrl);
    const citedPaperMaterialized = await resolveCitedPaperSource(
      classification,
      {
        resolveByDoi: (doi) =>
          resolvePaperByDoi(doi, {
            openAlexBaseUrl: config.providerBaseUrls.openAlex,
            semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
            openAlexEmail: config.openAlexEmail,
            semanticScholarApiKey: config.semanticScholarApiKey,
          }),
        resolveByMetadata: (locator) =>
          resolvePaperByMetadata(locator, {
            openAlexBaseUrl: config.providerBaseUrls.openAlex,
            semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
            openAlexEmail: config.openAlexEmail,
            semanticScholarApiKey: config.semanticScholarApiKey,
          }),
        materializeParsedPaper: (paper) =>
          materializeParsedPaper(
            paper,
            config.providerBaseUrls.bioRxiv,
            adapters,
            {
              db: database,
              cachePolicy: args.forceRefresh ? "force_refresh" : "prefer_cache",
            },
          ),
      },
      (event) => {
        if (event.status === "running") {
          progress.startStep(event.step, {
            ...(event.detail ? { detail: event.detail } : {}),
          });
        } else {
          progress.completeStep(event.step, {
            ...(event.detail ? { detail: event.detail } : {}),
          });
        }
      },
    );

    if (
      citedPaperMaterialized.citedPaperSource.resolutionStatus !== "resolved"
    ) {
      console.info(
        `  Could not resolve cited paper: ${citedPaperMaterialized.citedPaperSource.resolutionError ?? "unknown error"}`,
      );
    } else if (
      citedPaperMaterialized.citedPaperSource.fetchStatus !== "retrieved"
    ) {
      console.info(
        `  Cited paper full text unavailable: ${citedPaperMaterialized.citedPaperSource.fetchError ?? citedPaperMaterialized.citedPaperSource.fetchStatus}`,
      );
    } else if (citedPaperMaterialized.citedPaperParsedDocument) {
      console.info(
        `  Retrieved ${String(citedPaperMaterialized.citedPaperParsedDocument.blocks.length)} parsed blocks (${citedPaperMaterialized.citedPaperSource.fullTextFormat}) via ${formatAcquisitionSummary(citedPaperMaterialized.citedPaperSource.acquisition)}`,
      );
    }

    const rerankModelId = args.rerankModel ?? "claude-haiku-4-5";
    const llmClient =
      args.llmRerank && config.anthropicApiKey
        ? createLLMClient({
            apiKey: config.anthropicApiKey,
            defaultModel: rerankModelId,
          })
        : undefined;

    const rerankMethod = llmClient ? "llm" : reranker ? "local" : "bm25";

    progress.startStep("retrieve_candidate_evidence", {
      detail: "Searching the cited paper for supporting evidence blocks.",
    });
    const evidenceResult = await retrieveEvidence(
      classification,
      citedPaperMaterialized.citedPaperSource,
      citedPaperMaterialized.citedPaperParsedDocument,
      {
        ...(reranker ? { reranker } : {}),
        ...(llmClient
          ? {
              llmClient,
              llmRerankerOptions: {
                model: rerankModelId,
                useThinking: args.rerankThinking,
                ...(args.rerankTopN != null ? { topN: args.rerankTopN } : {}),
              },
            }
          : {}),
      },
    );
    progress.completeStep("retrieve_candidate_evidence", {
      detail: `${String(evidenceResult.summary.totalTasks)} tasks searched for evidence`,
    });
    progress.startStep("rerank_and_attach_evidence", {
      detail:
        rerankMethod === "llm"
          ? "LLM-reranking candidate blocks with sentence extraction."
          : rerankMethod === "local"
            ? "Reranking candidate blocks and attaching evidence spans."
            : "Attaching evidence spans from BM25-ranked blocks.",
    });
    progress.completeStep("rerank_and_attach_evidence", {
      detail:
        rerankMethod === "llm"
          ? `${String(evidenceResult.summary.tasksWithEvidence)} tasks received LLM-reranked evidence`
          : rerankMethod === "local"
            ? `${String(evidenceResult.summary.tasksWithEvidence)} tasks received reranked evidence`
            : `${String(evidenceResult.summary.tasksWithEvidence)} tasks received BM25 evidence`,
    });
    progress.startStep("summarize_grounded_coverage", {
      detail: "Summarizing grounded evidence coverage.",
    });
    progress.completeStep("summarize_grounded_coverage", {
      detail: `${String(evidenceResult.summary.tasksWithEvidence)}/${String(evidenceResult.summary.totalTasks)} tasks matched evidence`,
    });

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const { jsonPath, mdPath, manifestPath } = writeEvidenceArtifacts({
      outputRoot: outputDir,
      stamp,
      result: evidenceResult,
      sourceArtifacts: [args.classificationPath],
    });

    console.info(`\nResults written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Markdown: ${mdPath}`);
    console.info(`  Manifest: ${manifestPath}`);

    const s = evidenceResult.summary;
    console.info(
      `\n${String(s.tasksWithEvidence)}/${String(s.totalTasks)} tasks matched evidence (${String(s.totalEvidenceSpans)} spans)`,
    );

    if (llmClient) {
      const ledger = llmClient.getLedger();
      const rerankSummary = ledger.byPurpose["evidence-rerank"];
      if (rerankSummary) {
        console.info(
          `  LLM reranking (${rerankModelId}${args.rerankThinking ? "+thinking" : ""}): ${String(rerankSummary.calls)} calls, ~$${rerankSummary.estimatedCostUsd.toFixed(4)} estimated cost`,
        );
      }
    }
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
