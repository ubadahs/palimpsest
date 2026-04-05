import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { familyClassificationResultSchema } from "../../domain/types.js";
import {
  resolvePaperByDoi,
  resolvePaperByMetadata,
} from "../../integrations/paper-resolver.js";
import { resolveCitedPaperSource } from "../../pipeline/m4-evidence.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import {
  toEvidenceJson,
  toEvidenceMarkdown,
} from "../../reporting/evidence-report.js";
import { createLocalReranker } from "../../retrieval/local-reranker.js";
import { materializeParsedPaper } from "../../retrieval/parsed-paper.js";
import { retrieveEvidence } from "../../retrieval/evidence-retrieval.js";
import { createDefaultAdapters } from "../../retrieval/fulltext-fetch.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  classificationPath: string;
  output: string;
  forceRefresh: boolean;
} {
  let classificationPath: string | undefined;
  let output = "data/m4-evidence";
  let forceRefresh = false;

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
    }
  }

  if (!classificationPath) {
    console.error(
      "Usage: m4-evidence --classification <path> [--output <dir>] [--force-refresh]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { classificationPath, output, forceRefresh };
}

export async function runM4EvidenceCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const database = openDatabase(config.databasePath);
  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("m4-evidence");

  try {
    runMigrations(database);

    const classification = loadJsonArtifact(
      args.classificationPath,
      familyClassificationResultSchema,
      "m3 classification results",
    );
    const title = classification.resolvedSeedPaperTitle;
    console.info(`M4 evidence retrieval for: ${title}`);

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
        `  Retrieved ${String(citedPaperMaterialized.citedPaperParsedDocument.blocks.length)} parsed blocks (${citedPaperMaterialized.citedPaperSource.fullTextFormat})`,
      );
    }

    progress.startStep("retrieve_candidate_evidence", {
      detail: "Searching the cited paper for supporting evidence blocks.",
    });
    const evidenceResult = await retrieveEvidence(
      classification,
      citedPaperMaterialized.citedPaperSource,
      citedPaperMaterialized.citedPaperParsedDocument,
      reranker ? { reranker } : {},
    );
    progress.completeStep("retrieve_candidate_evidence", {
      detail: `${String(evidenceResult.summary.totalTasks)} tasks searched for evidence`,
    });
    progress.startStep("rerank_and_attach_evidence", {
      detail: reranker
        ? "Reranking candidate blocks and attaching evidence spans."
        : "Attaching evidence spans from BM25-ranked blocks.",
    });
    progress.completeStep("rerank_and_attach_evidence", {
      detail: reranker
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
    const jsonPath = resolve(outputDir, `${stamp}_evidence-results.json`);
    const mdPath = resolve(outputDir, `${stamp}_evidence-report.md`);

    writeFileSync(jsonPath, toEvidenceJson(evidenceResult), "utf8");
    writeFileSync(mdPath, toEvidenceMarkdown(evidenceResult), "utf8");
    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "m4-evidence-results",
      generator: "m4-evidence",
      sourceArtifacts: [args.classificationPath],
      relatedArtifacts: [mdPath],
    });

    console.info(`\nResults written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Markdown: ${mdPath}`);
    console.info(`  Manifest: ${manifestPath}`);

    const s = evidenceResult.summary;
    console.info(
      `\n${String(s.tasksWithEvidence)}/${String(s.totalTasks)} tasks matched evidence (${String(s.totalEvidenceSpans)} spans)`,
    );
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
