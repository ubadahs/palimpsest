import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import type { AppConfig } from "../config/app-config.js";
import type { CachePolicy } from "../domain/types.js";
import {
  claimFamilyBlocksDownstream,
  preScreenResultsSchema,
  shortlistInputSchema,
} from "../domain/types.js";
import { discoveryInputSchema } from "../domain/discovery.js";
import {
  deserializeHandoffMap,
  serializeHandoffMap,
  type DiscoveryHandoffMap,
} from "../domain/discovery-handoff.js";
import {
  createLLMClient,
  createLLMTelemetryCollector,
} from "../integrations/llm-client.js";
import { resolvePaperByDoi } from "../integrations/paper-resolver.js";
import * as openalex from "../integrations/openalex.js";
import type { AnalysisRun, AnalysisRunConfig } from "../contract/run-types.js";
import { analysisRunConfigSchema } from "../contract/run-types.js";
import { stageDefinitions } from "../contract/stages.js";
import { discoverClaims } from "./claim-discovery.js";
import { rankClaimsByEngagement } from "./claim-ranking.js";
import {
  runDiscoveryStage,
  type DiscoverySeedEntry,
  type DiscoveryStrategy,
} from "./discovery-stage.js";
import {
  runPreScreen,
  runPreScreenFromHandoff,
  type PreScreenAdapters,
} from "./pre-screen.js";
import { RunTracker } from "./run-tracker.js";
import { summarizeLedgerByStage } from "./cost-summary.js";
import {
  runFamilyStages,
  type FamilyRunCaches,
  type FamilyRunFatalProviderState,
} from "./family-runner.js";
import {
  createAnalysisRun,
  ensureFamilyStageRow,
  getAnalysisRun,
  setRunStatus,
} from "../storage/analysis-runs.js";
import { runMigrations } from "../storage/migration-service.js";
import { loadJsonArtifact } from "../shared/artifact-io.js";
import { pMap } from "../shared/p-map.js";
import {
  buildPaperAdapters,
  createFullTextAdapters,
  type CitingYearRange,
} from "../cli/paper-adapters.js";
import {
  materializeLocalPdf,
  materializeParsedPaper,
} from "../retrieval/parsed-paper.js";
import { createLocalReranker } from "../retrieval/local-reranker.js";
import { createStageReporter, log } from "../cli/stage-reporter.js";
import { resolveStageOutputDir } from "../cli/stage-output.js";
import { nextRunStampFromDirectories } from "../cli/run-stamp.js";
import {
  writeAttributionDiscoveryArtifacts,
  writeDiscoveryArtifacts,
  writeScreenArtifacts,
} from "../cli/stage-artifact-writers.js";

/**
 * Parsed CLI overrides. Every field is optional — the schema default in
 * `analysisRunConfigSchema` is the single source of truth. The CLI parser
 * only sets a value when the user explicitly passes a flag.
 */
