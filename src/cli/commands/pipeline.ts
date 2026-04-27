import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { openDatabase } from "../../storage/database.js";
import type { DiscoveryStrategy } from "../../pipeline/discovery-stage.js";
import {
  orchestratePipelineRun,
  type PipelineCliOverrides,
} from "../../pipeline/run-orchestrator.js";
import type { CitingYearRange } from "../paper-adapters.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): PipelineCliOverrides {
  let input: string | undefined;
  let shortlist: string | undefined;
  let runId: string | undefined;
  let forceRefresh: boolean | undefined;
  let topN: number | undefined;
  let noRank: boolean | undefined;
  let targetSize: number | undefined;
  let strategy: DiscoveryStrategy | undefined;
  let discoverThinking: boolean | undefined;
  let probeBudget: number | undefined;
  let shortlistCap: number | undefined;
  let fromYear: number | undefined;
  let toYear: number | undefined;
  let screenGroundingModel: string | undefined;
  let screenGroundingThinking: boolean | undefined;
  let screenFilterModel: string | undefined;
  let screenFilterConcurrency: number | undefined;
  let seedPdfPath: string | undefined;
  let rerankModel: string | undefined;
  let rerankTopN: number | undefined;
  let familyConcurrency: number | undefined;
  let adjudicateAdvisor: boolean | undefined;
  let adjudicateFirstPassModel: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // I/O & run identity
    if (arg === "--run-id" && i + 1 < argv.length) {
      runId = argv[i + 1];
      i++;
    } else if (arg === "--input" && i + 1 < argv.length) {
      input = argv[i + 1];
      i++;
    } else if (arg === "--shortlist" && i + 1 < argv.length) {
      shortlist = argv[i + 1];
      i++;
    }
    // Discovery
    else if (arg === "--strategy" && i + 1 < argv.length) {
      const val = argv[i + 1]!;
      if (val === "attribution_first" || val === "legacy") {
        strategy = val;
      } else {
        console.error(
          `Invalid --strategy value "${val}". Use "legacy" or "attribution_first".`,
        );
        process.exitCode = 1;
        throw new Error("Invalid --strategy");
      }
      i++;
    } else if (arg === "--discover-thinking") {
      discoverThinking = true;
    } else if (arg === "--no-discover-thinking") {
      discoverThinking = false;
    } else if (arg === "--top" && i + 1 < argv.length) {
      topN = Math.max(1, parseInt(argv[i + 1]!, 10));
      i++;
    } else if (arg === "--no-rank") {
      noRank = true;
    } else if (arg === "--probe-budget" && i + 1 < argv.length) {
      probeBudget = Math.max(1, parseInt(argv[i + 1]!, 10));
      i++;
    } else if (arg === "--shortlist-cap" && i + 1 < argv.length) {
      shortlistCap = Math.max(1, parseInt(argv[i + 1]!, 10));
      i++;
    } else if (arg === "--from-year" && i + 1 < argv.length) {
      fromYear = parseInt(argv[i + 1]!, 10);
      i++;
    } else if (arg === "--to-year" && i + 1 < argv.length) {
      toYear = parseInt(argv[i + 1]!, 10);
      i++;
    }
    // Screen
    else if (arg === "--screen-grounding-model" && i + 1 < argv.length) {
      screenGroundingModel = argv[i + 1]!;
      i++;
    } else if (arg === "--screen-grounding-thinking") {
      screenGroundingThinking = true;
    } else if (arg === "--no-screen-grounding-thinking") {
      screenGroundingThinking = false;
    } else if (arg === "--screen-filter-model" && i + 1 < argv.length) {
      screenFilterModel = argv[i + 1]!;
      i++;
    } else if (arg === "--screen-filter-concurrency" && i + 1 < argv.length) {
      screenFilterConcurrency = Math.max(1, parseInt(argv[i + 1]!, 10));
      i++;
    }
    // Evidence
    else if (arg === "--seed-pdf" && i + 1 < argv.length) {
      seedPdfPath = argv[i + 1]!;
      i++;
    } else if (arg === "--rerank-model" && i + 1 < argv.length) {
      rerankModel = argv[i + 1]!;
      i++;
    } else if (arg === "--rerank-top-n" && i + 1 < argv.length) {
      rerankTopN = Math.max(1, parseInt(argv[i + 1]!, 10));
      i++;
    }
    // Curate
    else if (arg === "--target-size" && i + 1 < argv.length) {
      targetSize = Math.max(1, parseInt(argv[i + 1]!, 10));
      i++;
    }
    // Adjudicate
    else if (arg === "--advisor") {
      adjudicateAdvisor = true;
    } else if (arg === "--no-advisor") {
      adjudicateAdvisor = false;
    } else if (arg === "--advisor-first-pass-model" && i + 1 < argv.length) {
      adjudicateFirstPassModel = argv[i + 1]!;
      i++;
    }
    // Run settings
    else if (arg === "--force-refresh") {
      forceRefresh = true;
    } else if (arg === "--family-concurrency" && i + 1 < argv.length) {
      familyConcurrency = Math.max(1, parseInt(argv[i + 1]!, 10));
      i++;
    }
  }

  if (!input && !shortlist && !runId) {
    console.error(
      "Usage: pipeline --input <dois.json> | --shortlist <shortlist.json> | --run-id <uuid>",
    );
    process.exitCode = 1;
    throw new Error("Missing --input, --shortlist, or --run-id");
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
    shortlist,
    runId,
    strategy,
    discoverThinking,
    topN,
    noRank,
    probeBudget,
    shortlistCap,
    citingYearRange,
    screenGroundingModel,
    screenGroundingThinking,
    screenFilterModel,
    screenFilterConcurrency,
    seedPdfPath,
    rerankModel,
    rerankTopN,
    targetSize,
    adjudicateAdvisor,
    adjudicateFirstPassModel,
    forceRefresh,
    familyConcurrency,
  };
}

// ---------------------------------------------------------------------------
// Pipeline command
// ---------------------------------------------------------------------------

export async function runPipelineCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);

  if (!config.anthropicApiKey?.trim()) {
    console.error("pipeline requires ANTHROPIC_API_KEY.");
    process.exitCode = 1;
    return;
  }

  const database = openDatabase(config.databasePath);
  await orchestratePipelineRun({
    args,
    config,
    apiKey: config.anthropicApiKey,
    database,
  });
}
