import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type {
  CachePolicy,
  EdgeClassification,
  PreScreenEdge,
  ResolvedPaper,
  Result,
  TaskWithEvidence,
} from "../../domain/types.js";
import {
  claimFamilyBlocksDownstream,
  preScreenResultsSchema,
  shortlistInputSchema,
} from "../../domain/types.js";
import { discoveryInputSchema } from "../../domain/discovery.js";
import {
  resolvePaperByDoi,
  resolvePaperByMetadata,
} from "../../integrations/paper-resolver.js";
import {
  createLLMClient,
  createLLMTelemetryCollector,
  isFatalProviderError,
} from "../../integrations/llm-client.js";
import * as openalex from "../../integrations/openalex.js";
import { buildPaperAdapters, type CitingYearRange } from "../paper-adapters.js";
import { discoverClaims } from "../../pipeline/claim-discovery.js";
import { rankClaimsByEngagement } from "../../pipeline/claim-ranking.js";
import {
  runPreScreen,
  runPreScreenFromHandoff,
  type PreScreenAdapters,
} from "../../pipeline/pre-screen.js";
import {
  runDiscoveryStage,
  type DiscoverySeedEntry,
  type DiscoveryStrategy,
} from "../../pipeline/discovery-stage.js";
import {
  type DiscoveryHandoffMap,
  serializeHandoffMap,
  deserializeHandoffMap,
} from "../../domain/discovery-handoff.js";
import { runM2Extraction } from "../../pipeline/extract.js";
import { buildPackets } from "../../classification/build-packets.js";
import { resolveCitedPaperSource } from "../../pipeline/evidence.js";
import { retrieveEvidence } from "../../retrieval/evidence-retrieval.js";
import { sampleAuditSet } from "../../adjudication/sample-audit.js";
import { adjudicateAuditSample } from "../../adjudication/llm-adjudicator.js";
import { createFullTextAdapters } from "../paper-adapters.js";
import {
  materializeParsedPaper,
  materializeLocalPdf,
} from "../../retrieval/parsed-paper.js";
import { createLocalReranker } from "../../retrieval/local-reranker.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import {
  createAnalysisRun,
  ensureFamilyStageRow,
  getAnalysisRun,
  setRunStatus,
} from "../../storage/analysis-runs.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import { resolveStageOutputDir } from "../stage-output.js";
import {
  writeAdjudicationArtifacts,
  writeAttributionDiscoveryArtifacts,
  writeAuditSampleArtifacts,
  writeClassificationArtifacts,
  writeDiscoveryArtifacts,
  writeEvidenceArtifacts,
  writeExtractionArtifacts,
  writeScreenArtifacts,
} from "../stage-artifact-writers.js";
import { nextRunStampFromDirectories } from "../run-stamp.js";
import { stageDefinitions } from "../../contract/stages.js";
import {
  analysisRunConfigSchema,
  type StageKey,
} from "../../contract/run-types.js";
import { pMap } from "../../shared/p-map.js";
import { RunTracker } from "../../pipeline/run-tracker.js";
import { summarizeLedgerByStage } from "../../pipeline/cost-summary.js";
import { createStageReporter, log } from "../stage-reporter.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

/**
 * Parsed CLI overrides. Every field is optional — the schema default in
 * `analysisRunConfigSchema` is the single source of truth. The CLI parser
 * only sets a value when the user explicitly passes a flag.
 */