export type PipelineCliOverrides = {
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

export type OrchestratePipelineRunParams = {
  args: PipelineCliOverrides;
  config: AppConfig;
  apiKey: string;
  database: Database.Database;
};

function buildCliOverrides(
  args: PipelineCliOverrides,
): Record<string, unknown> {
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
  return cliOverrides;
}

function buildCitingYearRange(
  runConfig: AnalysisRunConfig,
): CitingYearRange | undefined {
  return runConfig.discoverFromYear != null || runConfig.discoverToYear != null
    ? {
        ...(runConfig.discoverFromYear != null
          ? { fromYear: runConfig.discoverFromYear }
          : {}),
        ...(runConfig.discoverToYear != null
          ? { toYear: runConfig.discoverToYear }
          : {}),
      }
    : undefined;
}

function createFreshRunRow(params: {
  database: Database.Database;
  runId: string;
  runConfig: AnalysisRunConfig;
  outputDir: string;
  hasTrackedClaim: boolean;
  shortlistFile: string | undefined;
  inputFile: string | undefined;
}): void {
  const {
    database,
    runId,
    runConfig,
    outputDir,
    hasTrackedClaim,
    shortlistFile,
    inputFile,
  } = params;

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

async function runDiscoverOrLoadShortlist(params: {
  args: PipelineCliOverrides;
  apiKey: string;
  config: AppConfig;
  database: Database.Database;
  tracker: RunTracker;
  existingRun: AnalysisRun | undefined;
  runConfig: AnalysisRunConfig;
  outputDir: string;
  stamp: string;
  inputFile: string | undefined;
  shortlistFile: string | undefined;
  hasTrackedClaim: boolean;
  cachePolicy: CachePolicy;
  citingYearRange: CitingYearRange | undefined;
  telemetryCollector: ReturnType<typeof createLLMTelemetryCollector>;
}): Promise<{
  seeds: DiscoverySeedEntry[];
  screenInputArtifactPath: string | undefined;
  discoveryHandoffs: DiscoveryHandoffMap | undefined;
}> {
  const {
    apiKey,
    config,
    database,
    tracker,
    existingRun,
    runConfig,
    outputDir,
    stamp,
    inputFile,
    shortlistFile,
    hasTrackedClaim,
    cachePolicy,
    citingYearRange,
    telemetryCollector,
  } = params;

  let seeds: DiscoverySeedEntry[];
  let screenInputArtifactPath: string | undefined;
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

    const fullTextAdapters = createFullTextAdapters(config);
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
        rankClaimsByEngagement: (seedTitle, claims, citingPapers, onProgress) =>
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
    discoveryHandoffs = discoveryStage.handoffs;
    if (discoveryHandoffs && discoveryHandoffs.size > 0) {
      const handoffPath = resolve(
        outputDir,
        "inputs",
        "discovery-handoffs.json",
      );
      mkdirSync(resolve(outputDir, "inputs"), { recursive: true });
      writeFileSync(
        handoffPath,
        serializeHandoffMap(discoveryHandoffs),
        "utf8",
      );
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

  return { seeds, screenInputArtifactPath, discoveryHandoffs };
}

async function runScreenOrLoadExisting(params: {
  apiKey: string;
  config: AppConfig;
  database: Database.Database;
  tracker: RunTracker;
  existingRun: AnalysisRun | undefined;
  runConfig: AnalysisRunConfig;
  outputDir: string;
  stamp: string;
  seeds: DiscoverySeedEntry[];
  screenInputArtifactPath: string | undefined;
  discoveryHandoffs: DiscoveryHandoffMap | undefined;
  cachePolicy: CachePolicy;
  citingYearRange: CitingYearRange | undefined;
  telemetryCollector: ReturnType<typeof createLLMTelemetryCollector>;
}): Promise<string> {
  const {
    apiKey,
    config,
    database,
    tracker,
    existingRun,
    runConfig,
    outputDir,
    stamp,
    seeds,
    screenInputArtifactPath,
    discoveryHandoffs,
    cachePolicy,
    citingYearRange,
    telemetryCollector,
  } = params;

  const existingScreenArtifact = tracker.succeededArtifact(
    "screen",
    Boolean(existingRun),
  );

  if (existingScreenArtifact) {
    log("screen", "Skipped (already succeeded)");
    return existingScreenArtifact;
  }

  const screenReporter = createStageReporter("screen", outputDir);
  screenReporter.log(`Pre-screening ${String(seeds.length)} seed(s)...`);
  tracker.stageStart("screen", 0, screenReporter.logPath);

  let screenedFamilies: Awaited<ReturnType<typeof runPreScreen>>["families"];
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
    const fullTextAdapters = createFullTextAdapters(config);
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
    sourceArtifacts: screenInputArtifactPath ? [screenInputArtifactPath] : [],
  });
  tracker.stageSuccess("screen", 0, {
    primaryArtifactPath: screenArtifacts.jsonPath,
    ...(screenInputArtifactPath != null
      ? { inputArtifactPath: screenInputArtifactPath }
      : {}),
  });

  const greenlit = screenedFamilies.filter((f) => f.decision === "greenlight");
  const blocked = screenedFamilies.filter((f) =>
    claimFamilyBlocksDownstream(f),
  );
  screenReporter.log(
    `${String(greenlit.length)} greenlit, ${String(blocked.length)} blocked, ${String(screenedFamilies.length - greenlit.length - blocked.length)} deprioritized`,
  );

  return screenArtifacts.jsonPath;
}

export async function orchestratePipelineRun(
  params: OrchestratePipelineRunParams,
): Promise<void> {
  const { args, config, apiKey, database } = params;

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

  const runConfig = existingRun
    ? existingRun.config
    : analysisRunConfigSchema.parse(buildCliOverrides(args));
  const citingYearRange = buildCitingYearRange(runConfig);

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
    writeCostSummary = (): void => {
      const summary = summarizeLedgerByStage(telemetryCollector.getLedger());
      writeFileSync(
        resolve(outputDir, `${stamp}_run-cost.json`),
        JSON.stringify(summary, null, 2),
      );
    };

    const inputFile = existingRun
      ? resolve(outputDir, "inputs", "dois.json")
      : args.input;
    const shortlistFile = existingRun
      ? resolve(outputDir, "inputs", "shortlist.json")
      : args.shortlist;
    const hasTrackedClaim = existingRun
      ? existingRun.trackedClaim != null
      : args.shortlist != null;

    if (!existingRun) {
      createFreshRunRow({
        database,
        runId,
        runConfig,
        outputDir,
        hasTrackedClaim,
        shortlistFile,
        inputFile,
      });
    }

    const { seeds, screenInputArtifactPath, discoveryHandoffs } =
      await runDiscoverOrLoadShortlist({
        args,
        apiKey,
        config,
        database,
        tracker,
        existingRun,
        runConfig,
        outputDir,
        stamp,
        inputFile,
        shortlistFile,
        hasTrackedClaim,
        cachePolicy,
        citingYearRange,
        telemetryCollector,
      });

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

    const screenJsonPath = await runScreenOrLoadExisting({
      apiKey,
      config,
      database,
      tracker,
      existingRun,
      runConfig,
      outputDir,
      stamp,
      seeds,
      screenInputArtifactPath,
      discoveryHandoffs,
      cachePolicy,
      citingYearRange,
      telemetryCollector,
    });

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

    const fatalProviderFailure: FamilyRunFatalProviderState = {
      current: undefined,
    };
    const caches: FamilyRunCaches = {
      extraction: new Map(),
      classification: new Map(),
    };
    const reranker = createLocalReranker(config.localRerankerBaseUrl);
    const rerankModelId = runConfig.evidenceRerankModel;

    log(
      "pipeline",
      `Processing ${String(processable.length)} families (concurrency: ${String(runConfig.familyConcurrency)})`,
    );

    await pMap(
      processable,
      (family, familyIndex) =>
        runFamilyStages({
          family,
          familyIndex,
          screenJsonPath,
          outputDir,
          stamp,
          apiKey,
          database,
          config,
          runConfig,
          cachePolicy,
          fullTextAdapters,
          reranker,
          rerankModelId,
          telemetryCollector,
          tracker,
          discoveryHandoffs,
          caches,
          fatalProviderFailure,
        }),
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
