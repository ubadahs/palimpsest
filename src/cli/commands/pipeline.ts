import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { CANONICAL_RUN_CONFIG_DEFAULTS } from "../../contract/run-types.js";
import { compareStageKeys, stageKeyValues } from "../../contract/stages.js";
import type { StageKey } from "../../contract/run-types.js";
import type { CanonicalPipelineCliOverrides } from "../../pipeline/canonical-executor.js";
import { openDatabase } from "../../storage/database.js";

const canonicalStages = new Set<string>(stageKeyValues);

function fail(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${flag}.`);
  }
  return value;
}

function readPositiveInteger(
  argv: string[],
  index: number,
  flag: string,
): number {
  const value = readValue(argv, index, flag);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${flag} must be a positive integer; received "${value}".`);
  }
  return parsed;
}

function readYear(argv: string[], index: number, flag: string): number {
  const value = readValue(argv, index, flag);
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    fail(`${flag} must be an integer year; received "${value}".`);
  }
  return parsed;
}

function readCanonicalStage(
  argv: string[],
  index: number,
  flag: string,
): StageKey {
  const value = readValue(argv, index, flag);
  if (!canonicalStages.has(value)) {
    fail(
      `Invalid ${flag} stage "${value}". Canonical stages: ${stageKeyValues.join(", ")}.`,
    );
  }
  return value as StageKey;
}

export function parseCanonicalPipelineArgs(
  argv: string[],
): CanonicalPipelineCliOverrides {
  let input: string | undefined;
  let runId: string | undefined;
  let seedPdfPath: string | undefined;
  let forceRefresh: boolean | undefined;
  let stopAfterStage: StageKey | undefined;
  let discoverNeighborhoodLimit: number | undefined;
  let discoverProbeBudget: number | undefined;
  let discoverMinFamilies: number | undefined;
  let discoverMaxFamilies: number | undefined;
  let discoverMaxPreparedRecords: number | undefined;
  let discoverFromYear: number | undefined;
  let discoverToYear: number | undefined;
  let discoverExtractionModel: string | undefined;
  let discoverExtractionThinking: boolean | undefined;
  let scopeGroundingModel: string | undefined;
  let scopeGroundingThinking: boolean | undefined;
  let evidenceRerankEnabled: boolean | undefined;
  let evidenceRerankModel: string | undefined;
  let evidenceRerankTopN: number | undefined;
  let evidenceBm25CandidateLimit: number | undefined;
  let evidenceSelectionLimit: number | undefined;
  let adjudicateModel: string | undefined;
  let adjudicateThinking: boolean | undefined;
  let rerunFromStage: StageKey | undefined;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;

    switch (flag) {
      case "--input":
        input = readValue(argv, index, flag);
        index++;
        break;
      case "--run-id":
        runId = readValue(argv, index, flag);
        index++;
        break;
      case "--seed-pdf":
        seedPdfPath = readValue(argv, index, flag);
        index++;
        break;
      case "--force-refresh":
        forceRefresh = true;
        break;
      case "--stop-after":
        stopAfterStage = readCanonicalStage(argv, index, flag);
        index++;
        break;
      case "--neighborhood-limit":
        discoverNeighborhoodLimit = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--probe-budget":
        discoverProbeBudget = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--min-families":
        discoverMinFamilies = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--max-families":
        discoverMaxFamilies = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--max-prepared-records":
        discoverMaxPreparedRecords = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--from-year":
        discoverFromYear = readYear(argv, index, flag);
        index++;
        break;
      case "--to-year":
        discoverToYear = readYear(argv, index, flag);
        index++;
        break;
      case "--extraction-model":
        discoverExtractionModel = readValue(argv, index, flag);
        index++;
        break;
      case "--extraction-thinking":
        discoverExtractionThinking = true;
        break;
      case "--no-extraction-thinking":
        discoverExtractionThinking = false;
        break;
      case "--grounding-model":
        scopeGroundingModel = readValue(argv, index, flag);
        index++;
        break;
      case "--grounding-thinking":
        scopeGroundingThinking = true;
        break;
      case "--no-grounding-thinking":
        scopeGroundingThinking = false;
        break;
      case "--rerank":
        evidenceRerankEnabled = true;
        break;
      case "--no-rerank":
        evidenceRerankEnabled = false;
        break;
      case "--rerank-model":
        evidenceRerankModel = readValue(argv, index, flag);
        index++;
        break;
      case "--rerank-top-n":
        evidenceRerankTopN = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--bm25-candidate-limit":
        evidenceBm25CandidateLimit = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--evidence-selection-limit":
        evidenceSelectionLimit = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--adjudicate-model":
        adjudicateModel = readValue(argv, index, flag);
        index++;
        break;
      case "--adjudicate-thinking":
        adjudicateThinking = true;
        break;
      case "--no-adjudicate-thinking":
        adjudicateThinking = false;
        break;
      case "--rerun-from":
        rerunFromStage = readCanonicalStage(argv, index, flag);
        index++;
        break;
      default:
        fail(
          `Unknown pipeline flag: ${flag}. Run "pipeline --help" for canonical options.`,
        );
    }
  }

  if (input && runId) {
    fail(
      "Pass either --input (fresh DOI-first run) or --run-id (resume), not both.",
    );
  }
  if (!input && !runId) {
    fail(
      "A fresh canonical pipeline run requires --input <dois.json> (DOI-first); use --run-id <uuid> to resume.",
    );
  }
  if (input && rerunFromStage) {
    fail("--rerun-from is only valid with --run-id.");
  }
  if (
    rerunFromStage &&
    stopAfterStage &&
    compareStageKeys(rerunFromStage, stopAfterStage) > 0
  ) {
    fail(
      `--rerun-from ${rerunFromStage} cannot be later than --stop-after ${stopAfterStage}.`,
    );
  }

  return {
    input,
    runId,
    seedPdfPath,
    forceRefresh,
    stopAfterStage,
    discoverNeighborhoodLimit,
    discoverProbeBudget,
    discoverMinFamilies,
    discoverMaxFamilies,
    discoverMaxPreparedRecords,
    discoverFromYear,
    discoverToYear,
    discoverExtractionModel,
    discoverExtractionThinking,
    scopeGroundingModel,
    scopeGroundingThinking,
    evidenceRerankEnabled,
    evidenceRerankModel,
    evidenceRerankTopN,
    evidenceBm25CandidateLimit,
    evidenceSelectionLimit,
    adjudicateModel,
    adjudicateThinking,
    rerunFromStage,
  };
}