type PipelineCliOverrides = {
  // I/O & run identity
  input: string | undefined;
  shortlist: string | undefined;
  runId: string | undefined;
  // Discovery
  strategy: DiscoveryStrategy | undefined;
  discoverThinking: boolean | undefined;
  topN: number | undefined;
  noRank: boolean | undefined;
  probeBudget: number | undefined;
  shortlistCap: number | undefined;
  citingYearRange: CitingYearRange | undefined;
  // Screen
  screenGroundingModel: string | undefined;
  screenGroundingThinking: boolean | undefined;
  screenFilterModel: string | undefined;
  screenFilterConcurrency: number | undefined;
  // Evidence
  seedPdfPath: string | undefined;
  rerankModel: string | undefined;
  rerankTopN: number | undefined;
  // Curate
  targetSize: number | undefined;
  // Adjudicate
  adjudicateAdvisor: boolean | undefined;
  adjudicateFirstPassModel: string | undefined;
  // Run settings
  forceRefresh: boolean | undefined;
  familyConcurrency: number | undefined;
};

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
  const apiKey: string = config.anthropicApiKey;

  const database = openDatabase(config.databasePath);

  // --- Resolve run identity -------------------------------------------------
  runMigrations(database);
  const existingRun = args.runId
    ? getAnalysisRun(database, args.runId)
    : undefined;
  if (args.runId && !existingRun) {
    console.error(`Run not found: ${args.runId}`);
    process.exitCode = 1;
    database.close();
    return;
  }
  const runId = existingRun?.id ?? randomUUID();
  const tracker = new RunTracker(database, runId);
  let writeCostSummary = (): void => {};

  const handleSignal = (): void => tracker.handleSignal();
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // --- Build run config ------------------------------------------------------
  // CLI overrides are only included when the user explicitly passed a flag.
  // Everything else falls through to the schema defaults in
  // analysisRunConfigSchema — the single source of truth for defaults.
  const cliOverrides: Record<string, unknown> = {};
  if (args.strategy != null) cliOverrides["discoverStrategy"] = args.strategy;
  if (args.topN != null) cliOverrides["discoverTopN"] = args.topN;
  if (args.noRank != null) cliOverrides["discoverRank"] = !args.noRank;
  if (args.discoverThinking != null)
    cliOverrides["discoverThinking"] = args.discoverThinking;
  if (args.probeBudget != null)
    cliOverrides["discoverProbeBudget"] = args.probeBudget;
  if (args.shortlistCap != null)
    cliOverrides["discoverShortlistCap"] = args.shortlistCap;
  if (args.citingYearRange?.fromYear != null)
    cliOverrides["discoverFromYear"] = args.citingYearRange.fromYear;
  if (args.citingYearRange?.toYear != null)
    cliOverrides["discoverToYear"] = args.citingYearRange.toYear;
  if (args.screenGroundingModel != null)
    cliOverrides["screenGroundingModel"] = args.screenGroundingModel;
  if (args.screenGroundingThinking != null)
    cliOverrides["screenGroundingThinking"] = args.screenGroundingThinking;
  if (args.screenFilterModel != null)
    cliOverrides["screenFilterModel"] = args.screenFilterModel;
  if (args.screenFilterConcurrency != null)
    cliOverrides["screenFilterConcurrency"] = args.screenFilterConcurrency;
  if (args.rerankModel != null)
    cliOverrides["evidenceRerankModel"] = args.rerankModel;
  if (args.rerankTopN != null)
    cliOverrides["evidenceRerankTopN"] = args.rerankTopN;
  if (args.targetSize != null)
    cliOverrides["curateTargetSize"] = args.targetSize;
  if (args.adjudicateAdvisor != null)
    cliOverrides["adjudicateAdvisor"] = args.adjudicateAdvisor;
  if (args.adjudicateFirstPassModel != null)
    cliOverrides["adjudicateFirstPassModel"] = args.adjudicateFirstPassModel;
  if (args.familyConcurrency != null)
    cliOverrides["familyConcurrency"] = args.familyConcurrency;
  if (args.seedPdfPath != null) cliOverrides["seedPdfPath"] = args.seedPdfPath;
  if (args.forceRefresh != null)
    cliOverrides["forceRefresh"] = args.forceRefresh;

  const runConfig = existingRun
    ? existingRun.config
    : analysisRunConfigSchema.parse(cliOverrides);

  const citingYearRange: CitingYearRange | undefined =
    runConfig.discoverFromYear != null || runConfig.discoverToYear != null
      ? {
          ...(runConfig.discoverFromYear != null
            ? { fromYear: runConfig.discoverFromYear }
            : {}),
          ...(runConfig.discoverToYear != null
            ? { toYear: runConfig.discoverToYear }
            : {}),
        }
      : undefined;

  try {
    const cachePolicy: CachePolicy = runConfig.forceRefresh
      ? "force_refresh"
      : "prefer_cache";
    const fullTextAdapters = createFullTextAdapters(config);

    // --- Output directory: data/runs/{runId}/ --------------------------------
    const outputDir = existingRun
      ? resolve(existingRun.runRoot)
      : resolve(process.cwd(), "data", "runs", runId);
    if (!existingRun) {
      mkdirSync(resolve(outputDir, "inputs"), { recursive: true });
      mkdirSync(resolve(outputDir, "logs"), { recursive: true });
      for (const stage of stageDefinitions) {
        mkdirSync(resolve(outputDir, stage.directoryName), { recursive: true });
      }
    }

    const stamp = nextRunStampFromDirectories([
      outputDir,
      ...stageDefinitions.map((stage) =>
        resolveStageOutputDir(outputDir, stage.key),
      ),
    ]);
    const telemetryCollector = createLLMTelemetryCollector();
    let fatalProviderFailure:
      | {
          message: string;
          stageKey: StageKey;
          familyIndex: number;
        }
      | undefined;
    writeCostSummary = (): void => {
      const summary = summarizeLedgerByStage(telemetryCollector.getLedger());
      writeFileSync(
        resolve(outputDir, `${stamp}_run-cost.json`),
        JSON.stringify(summary, null, 2),
      );
    };

    // -----------------------------------------------------------------------
    // Resolve input files. For --run-id, inputs are in the run directory.
    // For direct CLI, resolve from args and create the run row.
    // -----------------------------------------------------------------------

    const inputFile = existingRun
      ? resolve(outputDir, "inputs", "dois.json")
      : args.input;
    const shortlistFile = existingRun
      ? resolve(outputDir, "inputs", "shortlist.json")
      : args.shortlist;

    // Determine if this is a shortlist-based run (discover skipped)
    const hasTrackedClaim = existingRun
      ? existingRun.trackedClaim != null
      : args.shortlist != null;

    // Create DB row for fresh CLI runs (existingRun already has one)
    if (!existingRun) {
      if (hasTrackedClaim && shortlistFile) {
        const loaded = loadJsonArtifact(
          shortlistFile,
          shortlistInputSchema,
          "shortlist input",
        );
        if (loaded.seeds[0]) {
          createAnalysisRun(database, {
            id: runId,
            seedDoi: loaded.seeds[0].doi,
            trackedClaim: loaded.seeds[0].trackedClaim,
            targetStage: runConfig.stopAfterStage,
            runRoot: outputDir,
            config: runConfig,
          });
        }
      } else if (inputFile) {
        const inputData = loadJsonArtifact(
          inputFile,
          discoveryInputSchema,
          "discovery input",
        );
        if (inputData.dois[0]) {
          createAnalysisRun(database, {
            id: runId,
            seedDoi: inputData.dois[0],
            targetStage: runConfig.stopAfterStage,
            runRoot: outputDir,
            config: runConfig,
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Stage 1: Discover (or load shortlist / skip if succeeded)
    // -----------------------------------------------------------------------

    let seeds: DiscoverySeedEntry[];
    let screenInputArtifactPath: string | undefined;
    // Rich handoff from attribution-first discovery.
    // Serialized to disk after discovery; deserialized on --run-id resume.
    let discoveryHandoffs: DiscoveryHandoffMap | undefined;

    if (tracker.succeededArtifact("discover", Boolean(existingRun))) {
      // Resume: shortlist was written by prior discover run
      const slFile = resolve(outputDir, "inputs", "shortlist.json");
      const loaded = loadJsonArtifact(
        slFile,
        shortlistInputSchema,
        "shortlist input",
      );
      seeds = loaded.seeds;
      // Attempt to restore serialized handoffs for thin screen path on resume.
      const handoffPath = resolve(outputDir, "inputs", "discovery-handoffs.json");
      if (existsSync(handoffPath)) {
        try {
          discoveryHandoffs = deserializeHandoffMap(
            readFileSync(handoffPath, "utf8"),
          );
          log(
            "discover",
            `Restored discovery handoffs (${String(discoveryHandoffs.size)} seed(s))`,
          );
        } catch {
          log(
            "discover",
            "Could not restore discovery handoffs — screen will use full path",
          );
        }
      }
      log(
        "discover",
        `Skipped (already succeeded) — ${String(seeds.length)} seed(s)`,
      );
    } else if (hasTrackedClaim) {
      const slFile =
        shortlistFile ?? resolve(outputDir, "inputs", "shortlist.json");
      log("discover", `Loading shortlist from ${slFile}`);
      const loaded = loadJsonArtifact(
        slFile,
        shortlistInputSchema,
        "shortlist input",
      );
      seeds = loaded.seeds;
      log("discover", `${String(seeds.length)} seed(s) loaded`);
    } else {
      const doisPath = inputFile!;
      const inputData = loadJsonArtifact(
        doisPath,
        discoveryInputSchema,
        "discovery input",
      );
      const strategy = runConfig.discoverStrategy;
      const strategyLabel =
        strategy === "attribution_first" ? "attribution-first" : "legacy";
      const discoverReporter = createStageReporter("discover", outputDir);
      discoverReporter.log(
        `Discovering from ${String(inputData.dois.length)} paper(s) [${strategyLabel}]...`,
      );
      tracker.stageStart("discover", 0, discoverReporter.logPath);

      const discoveryClient = createLLMClient({
        apiKey,
        defaultModel: runConfig.discoverModel,
        collector: telemetryCollector,
        defaultContext: { stageKey: "discover", familyIndex: 0 },
        database,
        forceRefresh: runConfig.forceRefresh,
      });

      const basePaperAdapters = buildPaperAdapters({
        resolverConfig: {
          openAlexBaseUrl: config.providerBaseUrls.openAlex,
          semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
          openAlexEmail: config.openAlexEmail,
          semanticScholarApiKey: config.semanticScholarApiKey,
        },
        biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
        openAlexBaseUrl: config.providerBaseUrls.openAlex,
        openAlexEmail: config.openAlexEmail,
        fullTextAdapters,
        cache: { db: database, cachePolicy },
        ...(citingYearRange != null ? { citingYearRange } : {}),
      });
      const paperAdapters = runConfig.seedPdfPath
        ? {
            ...basePaperAdapters,
            materializeParsedPaper: () =>
              materializeLocalPdf(runConfig.seedPdfPath!, fullTextAdapters),
          }
        : basePaperAdapters;

      const discoveryStage = await runDiscoveryStage(
        {
          dois: inputData.dois,
          topN: runConfig.discoverTopN,
          rank: runConfig.discoverRank,
          strategy,
          ...(strategy === "attribution_first"
            ? {
                attributionAdapters: {
                  ...paperAdapters,
                  mentionHarvest: {
                    fullText: fullTextAdapters,
                    biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
                    cache: { db: database, cachePolicy },
                  },
                  llmClient: discoveryClient,
                  groundingOptions: {
                    apiKey,
                    llmClient: discoveryClient,
                    model: runConfig.discoverModel,
                    useThinking: runConfig.discoverThinking,
                    enableExactCache: true,
                  },
                },
                attributionOptions: {
                  probeBudget: runConfig.discoverProbeBudget,
                  shortlistCap: runConfig.discoverShortlistCap,
                  extractionModel: runConfig.discoverModel,
                  extractionThinking: runConfig.discoverThinking,
                },
              }
            : {}),
        },
        {
          ...paperAdapters,
          discoverClaims: (paper, parsedDocument) =>
            discoverClaims({
              paper,
              parsedDocument,
              client: discoveryClient,
              options: {
                model: runConfig.discoverModel,
                useThinking: runConfig.discoverThinking,
              },
            }),
          rankClaimsByEngagement: (
            seedTitle,
            claims,
            citingPapers,
            onProgress,
          ) =>
            rankClaimsByEngagement({
              seedTitle,
              claims,
              citingPapers,
              client: discoveryClient,
              options: { model: runConfig.discoverModel },
              ...(onProgress ? { onProgress } : {}),
            }),
        },
        discoverReporter.onProgress,
      );
      seeds = discoveryStage.seeds;
      // Capture the rich handoff for use by thin screen and mention-reuse in extract.
      discoveryHandoffs = discoveryStage.handoffs;
      // Persist handoffs so --run-id resume can use the thin screen path.
      if (discoveryHandoffs && discoveryHandoffs.size > 0) {
        const handoffPath = resolve(outputDir, "inputs", "discovery-handoffs.json");
        mkdirSync(resolve(outputDir, "inputs"), { recursive: true });
        writeFileSync(handoffPath, serializeHandoffMap(discoveryHandoffs), "utf8");
      }

      let shortlistPath: string;
      let discoverPrimaryPath: string;
      if (
        strategy === "attribution_first" &&
        discoveryStage.attributionDiscovery
      ) {
        const artifacts = writeAttributionDiscoveryArtifacts({
          outputRoot: outputDir,
          stamp,
          results: discoveryStage.attributionDiscovery,
          seeds: discoveryStage.seeds,
          sourceArtifacts: [doisPath],
        });
        shortlistPath = artifacts.shortlistPath;
        discoverPrimaryPath = artifacts.jsonPath;
      } else {
        const artifacts = writeDiscoveryArtifacts({
          outputRoot: outputDir,
          stamp,
          results: discoveryStage.results,
          seeds: discoveryStage.seeds,
          sourceArtifacts: [doisPath],
        });
        shortlistPath = artifacts.shortlistPath;
        discoverPrimaryPath = artifacts.jsonPath;
      }
      screenInputArtifactPath = shortlistPath;
      tracker.stageSuccess("discover", 0, {
        primaryArtifactPath: discoverPrimaryPath,
      });

      const discoveryLedger = discoveryClient.getLedger();
      discoverReporter.log(
        `Done. ${String(seeds.length)} seeds. LLM: ${discoveryLedger.totalAttemptedCalls} attempted, ${discoveryLedger.totalFailedCalls} failed, ~$${discoveryLedger.totalEstimatedCostUsd.toFixed(4)}`,
      );
    }

    if (seeds.length === 0) {
      setRunStatus(database, runId, "succeeded", "discover");
      log("pipeline", "No seeds to process. Exiting.");
      return;
    }

    if (runConfig.stopAfterStage === "discover") {
      setRunStatus(database, runId, "succeeded", "discover");
      log("pipeline", "Stopping after discover (stopAfterStage).");
      return;
    }

    // -----------------------------------------------------------------------
    // Stage 2: Screen
    // -----------------------------------------------------------------------

    let screenJsonPath: string;
    const existingScreenArtifact = tracker.succeededArtifact("screen", Boolean(existingRun));

    if (existingScreenArtifact) {
      screenJsonPath = existingScreenArtifact;
      log("screen", "Skipped (already succeeded)");
    } else {
      const screenReporter = createStageReporter("screen", outputDir);
      screenReporter.log(`Pre-screening ${String(seeds.length)} seed(s)...`);
      tracker.stageStart("screen", 0, screenReporter.logPath);

      let screenedFamilies: Awaited<
        ReturnType<typeof runPreScreen>
      >["families"];
      let groundingTrace: Awaited<
        ReturnType<typeof runPreScreen>
      >["groundingTrace"];

      if (
        runConfig.discoverStrategy === "attribution_first" &&
        discoveryHandoffs &&
        discoveryHandoffs.size > 0
      ) {
        // Attribution-first with fresh or restored handoff: skip re-resolution,
        // re-fetch, and re-grounding. Only auditability + decision logic runs.
        screenReporter.log("Using discovery handoff (thin screen path).");
        ({ families: screenedFamilies, groundingTrace } =
          await runPreScreenFromHandoff(
            seeds,
            discoveryHandoffs,
            {},
            screenReporter.onProgress,
          ));
      } else {
        // Legacy strategy or missing/unreadable handoff: full screen path.
        const preScreenAdapters: PreScreenAdapters = {
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
              runConfig.seedPdfPath
                ? materializeLocalPdf(runConfig.seedPdfPath, fullTextAdapters)
                : materializeParsedPaper(
                    paper,
                    config.providerBaseUrls.bioRxiv,
                    fullTextAdapters,
                    { db: database, cachePolicy },
                  ),
          },
        };

        ({ families: screenedFamilies, groundingTrace } = await runPreScreen(
          seeds,
          preScreenAdapters,
          {
            llmGrounding: {
              anthropicApiKey: apiKey,
              model: runConfig.screenGroundingModel,
              useThinking: runConfig.screenGroundingThinking,
              enableExactCache: true,
              llmClient: createLLMClient({
                apiKey,
                defaultModel: runConfig.screenGroundingModel,
                collector: telemetryCollector,
                defaultContext: { stageKey: "screen", familyIndex: 0 },
                database,
                forceRefresh: runConfig.forceRefresh,
              }),
            },
            llmFilter: {
              model: runConfig.screenFilterModel,
              concurrency: runConfig.screenFilterConcurrency,
              llmClient: createLLMClient({
                apiKey,
                defaultModel: runConfig.screenFilterModel,
                collector: telemetryCollector,
                defaultContext: { stageKey: "screen", familyIndex: 0 },
                database,
                forceRefresh: runConfig.forceRefresh,
              }),
            },
            skipClaimFamilyFilter:
              runConfig.discoverStrategy === "attribution_first",
          },
          screenReporter.onProgress,
        ));
      }

      const screenArtifacts = writeScreenArtifacts({
        outputRoot: outputDir,
        stamp,
        families: screenedFamilies,
        groundingTrace,
        sourceArtifacts: screenInputArtifactPath
          ? [screenInputArtifactPath]
          : [],
      });
      screenJsonPath = screenArtifacts.jsonPath;
      tracker.stageSuccess("screen", 0, {
        primaryArtifactPath: screenJsonPath,
        ...(screenInputArtifactPath != null
          ? { inputArtifactPath: screenInputArtifactPath }
          : {}),
      });

      const greenlit = screenedFamilies.filter(
        (f) => f.decision === "greenlight",
      );
      const blocked = screenedFamilies.filter((f) =>
        claimFamilyBlocksDownstream(f),
      );
      screenReporter.log(
        `${String(greenlit.length)} greenlit, ${String(blocked.length)} blocked, ${String(screenedFamilies.length - greenlit.length - blocked.length)} deprioritized`,
      );
    }

    // Load screen results (from artifact) to determine processable families
    const families = loadJsonArtifact(
      screenJsonPath,
      preScreenResultsSchema,
      "screen results",
    );
    const processable = families.filter(
      (f) => f.decision === "greenlight" && !claimFamilyBlocksDownstream(f),
    );
    tracker.setTotalFamilies(processable.length);

    for (let familyIndex = 0; familyIndex < processable.length; familyIndex++) {
      for (const stageKey of [
        "extract",
        "classify",
        "evidence",
        "curate",
        "adjudicate",
      ] as const) {
        const reporter = createStageReporter(stageKey, outputDir, familyIndex);
        ensureFamilyStageRow(
          database,
          runId,
          stageKey,
          familyIndex,
          reporter.logPath,
        );
      }
    }

    if (processable.length === 0) {
      setRunStatus(database, runId, "succeeded", "screen");
      log("pipeline", "No greenlit families to process further. Stopping.");
      return;
    }

    if (runConfig.stopAfterStage === "screen") {
      setRunStatus(database, runId, "succeeded", "screen");
      log("pipeline", "Stopping after screen (stopAfterStage).");
      return;
    }

    // -----------------------------------------------------------------------
    // Stages 3-7: Extract → Classify → Evidence → Curate → Adjudicate
    // (per family, concurrent up to --family-concurrency)
    // -----------------------------------------------------------------------

    const extractionAdapters = {
      fullText: fullTextAdapters,
      biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
      cache: { db: database, cachePolicy },
    };

    const reranker = createLocalReranker(config.localRerankerBaseUrl);
    const rerankModelId = runConfig.evidenceRerankModel;
    const extractionCache = new Map<
      string,
      {
        resolvedSeedPaper: Awaited<
          ReturnType<typeof runM2Extraction>
        >["resolvedSeedPaper"];
        edgeResults: Awaited<ReturnType<typeof runM2Extraction>>["edgeResults"];
        summary: Awaited<ReturnType<typeof runM2Extraction>>["summary"];
      }
    >();
    const classificationCache = new Map<
      string,
      {
        resolvedSeedPaperTitle: string;
        packets: ReturnType<typeof buildPackets>["packets"];
        summary: ReturnType<typeof buildPackets>["summary"];
        studyMode: ReturnType<typeof buildPackets>["studyMode"];
      }
    >();

    function buildExtractionCacheKey(
      family: (typeof processable)[number],
    ): string {
      const eligibleEdges = family.edges
        .filter((edge) => edge.inClaimFamily !== false)
        .map((edge) => `${edge.citingPaperId}:${edge.citedPaperId}`)
        .sort();
      return JSON.stringify({
        version: "extract-v1",
        seedPaperId: family.resolvedSeedPaper?.id ?? family.seed.doi,
        edges: eligibleEdges,
      });
    }

    function buildClassificationCacheKey(
      family: (typeof processable)[number],
      extractionCacheKey: string,
      studyMode: "all_functions_census",
    ): string {
      const edgeInputs = family.edges
        .map((edge) => ({
          citingPaperId: edge.citingPaperId,
          inClaimFamily: edge.inClaimFamily ?? null,
          isPrimaryLike: edge.classification.isPrimaryLike,
          isReview: edge.classification.isReview,
          isCommentary: edge.classification.isCommentary,
          isLetter: edge.classification.isLetter,
          isBookChapter: edge.classification.isBookChapter,
          isJournalArticle: edge.classification.isJournalArticle,
          isPreprint: edge.classification.isPreprint,
        }))
        .sort((a, b) => a.citingPaperId.localeCompare(b.citingPaperId));
      return JSON.stringify({
        version: "classify-v1",
        extractionCacheKey,
        studyMode,
        edgeInputs,
      });
    }

    log(
      "pipeline",
      `Processing ${String(processable.length)} families (concurrency: ${String(runConfig.familyConcurrency)})`,
    );

    await pMap(
      processable,
      async (family, fi) => {
        if (fatalProviderFailure) {
          return;
        }

        const familyTag = `F${String(fi + 1)}`;
        let currentStageKey: StageKey = "extract";
        log(familyTag, family.seed.trackedClaim.slice(0, 70));
        try {
          // --- Extract ---
          currentStageKey = "extract";
          const extractReporter = createStageReporter("extract", outputDir, fi);
          extractReporter.log("Extracting citation contexts...");
          tracker.stageStart("extract", fi, extractReporter.logPath);
          const extractionCacheKey = buildExtractionCacheKey(family);
          const cachedExtraction = extractionCache.get(extractionCacheKey);

          // For attribution-first runs, extend adapters with pre-harvested mentions
          // so probed papers skip the full-text fetch. Non-probed papers fall back.
          const preHarvestedMentions = discoveryHandoffs?.get(
            family.seed.doi,
          )?.mentionsByPaperId;
          const familyExtractionAdapters = preHarvestedMentions
            ? { ...extractionAdapters, preHarvestedMentions }
            : extractionAdapters;

          const extraction = cachedExtraction
            ? {
                seed: family.seed,
                resolvedSeedPaper: cachedExtraction.resolvedSeedPaper,
                groundedSeedClaimText:
                  family.claimGrounding &&
                  (family.claimGrounding.status === "grounded" ||
                    family.claimGrounding.status === "ambiguous")
                    ? family.claimGrounding.normalizedClaim
                    : undefined,
                edgeResults: cachedExtraction.edgeResults,
                summary: cachedExtraction.summary,
              }
            : await runM2Extraction(
                family,
                familyExtractionAdapters,
                extractReporter.onProgress,
              );

          if (!cachedExtraction) {
            extractionCache.set(extractionCacheKey, {
              resolvedSeedPaper: extraction.resolvedSeedPaper,
              edgeResults: extraction.edgeResults,
              summary: extraction.summary,
            });
          } else {
            extractReporter.log(
              "Reused cached extract output for an identical citing-paper neighborhood.",
            );
          }

          const { jsonPath: extractJsonPath } = writeExtractionArtifacts({
            outputRoot: outputDir,
            stamp,
            result: extraction,
            sourceArtifacts: [screenJsonPath],
            familyIndex: fi,
          });
          tracker.stageSuccess("extract", fi, {
            primaryArtifactPath: extractJsonPath,
            inputArtifactPath: screenJsonPath,
          });
          extractReporter.log(
            `${String(extraction.summary.successfulEdgesUsable)} usable edges, ${String(extraction.summary.usableMentionCount)} usable mentions`,
          );

          if (runConfig.stopAfterStage === "extract") {
            return;
          }

          if (extraction.summary.successfulEdgesUsable === 0) {
            extractReporter.log(
              "No usable edges — skipping downstream stages for this family.",
            );
            return;
          }

          if (fatalProviderFailure) {
            return;
          }

          // --- Classify ---
          currentStageKey = "classify";
          const classifyReporter = createStageReporter(
            "classify",
            outputDir,
            fi,
          );
          classifyReporter.log("Classifying citation roles...");
          tracker.stageStart("classify", fi, classifyReporter.logPath);

          classifyReporter.onProgress({
            step: "load_extracted_mentions",
            status: "running",
          });
          const edgeClassifications: Record<string, EdgeClassification> = {};
          const preScreenEdges: Record<string, PreScreenEdge> = {};
          for (const edge of family.edges) {
            edgeClassifications[edge.citingPaperId] = edge.classification;
            preScreenEdges[edge.citingPaperId] = edge;
          }

          const classificationCacheKey = buildClassificationCacheKey(
            family,
            extractionCacheKey,
            "all_functions_census",
          );
          const cachedClassification = classificationCache.get(
            classificationCacheKey,
          );
          const classification = cachedClassification
            ? {
                seed: extraction.seed,
                resolvedSeedPaperTitle:
                  cachedClassification.resolvedSeedPaperTitle,
                studyMode: cachedClassification.studyMode,
                groundedSeedClaimText: extraction.groundedSeedClaimText,
                packets: cachedClassification.packets,
                summary: cachedClassification.summary,
              }
            : buildPackets(
                extraction,
                "all_functions_census",
                edgeClassifications,
                preScreenEdges,
              );

          if (!cachedClassification) {
            classificationCache.set(classificationCacheKey, {
              resolvedSeedPaperTitle: classification.resolvedSeedPaperTitle,
              packets: classification.packets,
              summary: classification.summary,
              studyMode: classification.studyMode,
            });
          } else {
            classifyReporter.log(
              "Reused cached classify output for an identical citing-paper neighborhood.",
            );
          }

          classifyReporter.onProgress({
            step: "summarize_literature_structure",
            status: "completed",
            detail: `${String(classification.summary.literatureStructure.totalTasks)} tasks from ${String(classification.summary.literatureStructure.edgesWithMentions)} edges`,
          });

          const { jsonPath: classifyJsonPath } = writeClassificationArtifacts({
            outputRoot: outputDir,
            stamp,
            result: classification,
            sourceArtifacts: [extractJsonPath, screenJsonPath],
            familyIndex: fi,
          });
          tracker.stageSuccess("classify", fi, {
            primaryArtifactPath: classifyJsonPath,
            inputArtifactPath: extractJsonPath,
          });
          classifyReporter.log(
            `${String(classification.summary.literatureStructure.totalTasks)} tasks from ${String(classification.summary.literatureStructure.edgesWithMentions)} edges`,
          );

          if (runConfig.stopAfterStage === "classify") {
            return;
          }

          if (classification.summary.literatureStructure.totalTasks === 0) {
            classifyReporter.log(
              "No evaluation tasks — skipping downstream stages for this family.",
            );
            return;
          }

          if (fatalProviderFailure) {
            return;
          }

          // --- Evidence ---
          currentStageKey = "evidence";
          const evidenceReporter = createStageReporter(
            "evidence",
            outputDir,
            fi,
          );
          evidenceReporter.log(
            "Resolving cited paper and retrieving evidence...",
          );
          tracker.stageStart("evidence", fi, evidenceReporter.logPath);
          const patchAvailability = (
            result: Result<ResolvedPaper>,
          ): Result<ResolvedPaper> => {
            if (result.ok && runConfig.seedPdfPath) {
              result.data.fullTextHints.providerAvailability = "available";
            }
            return result;
          };
          const citedPaperMaterialized = await resolveCitedPaperSource(
            classification,
            {
              resolveByDoi: async (doi) =>
                patchAvailability(
                  await resolvePaperByDoi(doi, {
                    openAlexBaseUrl: config.providerBaseUrls.openAlex,
                    semanticScholarBaseUrl:
                      config.providerBaseUrls.semanticScholar,
                    openAlexEmail: config.openAlexEmail,
                    semanticScholarApiKey: config.semanticScholarApiKey,
                  }),
                ),
              resolveByMetadata: async (locator) =>
                patchAvailability(
                  await resolvePaperByMetadata(locator, {
                    openAlexBaseUrl: config.providerBaseUrls.openAlex,
                    semanticScholarBaseUrl:
                      config.providerBaseUrls.semanticScholar,
                    openAlexEmail: config.openAlexEmail,
                    semanticScholarApiKey: config.semanticScholarApiKey,
                  }),
                ),
              materializeParsedPaper: (paper) =>
                runConfig.seedPdfPath
                  ? materializeLocalPdf(runConfig.seedPdfPath, fullTextAdapters)
                  : materializeParsedPaper(
                      paper,
                      config.providerBaseUrls.bioRxiv,
                      fullTextAdapters,
                      { db: database, cachePolicy },
                    ),
            },
            evidenceReporter.onProgress,
          );

          // --- Evidence pass 1: BM25-only for all tasks (free) ---
          evidenceReporter.onProgress({
            step: "retrieve_candidate_evidence",
            status: "running",
          });
          const evidenceResult = await retrieveEvidence(
            classification,
            citedPaperMaterialized.citedPaperSource,
            citedPaperMaterialized.citedPaperParsedDocument,
            {
              ...(reranker ? { reranker } : {}),
              // No llmClient here — BM25 only for the bulk pass.
            },
          );
          evidenceReporter.onProgress({
            step: "summarize_grounded_coverage",
            status: "completed",
            detail: `${String(evidenceResult.summary.tasksWithEvidence)}/${String(evidenceResult.summary.totalTasks)} tasks matched evidence`,
          });
          evidenceReporter.log(
            `${String(evidenceResult.summary.tasksWithEvidence)}/${String(evidenceResult.summary.totalTasks)} tasks matched evidence`,
          );

          if (runConfig.stopAfterStage === "evidence") {
            const { jsonPath: evidenceJsonPath } = writeEvidenceArtifacts({
              outputRoot: outputDir,
              stamp,
              result: evidenceResult,
              sourceArtifacts: [classifyJsonPath],
              familyIndex: fi,
            });
            tracker.stageSuccess("evidence", fi, {
              primaryArtifactPath: evidenceJsonPath,
              inputArtifactPath: classifyJsonPath,
            });
            return;
          }

          if (fatalProviderFailure) {
            return;
          }

          // --- Curate: sample audit set from BM25 evidence ---
          currentStageKey = "curate";
          const curateReporter = createStageReporter("curate", outputDir, fi);
          curateReporter.log("Sampling audit set...");
          tracker.stageStart("curate", fi, curateReporter.logPath);

          curateReporter.onProgress({
            step: "collect_eligible_tasks",
            status: "running",
          });
          const auditSample = sampleAuditSet(
            evidenceResult,
            undefined,
            runConfig.curateTargetSize,
          );
          curateReporter.onProgress({
            step: "write_sampling_outputs",
            status: "completed",
            detail: `${String(auditSample.records.length)} audit records`,
          });

          // --- Evidence pass 2: LLM rerank ONLY the curated tasks ---
          if (runConfig.evidenceLlmRerank) {
            const rerankClient = createLLMClient({
              apiKey,
              defaultModel: rerankModelId,
              collector: telemetryCollector,
              defaultContext: { stageKey: "evidence", familyIndex: fi },
              database,
              forceRefresh: runConfig.forceRefresh,
            });
            const curatedTaskIds = new Set(
              auditSample.records.map((r) => r.taskId),
            );
            evidenceReporter.log(
              `LLM reranking ${String(curatedTaskIds.size)} curated tasks...`,
            );

            const rerankedResult = await retrieveEvidence(
              classification,
              citedPaperMaterialized.citedPaperSource,
              citedPaperMaterialized.citedPaperParsedDocument,
              {
                ...(reranker ? { reranker } : {}),
                llmClient: rerankClient,
                llmRerankerOptions: {
                  model: rerankModelId,
                  useThinking: true,
                  topN: runConfig.evidenceRerankTopN,
                  enableExactCache: true,
                },
                llmRerankTaskIds: curatedTaskIds,
              },
            );

            // Update the audit sample records with LLM-reranked evidence.
            const rerankedByTaskId = new Map<string, TaskWithEvidence>();
            for (const edge of rerankedResult.edges) {
              for (const task of edge.tasks) {
                if (curatedTaskIds.has(task.taskId)) {
                  rerankedByTaskId.set(task.taskId, task);
                }
              }
            }
            for (const record of auditSample.records) {
              const reranked = rerankedByTaskId.get(record.taskId);
              if (reranked) {
                record.evidenceSpans = reranked.citedPaperEvidenceSpans;
                record.evidenceRetrievalStatus =
                  reranked.evidenceRetrievalStatus;
              }
            }

            const rerankLedger = rerankClient.getLedger();
            if (rerankLedger.totalAttemptedCalls > 0) {
              evidenceReporter.log(
                `LLM reranking: ${rerankLedger.totalAttemptedCalls} attempted, ${rerankLedger.totalFailedCalls} failed, ~$${rerankLedger.totalEstimatedCostUsd.toFixed(4)}`,
              );
            }
          }

          // Write evidence artifact (includes BM25 results for all tasks).
          const { jsonPath: evidenceJsonPath } = writeEvidenceArtifacts({
            outputRoot: outputDir,
            stamp,
            result: evidenceResult,
            sourceArtifacts: [classifyJsonPath],
            familyIndex: fi,
          });
          tracker.stageSuccess("evidence", fi, {
            primaryArtifactPath: evidenceJsonPath,
            inputArtifactPath: classifyJsonPath,
          });

          const { jsonPath: curateJsonPath } = writeAuditSampleArtifacts({
            outputRoot: outputDir,
            stamp,
            result: auditSample,
            sourceArtifacts: [evidenceJsonPath],
            familyIndex: fi,
          });
          tracker.stageSuccess("curate", fi, {
            primaryArtifactPath: curateJsonPath,
            inputArtifactPath: evidenceJsonPath,
          });
          curateReporter.log(
            `${String(auditSample.records.length)} audit records`,
          );

          if (runConfig.stopAfterStage === "curate") {
            return;
          }

          if (auditSample.records.length === 0) {
            curateReporter.log(
              "No audit records — skipping adjudication for this family.",
            );
            return;
          }

          if (fatalProviderFailure) {
            return;
          }

          // --- Adjudicate ---
          currentStageKey = "adjudicate";
          const adjudicateReporter = createStageReporter(
            "adjudicate",
            outputDir,
            fi,
          );
          adjudicateReporter.log("Running LLM adjudication...");
          tracker.stageStart("adjudicate", fi, adjudicateReporter.logPath);

          adjudicateReporter.onProgress({
            step: "load_active_records",
            status: "completed",
            detail: `${String(auditSample.records.length)} records`,
          });
          adjudicateReporter.onProgress({
            step: "adjudicate_records",
            status: "running",
          });
          const adjudicationClient = createLLMClient({
            apiKey,
            defaultModel: runConfig.adjudicateModel,
            collector: telemetryCollector,
            defaultContext: { stageKey: "adjudicate", familyIndex: fi },
            database,
            forceRefresh: runConfig.forceRefresh,
          });
          const adjudicationResult = await adjudicateAuditSample(
            auditSample,
            {
              apiKey,
              model: runConfig.adjudicateModel,
              useExtendedThinking: runConfig.adjudicateThinking,
              llmClient: adjudicationClient,
              enableExactCache: true,
              ...(runConfig.adjudicateAdvisor
                ? {
                    advisor: {
                      firstPassModel: runConfig.adjudicateFirstPassModel,
                    },
                  }
                : {}),
            },
            (i, total) => {
              if (i % 5 === 0 || i === total) {
                adjudicateReporter.onProgress({
                  step: "adjudicate_records",
                  status: "running",
                  detail: `${String(i)}/${String(total)} records`,
                  current: i,
                  total,
                });
              }
            },
          );

          const { jsonPath: adjudicateJsonPath } = writeAdjudicationArtifacts({
            outputRoot: outputDir,
            stamp,
            result: adjudicationResult,
            sourceArtifacts: [curateJsonPath],
            model: runConfig.adjudicateModel,
            familyIndex: fi,
          });
          tracker.stageSuccess("adjudicate", fi, {
            primaryArtifactPath: adjudicateJsonPath,
            inputArtifactPath: curateJsonPath,
          });

          const verdicts = adjudicationResult.records.filter(
            (r) => !r.excluded && r.verdict != null,
          );
          const supported = verdicts.filter(
            (r) => r.verdict === "supported",
          ).length;
          const partial = verdicts.filter(
            (r) => r.verdict === "partially_supported",
          ).length;
          const notSupported = verdicts.filter(
            (r) => r.verdict === "not_supported",
          ).length;
          adjudicateReporter.onProgress({
            step: "write_final_outputs",
            status: "completed",
            detail: `${String(verdicts.length)} verdicts: ${String(supported)} S, ${String(partial)} P, ${String(notSupported)} N`,
          });
          adjudicateReporter.log(
            `${String(verdicts.length)} verdicts: ${String(supported)} supported, ${String(partial)} partial, ${String(notSupported)} not supported`,
          );
        } catch (error) {
          if (isFatalProviderError(error)) {
            fatalProviderFailure ??= {
              message: error.message,
              stageKey: currentStageKey,
              familyIndex: fi,
            };
            tracker.blockPendingFamilyStages(error.message);
          }
          throw error;
        }
      },
      { concurrency: runConfig.familyConcurrency },
    );

    writeCostSummary();
    const totalCost = telemetryCollector.getLedger().totalEstimatedCostUsd;
    setRunStatus(database, runId, "succeeded", runConfig.stopAfterStage);
    log("pipeline", `\nPipeline complete. Run ${runId}`);
    log("pipeline", `Artifacts in ${outputDir}`);
    log("pipeline", `Estimated total LLM cost: ~$${totalCost.toFixed(4)}`);
  } catch (error) {
    writeCostSummary();
    tracker.runFailed(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    database.close();
  }
}
