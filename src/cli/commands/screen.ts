import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig, type AppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type { CachePolicy } from "../../domain/types.js";
import { shortlistInputSchema } from "../../domain/types.js";
import { groupTraceRecordsBySeedDoi } from "../../domain/pre-screen-grounding-trace.js";
import * as openalex from "../../integrations/openalex.js";
import { resolvePaperByDoi } from "../../integrations/paper-resolver.js";
import type { CitingYearRange } from "../paper-adapters.js";
import { createLLMClient } from "../../integrations/llm-client.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { createFullTextAdapters } from "../paper-adapters.js";
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
  llmGroundingThinking: boolean;
  filterModel: string | undefined;
  filterConcurrency: number | undefined;
  skipClaimFilter: boolean;
  citingYearRange: CitingYearRange | undefined;
} {
  let input: string | undefined;
  let output = "data/pre-screen";
  let llmGroundingModel: string | undefined;
  let llmGroundingThinking = true;
  let filterModel: string | undefined;
  let filterConcurrency: number | undefined;
  let skipClaimFilter = false;
  let fromYear: number | undefined;
  let toYear: number | undefined;

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
    } else if (arg === "--llm-grounding-thinking") {
      llmGroundingThinking = true;
    } else if (arg === "--no-llm-grounding-thinking") {
      llmGroundingThinking = false;
    } else if (arg === "--filter-model" && i + 1 < argv.length) {
      filterModel = argv[i + 1]!;
      i++;
    } else if (arg === "--filter-concurrency" && i + 1 < argv.length) {
      filterConcurrency = Math.max(1, parseInt(argv[i + 1]!, 10) || 10);
      i++;
    } else if (arg === "--skip-claim-filter") {
      skipClaimFilter = true;
    } else if (arg === "--from-year" && i + 1 < argv.length) {
      fromYear = parseInt(argv[i + 1]!, 10);
      i++;
    } else if (arg === "--to-year" && i + 1 < argv.length) {
      toYear = parseInt(argv[i + 1]!, 10);
      i++;
    }
  }

  if (!input) {
    console.error("Missing required --input <path> argument");
    process.exitCode = 1;
    throw new Error("Missing --input");
  }

  const citingYearRange: CitingYearRange | undefined =
    fromYear != null || toYear != null
      ? {
          ...(fromYear != null ? { fromYear } : {}),
          ...(toYear != null ? { toYear } : {}),
        }
      : undefined;

  return {
    input,
    output,
    llmGroundingModel,
    llmGroundingThinking,
    filterModel,
    filterConcurrency,
    skipClaimFilter,
    citingYearRange,
  };
}

function buildAdapters(
  config: AppConfig,
  database: ReturnType<typeof openDatabase>,
  cachePolicy: CachePolicy,
  citingYearRange?: CitingYearRange,
): PreScreenAdapters {
  const fullTextAdapters = createFullTextAdapters(config);
  return {
    resolveByDoi: (doi) =>
      resolvePaperByDoi(doi, {
        openAlexBaseUrl: config.providerBaseUrls.openAlex,
        semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
        openAlexEmail: config.openAlexEmail,
        semanticScholarApiKey: config.semanticScholarApiKey,
      }),
    getCitingPapers: (openAlexId) =>
      openalex.getCitingWorks(
        openAlexId,
        config.providerBaseUrls.openAlex,
        50,
        config.openAlexEmail,
        citingYearRange,
      ),
    findPublishedVersion: (title, excludeId) =>
      openalex.findPublishedVersion(
        title,
        excludeId,
        config.providerBaseUrls.openAlex,
        config.openAlexEmail,
      ),
    seedClaimGrounding: {
      materializeSeedPaper: (paper) =>
        materializeParsedPaper(
          paper,
          config.providerBaseUrls.bioRxiv,
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
        config,
        database,
        "prefer_cache",
        args.citingYearRange,
      );
      const sharedLlmClient = createLLMClient({
        apiKey: config.anthropicApiKey,
        defaultModel: args.llmGroundingModel ?? "claude-sonnet-4-6",
        defaultContext: { stageKey: "screen", familyIndex: 0 },
      });

      const { families, groundingTrace } = await runPreScreen(
        shortlist.seeds,
        adapters,
        {
          llmGrounding: {
            anthropicApiKey: config.anthropicApiKey,
            ...(args.llmGroundingModel != null
              ? { model: args.llmGroundingModel }
              : {}),
            useThinking: args.llmGroundingThinking,
            llmClient: sharedLlmClient,
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
                  llmClient: sharedLlmClient,
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
      for (const records of Object.values(groupTraceRecordsBySeedDoi(groundingTrace))) {
        for (const rec of records) {
          const c = rec.llmCall;
          if (!c) {
            continue;
          }
          totalInput += c.inputTokens ?? 0;
          totalOutput += c.outputTokens ?? 0;
          totalUsd += c.estimatedCostUsd ?? 0;
        }
      }
      if (totalInput > 0 || totalOutput > 0) {
        console.info(
          `\nLLM grounding (this run): ~${totalInput.toLocaleString()} input + ~${totalOutput.toLocaleString()} output tokens; est. $${totalUsd.toFixed(4)} USD (list-price heuristic; per-seed detail in trace artifact).`,
        );
      }
      const ledger = sharedLlmClient.getLedger();
      if (ledger.totalAttemptedCalls > 0) {
        console.info(
          `LLM calls recorded: ${String(ledger.totalAttemptedCalls)} attempted, ${String(ledger.totalFailedCalls)} failed.`,
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
