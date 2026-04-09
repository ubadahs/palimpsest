import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type { CachePolicy } from "../../domain/types.js";
import { shortlistInputSchema } from "../../domain/types.js";
import * as openalex from "../../integrations/openalex.js";
import { resolvePaperByDoi } from "../../integrations/paper-resolver.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { createDefaultAdapters } from "../../retrieval/fulltext-fetch.js";
import { materializeParsedPaper } from "../../retrieval/parsed-paper.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import {
  runPreScreen,
  type PreScreenAdapters,
} from "../../pipeline/pre-screen.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import { writeScreenArtifacts } from "../stage-artifact-writers.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  input: string;
  output: string;
  llmGroundingModel: string | undefined;
  filterModel: string | undefined;
  filterConcurrency: number | undefined;
  skipClaimFilter: boolean;
} {
  let input: string | undefined;
  let output = "data/pre-screen";
  let llmGroundingModel: string | undefined;
  let filterModel: string | undefined;
  let filterConcurrency: number | undefined;
  let skipClaimFilter = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && i + 1 < argv.length) {
      input = argv[i + 1];
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    } else if (arg === "--llm-grounding-model" && i + 1 < argv.length) {
      llmGroundingModel = argv[i + 1]!;
      i++;
    } else if (arg === "--filter-model" && i + 1 < argv.length) {
      filterModel = argv[i + 1]!;
      i++;
    } else if (arg === "--filter-concurrency" && i + 1 < argv.length) {
      filterConcurrency = Math.max(1, parseInt(argv[i + 1]!, 10) || 10);
      i++;
    } else if (arg === "--skip-claim-filter") {
      skipClaimFilter = true;
    }
  }

  if (!input) {
    console.error("Missing required --input <path> argument");
    process.exitCode = 1;
    throw new Error("Missing --input");
  }

  return {
    input,
    output,
    llmGroundingModel,
    filterModel,
    filterConcurrency,
    skipClaimFilter,
  };
}

function buildAdapters(
  config: {
    baseUrls: {
      openAlex: string;
      semanticScholar: string;
      bioRxiv: string;
      grobid: string;
    };
    openAlexEmail: string | undefined;
    semanticScholarApiKey: string | undefined;
  },
  database: ReturnType<typeof openDatabase>,
  cachePolicy: CachePolicy,
): PreScreenAdapters {
  const fullTextAdapters = createDefaultAdapters(
    config.baseUrls.grobid,
    config.openAlexEmail,
  );
  return {
    resolveByDoi: (doi) =>
      resolvePaperByDoi(doi, {
        openAlexBaseUrl: config.baseUrls.openAlex,
        semanticScholarBaseUrl: config.baseUrls.semanticScholar,
        openAlexEmail: config.openAlexEmail,
        semanticScholarApiKey: config.semanticScholarApiKey,
      }),
    getCitingPapers: (openAlexId) =>
      openalex.getCitingWorks(
        openAlexId,
        config.baseUrls.openAlex,
        50,
        config.openAlexEmail,
      ),
    findPublishedVersion: (title, excludeId) =>
      openalex.findPublishedVersion(
        title,
        excludeId,
        config.baseUrls.openAlex,
        config.openAlexEmail,
      ),
    seedClaimGrounding: {
      materializeSeedPaper: (paper) =>
        materializeParsedPaper(
          paper,
          config.baseUrls.bioRxiv,
          fullTextAdapters,
          { db: database, cachePolicy },
        ),
    },
  };
}

export async function runPreScreenCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("screen");

  try {
    const shortlist = loadJsonArtifact(
      args.input,
      shortlistInputSchema,
      "shortlist input",
    );
    console.info(`Processing ${String(shortlist.seeds.length)} seed(s)...`);

    if (!config.anthropicApiKey?.trim()) {
      console.error(
        "screen requires ANTHROPIC_API_KEY for LLM claim grounding.",
      );
      process.exitCode = 1;
      return;
    }

    const database = openDatabase(config.databasePath);
    try {
      runMigrations(database);
      const adapters = buildAdapters(
        {
          baseUrls: config.providerBaseUrls,
          openAlexEmail: config.openAlexEmail,
          semanticScholarApiKey: config.semanticScholarApiKey,
        },
        database,
        "prefer_cache",
      );

      const { families, groundingTrace } = await runPreScreen(
        shortlist.seeds,
        adapters,
        {
          llmGrounding: {
            anthropicApiKey: config.anthropicApiKey,
            ...(args.llmGroundingModel != null
              ? { model: args.llmGroundingModel }
              : {}),
          },
          ...(args.filterModel != null || args.filterConcurrency != null
            ? {
                llmFilter: {
                  ...(args.filterModel != null
                    ? { model: args.filterModel }
                    : {}),
                  ...(args.filterConcurrency != null
                    ? { concurrency: args.filterConcurrency }
                    : {}),
                },
              }
            : {}),
          skipClaimFamilyFilter: args.skipClaimFilter,
        },
        (event) => {
          if (event.status === "running") {
            progress.startStep(event.step, {
              detail: event.detail,
              ...(event.current != null && event.total != null
                ? { current: event.current, total: event.total }
                : {}),
            });
          } else {
            progress.completeStep(event.step, {
              detail: event.detail,
              ...(event.current != null && event.total != null
                ? { current: event.current, total: event.total }
                : {}),
            });
          }
        },
      );

      const outputDir = resolve(process.cwd(), args.output);
      mkdirSync(outputDir, { recursive: true });

      const stamp = nextRunStamp(outputDir);
      const { jsonPath, mdPath, tracePath, manifestPath, traceManifestPath } =
        writeScreenArtifacts({
          outputRoot: outputDir,
          stamp,
          families,
          groundingTrace,
          sourceArtifacts: [args.input],
        });

      console.info(`\nResults written to:`);
      console.info(`  JSON: ${jsonPath}`);
      console.info(`  Markdown: ${mdPath}`);
      console.info(`  Grounding trace: ${tracePath}`);
      console.info(`  Manifest: ${manifestPath}`);
      console.info(`  Trace manifest: ${traceManifestPath}`);

      const greenlit = families.filter((r) => r.decision === "greenlight");
      const deprioritized = families.filter(
        (r) => r.decision === "deprioritize",
      );
      console.info(
        `\n${String(greenlit.length)} greenlit, ${String(deprioritized.length)} deprioritized`,
      );

      let totalInput = 0;
      let totalOutput = 0;
      let totalUsd = 0;
      for (const rec of Object.values(groundingTrace.recordsBySeedDoi)) {
        const c = rec.llmCall;
        if (!c) {
          continue;
        }
        totalInput += c.inputTokens ?? 0;
        totalOutput += c.outputTokens ?? 0;
        totalUsd += c.estimatedCostUsd ?? 0;
      }
      if (totalInput > 0 || totalOutput > 0) {
        console.info(
          `\nLLM grounding (this run): ~${totalInput.toLocaleString()} input + ~${totalOutput.toLocaleString()} output tokens; est. $${totalUsd.toFixed(4)} USD (list-price heuristic; per-seed detail in trace artifact).`,
        );
      }
    } finally {
      database.close();
    }
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