function printCanonicalPipelineHelp(): void {
  console.info(`Usage: pipeline --input <dois.json> [options]
       pipeline --run-id <uuid> [options]

Run the canonical six-stage pipeline:
  discover → scope → prepare → evidence → adjudicate → report

Fresh runs require DOI-first input: { "dois": ["10.xxxx/example"] }.

Options:
  --input <path>                    DOI input JSON for a fresh run
  --run-id <uuid>                   Resume an existing canonical run
  --seed-pdf <path>                 Local seed PDF (single-DOI runs only)
  --force-refresh                   Refresh provider-derived inputs
  --stop-after <stage>              discover, scope, prepare, evidence, adjudicate, or report
  --neighborhood-limit <n>          Total citing-work observation cap (across paginated requests)
  --probe-budget <n>                Discover citing-paper probe budget (default ${CANONICAL_RUN_CONFIG_DEFAULTS.discover.probeBudget})
  --min-families <n>                Adaptive portfolio minimum families (default ${CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection.minFamilies})
  --max-families <n>                Adaptive portfolio maximum families (default ${CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection.maxFamilies})
  --max-prepared-records <n>        Prepared-record budget for portfolio (default ${CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection.maxPreparedRecords})
  --from-year <year>                Earliest citing-paper year
  --to-year <year>                  Latest citing-paper year
  --extraction-model <model>        Discover attributed-claim extraction model
  --extraction-thinking             Enable extraction thinking
  --no-extraction-thinking          Disable extraction thinking
  --grounding-model <model>         Scope grounding model
  --grounding-thinking              Enable grounding thinking
  --no-grounding-thinking           Disable grounding thinking
  --rerank / --no-rerank            Enable or disable Evidence reranking
  --rerank-model <model>            Evidence reranking model
  --rerank-top-n <n>                Evidence reranking candidate count
  --bm25-candidate-limit <n>        Evidence BM25 candidates per query
  --evidence-selection-limit <n>    Final evidence passages per record
  --adjudicate-model <model>        Adjudication model
  --adjudicate-thinking             Enable adjudication thinking
  --no-adjudicate-thinking          Disable adjudication thinking
  --rerun-from <stage>              Rerun a canonical stage and downstream stages`);
}

export async function runPipelineCommand(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    printCanonicalPipelineHelp();
    return;
  }

  const args = parseCanonicalPipelineArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);

  const database = openDatabase(config.databasePath);
  const { orchestrateCanonicalPipelineRun } =
    await import("../../pipeline/canonical-executor.js");
  await orchestrateCanonicalPipelineRun({
    args,
    config,
    apiKey: config.anthropicApiKey,
    database,
    ownsDatabase: true,
  });
}
