import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type {
  CachePolicy,
  EdgeClassification,
  PreScreenEdge,
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
import { createLLMClient } from "../../integrations/llm-client.js";
import * as openalex from "../../integrations/openalex.js";
import { buildPaperAdapters } from "../paper-adapters.js";
import { discoverClaims } from "../../pipeline/claim-discovery.js";
import { rankClaimsByEngagement } from "../../pipeline/claim-ranking.js";
import {
  runPreScreen,
  type PreScreenAdapters,
} from "../../pipeline/pre-screen.js";
import {
  runDiscoveryStage,
  type DiscoverySeedEntry,
  type DiscoveryStrategy,
} from "../../pipeline/discovery-stage.js";
import { runM2Extraction } from "../../pipeline/extract.js";
import { buildPackets } from "../../classification/build-packets.js";
import { resolveCitedPaperSource } from "../../pipeline/evidence.js";
import { retrieveEvidence } from "../../retrieval/evidence-retrieval.js";
import { sampleCalibrationSet } from "../../adjudication/sample-calibration.js";
import { adjudicateCalibrationSet } from "../../adjudication/llm-adjudicator.js";
import { createDefaultAdapters } from "../../retrieval/fulltext-fetch.js";
import { materializeParsedPaper } from "../../retrieval/parsed-paper.js";
import { createLocalReranker } from "../../retrieval/local-reranker.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import {
  createAnalysisRun,
  ensureFamilyStageRow,
  getAnalysisRun,
  getRunStage,
  markRunInterrupted,
  setRunStatus,
  updateStageStatus,
} from "../../storage/analysis-runs.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import { resolveStageOutputDir } from "../stage-output.js";
import {
  writeAdjudicationArtifacts,
  writeAttributionDiscoveryArtifacts,
  writeCalibrationSetArtifacts,
  writeClassificationArtifacts,
  writeDiscoveryArtifacts,
  writeEvidenceArtifacts,
  writeExtractionArtifacts,
  writeScreenArtifacts,
} from "../stage-artifact-writers.js";
import { nextRunStampFromDirectories } from "../run-stamp.js";
import { stageDefinitions } from "../../ui-contract/stages.js";
import {
  analysisRunConfigSchema,
  type StageKey,
} from "../../ui-contract/run-types.js";
import { deriveStageSummary } from "../../ui-contract/selectors.js";
import type { StageProgressEvent } from "../../ui-contract/workflow.js";
import { serializeProgressEvent } from "../../ui-contract/workflow.js";
import { pMap } from "../../shared/p-map.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  input: string | undefined;
  shortlist: string | undefined;
  runId: string | undefined;
  topN: number;
  noRank: boolean;
  targetSize: number;
  strategy: DiscoveryStrategy;
  probeBudget: number;
  shortlistCap: number;
  screenGroundingModel: string | undefined;
  screenFilterModel: string | undefined;
  screenFilterConcurrency: number | undefined;
  rerankModel: string | undefined;
  rerankTopN: number | undefined;
  familyConcurrency: number | undefined;
} {
  let input: string | undefined;
  let shortlist: string | undefined;
  let runId: string | undefined;
  let topN = 5;
  let noRank = false;
  let targetSize = 40;
  let strategy: DiscoveryStrategy = "attribution_first";
  let probeBudget = 20;
  let shortlistCap = 10;
  let screenGroundingModel: string | undefined;
  let screenFilterModel: string | undefined;
  let screenFilterConcurrency: number | undefined;
  let rerankModel: string | undefined;
  let rerankTopN: number | undefined;
  let familyConcurrency: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run-id" && i + 1 < argv.length) {
      runId = argv[i + 1];
      i++;
    } else if (arg === "--input" && i + 1 < argv.length) {
      input = argv[i + 1];
      i++;
    } else if (arg === "--shortlist" && i + 1 < argv.length) {
      shortlist = argv[i + 1];
      i++;
    } else if (arg === "--top" && i + 1 < argv.length) {
      topN = Math.max(1, parseInt(argv[i + 1]!, 10) || 5);
      i++;
    } else if (arg === "--no-rank") {
      noRank = true;
    } else if (arg === "--target-size" && i + 1 < argv.length) {
      targetSize = Math.max(1, parseInt(argv[i + 1]!, 10) || 40);
      i++;
    } else if (arg === "--strategy" && i + 1 < argv.length) {
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
    } else if (arg === "--probe-budget" && i + 1 < argv.length) {
      probeBudget = Math.max(1, parseInt(argv[i + 1]!, 10) || 20);
      i++;
    } else if (arg === "--shortlist-cap" && i + 1 < argv.length) {
      shortlistCap = Math.max(1, parseInt(argv[i + 1]!, 10) || 10);
      i++;
    } else if (arg === "--screen-grounding-model" && i + 1 < argv.length) {
      screenGroundingModel = argv[i + 1]!;
      i++;
    } else if (arg === "--screen-filter-model" && i + 1 < argv.length) {
      screenFilterModel = argv[i + 1]!;
      i++;
    } else if (arg === "--screen-filter-concurrency" && i + 1 < argv.length) {
      screenFilterConcurrency = Math.max(1, parseInt(argv[i + 1]!, 10) || 10);
      i++;
    } else if (arg === "--rerank-model" && i + 1 < argv.length) {
      rerankModel = argv[i + 1]!;
      i++;
    } else if (arg === "--rerank-top-n" && i + 1 < argv.length) {
      rerankTopN = Math.max(1, parseInt(argv[i + 1]!, 10) || 5);
      i++;
    } else if (arg === "--family-concurrency" && i + 1 < argv.length) {
      familyConcurrency = Math.max(1, parseInt(argv[i + 1]!, 10) || 3);
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

  return {
    input,
    shortlist,
    runId,
    topN,
    noRank,
    targetSize,
    strategy,
    probeBudget,
    shortlistCap,
    screenGroundingModel,
    screenFilterModel,
    screenFilterConcurrency,
    rerankModel,
    rerankTopN,
    familyConcurrency,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(stage: string, message: string): void {
  console.info(`[${stage}] ${message}`);
}

type StageReporter = {
  onProgress: (event: {
    step: string;
    status: string;
    detail?: string;
    current?: number;
    total?: number;
  }) => void;
  log: (message: string) => void;
  logPath: string;
};

/**
 * Creates a stage-aware reporter that emits structured CF_PROGRESS events
 * (for the workflow panel) and human-readable log lines to both stdout and a
 * per-stage log file. The UI reads these files for live telemetry.
 */
function createStageReporter(
  stageKey: StageKey,
  outputDir: string,
  familyIndex = 0,
): StageReporter {
  const def = stageDefinitions.find((s) => s.key === stageKey)!;
  const fileName =
    familyIndex > 0
      ? `${def.slug}.f${String(familyIndex)}.log`
      : `${def.slug}.log`;
  const logPath = resolve(outputDir, "logs", fileName);
  const tag =
    familyIndex > 0 ? `F${String(familyIndex + 1)}:${stageKey}` : stageKey;

  function writeToLog(line: string): void {
    appendFileSync(logPath, line + "\n", "utf8");
  }

  function onProgress(event: {
    step: string;
    status: string;
    detail?: string;
    current?: number;
    total?: number;
  }): void {
    const line = serializeProgressEvent({
      stage: stageKey,
      step: event.step,
      status: event.status as StageProgressEvent["status"],
      ...(event.detail != null ? { detail: event.detail } : {}),
      ...(event.current != null && event.total != null
        ? { current: event.current, total: event.total }
        : {}),
    });
    writeToLog(line);
    console.info(line);
  }

  function stageLog(message: string): void {
    const line = `[${tag}] ${message}`;
    writeToLog(line);
    console.info(line);
  }

  return { onProgress, log: stageLog, logPath };
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
  const activeStages = new Set<string>(); // "stageKey:familyIndex" pairs

  // --- Run tracking ---------------------------------------------------------
  function trackStageStart(
    stageKey: StageKey,
    familyIndex = 0,
    logPath?: string,
  ): void {
    if (familyIndex > 0) {
      ensureFamilyStageRow(database, runId, stageKey, familyIndex, logPath);
    }
    const key = `${stageKey}:${String(familyIndex)}`;
    activeStages.add(key);
    updateStageStatus(database, runId, stageKey, "running", {
      familyIndex,
      startedAt: new Date().toISOString(),
      processId: process.pid,
    });
    if (familyIndex === 0) {
      setRunStatus(database, runId, "running", stageKey);
    }
  }

  function trackStageSuccess(
    stageKey: StageKey,
    familyIndex: number,
    artifacts: {
      primaryArtifactPath?: string;
      reportArtifactPath?: string;
      manifestPath?: string;
      inputArtifactPath?: string;
    },
  ): void {
    const key = `${stageKey}:${String(familyIndex)}`;
    activeStages.delete(key);
    const summary = deriveStageSummary(stageKey, artifacts.primaryArtifactPath);
    updateStageStatus(database, runId, stageKey, "succeeded", {
      familyIndex,
      ...artifacts,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      ...(summary ? { summary } : {}),
    });
  }

  function trackRunFailed(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    for (const key of activeStages) {
      const [stageKey, fi] = key.split(":") as [StageKey, string];
      updateStageStatus(database, runId, stageKey, "failed", {
        familyIndex: parseInt(fi, 10),
        errorMessage: msg,
        finishedAt: new Date().toISOString(),
        exitCode: 1,
      });
    }
    setRunStatus(database, runId, "failed");
  }

  function succeededArtifact(stageKey: StageKey): string | undefined {
    if (!existingRun) return undefined;
    const stage = getRunStage(database, runId, stageKey);
    return stage?.status === "succeeded"
      ? stage.primaryArtifactPath
      : undefined;
  }

  const handleSignal = (): void => {
    for (const key of activeStages) {
      const [stageKey, fi] = key.split(":") as [StageKey, string];
      markRunInterrupted(database, runId, stageKey, "Interrupted by signal.");
      // markRunInterrupted only handles one stage; manually mark others
      if (fi !== "0") {
        updateStageStatus(database, runId, stageKey, "interrupted", {
          familyIndex: parseInt(fi, 10),
          errorMessage: "Interrupted by signal.",
          finishedAt: new Date().toISOString(),
        });
      }
    }
    database.close();
    process.exit(130);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // --- Build run config ------------------------------------------------------
  const runConfig = existingRun
    ? existingRun.config
    : analysisRunConfigSchema.parse({
        discoverStrategy: args.strategy,
        discoverTopN: args.topN,
        discoverRank: !args.noRank,
        discoverProbeBudget: args.probeBudget,
        discoverShortlistCap: args.shortlistCap,
        curateTargetSize: args.targetSize,
        ...(args.screenGroundingModel != null
          ? { screenGroundingModel: args.screenGroundingModel }
          : {}),
        ...(args.screenFilterModel != null
          ? { screenFilterModel: args.screenFilterModel }
          : {}),
        ...(args.screenFilterConcurrency != null
          ? { screenFilterConcurrency: args.screenFilterConcurrency }
          : {}),
        ...(args.rerankModel != null
          ? { evidenceRerankModel: args.rerankModel }
          : {}),
        ...(args.rerankTopN != null
          ? { evidenceRerankTopN: args.rerankTopN }
          : {}),
        ...(args.familyConcurrency != null
          ? { familyConcurrency: args.familyConcurrency }
          : {}),
      });

  try {
    const cachePolicy: CachePolicy = runConfig.forceRefresh
      ? "force_refresh"
      : "prefer_cache";
    const fullTextAdapters = createDefaultAdapters(
      config.providerBaseUrls.grobid,
      config.openAlexEmail,
    );

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

    const costEntries: Array<{
      stage: string;
      familyIndex: number;
      estimatedCostUsd: number;
      calls: number;
    }> = [];

    function writeCostSummary(): void {
      const total = costEntries.reduce(
        (sum, e) => sum + e.estimatedCostUsd,
        0,
      );
      const totalCalls = costEntries.reduce((sum, e) => sum + e.calls, 0);
      const summary = {
        totalEstimatedCostUsd: total,
        totalCalls,
        byStage: costEntries,
        generatedAt: new Date().toISOString(),
      };
      writeFileSync(
        resolve(outputDir, `${stamp}_run-cost.json`),
        JSON.stringify(summary, null, 2),
      );
    }

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

    if (succeededArtifact("discover")) {
      // Resume: shortlist was written by prior discover run
      const slFile = resolve(outputDir, "inputs", "shortlist.json");
      const loaded = loadJsonArtifact(
        slFile,
        shortlistInputSchema,
        "shortlist input",
      );
      seeds = loaded.seeds;
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
      trackStageStart("discover", 0, discoverReporter.logPath);

      const discoveryClient = createLLMClient({
        apiKey,
        defaultModel: runConfig.discoverModel,
      });

      const paperAdapters = buildPaperAdapters({
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
      });

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
                  },
                },
                attributionOptions: {
                  probeBudget: runConfig.discoverProbeBudget,
                  shortlistCap: runConfig.discoverShortlistCap,
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
              ...(onProgress ? { onProgress } : {}),
            }),
        },
        discoverReporter.onProgress,
      );
      seeds = discoveryStage.seeds;

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
      trackStageSuccess("discover", 0, {
        primaryArtifactPath: discoverPrimaryPath,
      });

      const discoveryLedger = discoveryClient.getLedger();
      costEntries.push({
        stage: "discover",
        familyIndex: 0,
        estimatedCostUsd: discoveryLedger.totalEstimatedCostUsd,
        calls: discoveryLedger.totalCalls,
      });
      discoverReporter.log(
        `Done. ${String(seeds.length)} seeds. LLM: ${discoveryLedger.totalCalls} calls, ~$${discoveryLedger.totalEstimatedCostUsd.toFixed(4)}`,
      );
    }

    if (seeds.length === 0) {
      setRunStatus(database, runId, "succeeded");
      log("pipeline", "No seeds to process. Exiting.");
      return;
    }

    if (runConfig.stopAfterStage === "discover") {
      setRunStatus(database, runId, "succeeded");
      log("pipeline", "Stopping after discover (stopAfterStage).");
      return;
    }

    // -----------------------------------------------------------------------
    // Stage 2: Screen
    // -----------------------------------------------------------------------

    let screenJsonPath: string;
    const existingScreenArtifact = succeededArtifact("screen");

    if (existingScreenArtifact) {
      screenJsonPath = existingScreenArtifact;
      log("screen", "Skipped (already succeeded)");
    } else {
      const screenReporter = createStageReporter("screen", outputDir);
      screenReporter.log(`Pre-screening ${String(seeds.length)} seed(s)...`);
      trackStageStart("screen", 0, screenReporter.logPath);
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

      const { families: screenedFamilies, groundingTrace } = await runPreScreen(
        seeds,
        preScreenAdapters,
        {
          llmGrounding: {
            anthropicApiKey: apiKey,
            model: runConfig.screenGroundingModel,
          },
          llmFilter: {
            model: runConfig.screenFilterModel,
            concurrency: runConfig.screenFilterConcurrency,
          },
          skipClaimFamilyFilter:
            runConfig.discoverStrategy === "attribution_first",
        },
        screenReporter.onProgress,
      );

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
      trackStageSuccess("screen", 0, {
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

    if (processable.length === 0) {
      setRunStatus(database, runId, "succeeded");
      log("pipeline", "No greenlit families to process further. Stopping.");
      return;
    }

    if (runConfig.stopAfterStage === "screen") {
      setRunStatus(database, runId, "succeeded");
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

    log(
      "pipeline",
      `Processing ${String(processable.length)} families (concurrency: ${String(runConfig.familyConcurrency)})`,
    );

    await pMap(
      processable,
      async (family, fi) => {
        const familyTag = `F${String(fi + 1)}`;
        log(familyTag, family.seed.trackedClaim.slice(0, 70));

        // --- Extract ---
        const extractReporter = createStageReporter("extract", outputDir, fi);
        extractReporter.log("Extracting citation contexts...");
        trackStageStart("extract", fi, extractReporter.logPath);
        const extraction = await runM2Extraction(
          family,
          extractionAdapters,
          extractReporter.onProgress,
        );

        const { jsonPath: extractJsonPath } = writeExtractionArtifacts({
          outputRoot: outputDir,
          stamp,
          result: extraction,
          sourceArtifacts: [screenJsonPath],
          familyIndex: fi,
        });
        trackStageSuccess("extract", fi, {
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

        // --- Classify ---
        const classifyReporter = createStageReporter("classify", outputDir, fi);
        classifyReporter.log("Classifying citation roles...");
        trackStageStart("classify", fi, classifyReporter.logPath);

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

        const classification = buildPackets(
          extraction,
          "all_functions_census",
          edgeClassifications,
          preScreenEdges,
        );
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
        trackStageSuccess("classify", fi, {
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

        // --- Evidence ---
        const evidenceReporter = createStageReporter("evidence", outputDir, fi);
        evidenceReporter.log(
          "Resolving cited paper and retrieving evidence...",
        );
        trackStageStart("evidence", fi, evidenceReporter.logPath);
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
                fullTextAdapters,
                { db: database, cachePolicy },
              ),
          },
          evidenceReporter.onProgress,
        );

        const llmClient = runConfig.evidenceLlmRerank
          ? createLLMClient({
              apiKey,
              defaultModel: rerankModelId,
            })
          : undefined;

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
            ...(llmClient
              ? {
                  llmClient,
                  llmRerankerOptions: {
                    model: rerankModelId,
                    useThinking: true,
                    topN: runConfig.evidenceRerankTopN,
                  },
                }
              : {}),
          },
        );
        evidenceReporter.onProgress({
          step: "summarize_grounded_coverage",
          status: "completed",
          detail: `${String(evidenceResult.summary.tasksWithEvidence)}/${String(evidenceResult.summary.totalTasks)} tasks matched evidence`,
        });

        const { jsonPath: evidenceJsonPath } = writeEvidenceArtifacts({
          outputRoot: outputDir,
          stamp,
          result: evidenceResult,
          sourceArtifacts: [classifyJsonPath],
          familyIndex: fi,
        });
        trackStageSuccess("evidence", fi, {
          primaryArtifactPath: evidenceJsonPath,
          inputArtifactPath: classifyJsonPath,
        });
        evidenceReporter.log(
          `${String(evidenceResult.summary.tasksWithEvidence)}/${String(evidenceResult.summary.totalTasks)} tasks matched evidence`,
        );

        if (llmClient) {
          const evidenceLedger = llmClient.getLedger();
          if (evidenceLedger.totalCalls > 0) {
            costEntries.push({
              stage: "evidence",
              familyIndex: fi,
              estimatedCostUsd: evidenceLedger.totalEstimatedCostUsd,
              calls: evidenceLedger.totalCalls,
            });
            evidenceReporter.log(
              `LLM reranking: ${evidenceLedger.totalCalls} calls, ~$${evidenceLedger.totalEstimatedCostUsd.toFixed(4)}`,
            );
          }
        }

        if (runConfig.stopAfterStage === "evidence") {
          return;
        }

        // --- Curate ---
        const curateReporter = createStageReporter("curate", outputDir, fi);
        curateReporter.log("Sampling calibration set...");
        trackStageStart("curate", fi, curateReporter.logPath);

        curateReporter.onProgress({
          step: "collect_eligible_tasks",
          status: "running",
        });
        const calibrationSet = sampleCalibrationSet(
          evidenceResult,
          undefined,
          runConfig.curateTargetSize,
        );
        curateReporter.onProgress({
          step: "write_sampling_outputs",
          status: "completed",
          detail: `${String(calibrationSet.records.length)} calibration records`,
        });

        const { jsonPath: curateJsonPath } = writeCalibrationSetArtifacts({
          outputRoot: outputDir,
          stamp,
          result: calibrationSet,
          sourceArtifacts: [evidenceJsonPath],
          familyIndex: fi,
        });
        trackStageSuccess("curate", fi, {
          primaryArtifactPath: curateJsonPath,
          inputArtifactPath: evidenceJsonPath,
        });
        curateReporter.log(
          `${String(calibrationSet.records.length)} calibration records`,
        );

        if (runConfig.stopAfterStage === "curate") {
          return;
        }

        if (calibrationSet.records.length === 0) {
          curateReporter.log(
            "No calibration records — skipping adjudication for this family.",
          );
          return;
        }

        // --- Adjudicate ---
        const adjudicateReporter = createStageReporter(
          "adjudicate",
          outputDir,
          fi,
        );
        adjudicateReporter.log("Running LLM adjudication...");
        trackStageStart("adjudicate", fi, adjudicateReporter.logPath);

        adjudicateReporter.onProgress({
          step: "load_active_records",
          status: "completed",
          detail: `${String(calibrationSet.records.length)} records`,
        });
        adjudicateReporter.onProgress({
          step: "adjudicate_records",
          status: "running",
        });
        const adjudicationResult = await adjudicateCalibrationSet(
          calibrationSet,
          {
            apiKey,
            model: runConfig.adjudicateModel,
            useExtendedThinking: runConfig.adjudicateThinking,
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
        if (adjudicationResult.runTelemetry) {
          costEntries.push({
            stage: "adjudicate",
            familyIndex: fi,
            estimatedCostUsd:
              adjudicationResult.runTelemetry.estimatedCostUsd,
            calls: adjudicationResult.runTelemetry.totalCalls,
          });
        }
        trackStageSuccess("adjudicate", fi, {
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
      },
      { concurrency: runConfig.familyConcurrency },
    );

    writeCostSummary();
    const totalCost = costEntries.reduce(
      (sum, e) => sum + e.estimatedCostUsd,
      0,
    );
    setRunStatus(database, runId, "succeeded");
    log("pipeline", `\nPipeline complete. Run ${runId}`);
    log("pipeline", `Artifacts in ${outputDir}`);
    log("pipeline", `Estimated total LLM cost: ~$${totalCost.toFixed(4)}`);
  } catch (error) {
    trackRunFailed(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    database.close();
  }
}
