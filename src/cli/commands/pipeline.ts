import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type {
  CachePolicy,
  EdgeClassification,
  PreScreenEdge,
} from "../../domain/types.js";
import {
  claimFamilyBlocksDownstream,
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

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  input: string | undefined;
  shortlist: string | undefined;
  output: string;
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
} {
  let input: string | undefined;
  let shortlist: string | undefined;
  let output = "data/pipeline";
  let topN = 5;
  let noRank = false;
  let targetSize = 40;
  let strategy: DiscoveryStrategy = "legacy";
  let probeBudget = 20;
  let shortlistCap = 10;
  let screenGroundingModel: string | undefined;
  let screenFilterModel: string | undefined;
  let screenFilterConcurrency: number | undefined;
  let rerankModel: string | undefined;
  let rerankTopN: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && i + 1 < argv.length) {
      input = argv[i + 1];
      i++;
    } else if (arg === "--shortlist" && i + 1 < argv.length) {
      shortlist = argv[i + 1];
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
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
    }
  }

  if (!input && !shortlist) {
    console.error(
      "Usage: pipeline --input <dois.json> [--shortlist <shortlist.json>] [--output <dir>] [--top N] [--no-rank] [--target-size N] [--strategy legacy|attribution_first] [--probe-budget N] [--shortlist-cap N] [--screen-grounding-model <model>] [--screen-filter-model <model>] [--screen-filter-concurrency N] [--rerank-model <model>] [--rerank-top-n N]",
    );
    process.exitCode = 1;
    throw new Error("Missing --input or --shortlist");
  }

  return {
    input,
    shortlist,
    output,
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
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(stage: string, message: string): void {
  console.info(`[${stage}] ${message}`);
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

  try {
    runMigrations(database);

    const cachePolicy: CachePolicy = "prefer_cache";
    const fullTextAdapters = createDefaultAdapters(
      config.providerBaseUrls.grobid,
      config.openAlexEmail,
    );

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });
    const stamp = nextRunStampFromDirectories([
      outputDir,
      ...stageDefinitions.map((stage) =>
        resolveStageOutputDir(outputDir, stage.key),
      ),
    ]);

    // -----------------------------------------------------------------------
    // Stage 1: Discover (or load shortlist)
    // -----------------------------------------------------------------------

    let seeds: DiscoverySeedEntry[];
    let screenInputArtifactPath: string | undefined = args.shortlist;

    if (args.shortlist) {
      log("discover", `Loading shortlist from ${args.shortlist}`);
      const loaded = loadJsonArtifact(
        args.shortlist,
        shortlistInputSchema,
        "shortlist input",
      );
      seeds = loaded.seeds;
      log("discover", `${String(seeds.length)} seed(s) loaded`);
    } else {
      const inputData = loadJsonArtifact(
        args.input!,
        discoveryInputSchema,
        "discovery input",
      );
      const strategyLabel =
        args.strategy === "attribution_first"
          ? "attribution-first"
          : "legacy";
      log(
        "discover",
        `Discovering from ${String(inputData.dois.length)} paper(s) [${strategyLabel}]...`,
      );

      const discoveryClient = createLLMClient({
        apiKey: config.anthropicApiKey,
        defaultModel: "claude-opus-4-6",
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
          topN: args.topN,
          rank: !args.noRank,
          strategy: args.strategy,
          ...(args.strategy === "attribution_first"
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
                    apiKey: config.anthropicApiKey,
                    llmClient: discoveryClient,
                  },
                },
                attributionOptions: {
                  probeBudget: args.probeBudget,
                  shortlistCap: args.shortlistCap,
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
        (event) => {
          if (event.status === "completed") {
            log("discover", `${event.step}: ${event.detail}`);
          }
        },
      );
      seeds = discoveryStage.seeds;

      let shortlistPath: string;
      if (
        args.strategy === "attribution_first" &&
        discoveryStage.attributionDiscovery
      ) {
        const artifacts = writeAttributionDiscoveryArtifacts({
          outputRoot: outputDir,
          stamp,
          results: discoveryStage.attributionDiscovery,
          seeds: discoveryStage.seeds,
          sourceArtifacts: [args.input!],
        });
        shortlistPath = artifacts.shortlistPath;
      } else {
        const artifacts = writeDiscoveryArtifacts({
          outputRoot: outputDir,
          stamp,
          results: discoveryStage.results,
          seeds: discoveryStage.seeds,
          sourceArtifacts: [args.input!],
        });
        shortlistPath = artifacts.shortlistPath;
      }
      screenInputArtifactPath = shortlistPath;

      const discoveryLedger = discoveryClient.getLedger();
      log(
        "discover",
        `Done. ${String(seeds.length)} seeds. LLM: ${discoveryLedger.totalCalls} calls, ~$${discoveryLedger.totalEstimatedCostUsd.toFixed(4)}`,
      );
    }

    if (seeds.length === 0) {
      log("pipeline", "No seeds to process. Exiting.");
      return;
    }

    // -----------------------------------------------------------------------
    // Stage 2: Screen
    // -----------------------------------------------------------------------

    log("screen", `Pre-screening ${String(seeds.length)} seed(s)...`);
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

    const { families, groundingTrace } = await runPreScreen(
      seeds,
      preScreenAdapters,
      {
        llmGrounding: {
          anthropicApiKey: config.anthropicApiKey,
          ...(args.screenGroundingModel != null
            ? { model: args.screenGroundingModel }
            : {}),
        },
        ...(args.screenFilterModel != null ||
        args.screenFilterConcurrency != null
          ? {
              llmFilter: {
                ...(args.screenFilterModel != null
                  ? { model: args.screenFilterModel }
                  : {}),
                ...(args.screenFilterConcurrency != null
                  ? { concurrency: args.screenFilterConcurrency }
                  : {}),
              },
            }
          : {}),
      },
      (event) => {
        if (event.status === "completed") {
          log("screen", `${event.step}: ${event.detail ?? "done"}`);
        }
      },
    );

    // Write screen artifacts
    const { jsonPath: screenJsonPath } = writeScreenArtifacts({
      outputRoot: outputDir,
      stamp,
      families,
      groundingTrace,
      sourceArtifacts: screenInputArtifactPath ? [screenInputArtifactPath] : [],
    });

    const greenlit = families.filter((f) => f.decision === "greenlight");
    const blocked = families.filter((f) => claimFamilyBlocksDownstream(f));
    log(
      "screen",
      `${String(greenlit.length)} greenlit, ${String(blocked.length)} blocked, ${String(families.length - greenlit.length - blocked.length)} deprioritized`,
    );

    // Filter to families that can proceed
    const processable = families.filter(
      (f) => f.decision === "greenlight" && !claimFamilyBlocksDownstream(f),
    );

    if (processable.length === 0) {
      log("pipeline", "No greenlit families to process further. Stopping.");
      return;
    }

    // -----------------------------------------------------------------------
    // Stages 3-7: Extract → Classify → Evidence → Curate → Adjudicate
    // (per family, sequential)
    // -----------------------------------------------------------------------

    const extractionAdapters = {
      fullText: fullTextAdapters,
      biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
      cache: { db: database, cachePolicy },
    };

    const reranker = createLocalReranker(config.localRerankerBaseUrl);
    const rerankModelId = args.rerankModel ?? "claude-haiku-4-5";

    for (let fi = 0; fi < processable.length; fi++) {
      const family = processable[fi]!;
      const familyLabel = `[${String(fi + 1)}/${String(processable.length)}] ${family.seed.trackedClaim.slice(0, 60)}...`;
      log("pipeline", `\nProcessing family: ${familyLabel}`);

      // --- Extract ---
      log("extract", "Extracting citation contexts...");
      const extraction = await runM2Extraction(
        family,
        extractionAdapters,
        (event) => {
          if (event.status === "completed") {
            log("extract", `${event.step}: ${event.detail ?? "done"}`);
          }
        },
      );

      const { jsonPath: extractJsonPath } = writeExtractionArtifacts({
        outputRoot: outputDir,
        stamp,
        result: extraction,
        sourceArtifacts: [screenJsonPath],
        familyIndex: fi,
      });
      log(
        "extract",
        `${String(extraction.summary.successfulEdgesUsable)} usable edges, ${String(extraction.summary.usableMentionCount)} usable mentions`,
      );

      if (extraction.summary.successfulEdgesUsable === 0) {
        log(
          "extract",
          "No usable edges — skipping downstream stages for this family.",
        );
        continue;
      }

      // --- Classify ---
      log("classify", "Classifying citation roles...");
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

      const { jsonPath: classifyJsonPath } = writeClassificationArtifacts({
        outputRoot: outputDir,
        stamp,
        result: classification,
        sourceArtifacts: [extractJsonPath, screenJsonPath],
        familyIndex: fi,
      });
      log(
        "classify",
        `${String(classification.summary.literatureStructure.totalTasks)} tasks from ${String(classification.summary.literatureStructure.edgesWithMentions)} edges`,
      );

      if (classification.summary.literatureStructure.totalTasks === 0) {
        log(
          "classify",
          "No evaluation tasks — skipping downstream stages for this family.",
        );
        continue;
      }

      // --- Evidence ---
      log("evidence", "Resolving cited paper and retrieving evidence...");
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
        (event) => {
          if (event.status === "completed") {
            log("evidence", `${event.step}: ${event.detail ?? "done"}`);
          }
        },
      );

      const llmClient = createLLMClient({
        apiKey: config.anthropicApiKey,
        defaultModel: rerankModelId,
      });

      const evidenceResult = await retrieveEvidence(
        classification,
        citedPaperMaterialized.citedPaperSource,
        citedPaperMaterialized.citedPaperParsedDocument,
        {
          ...(reranker ? { reranker } : {}),
          llmClient,
          llmRerankerOptions: {
            model: rerankModelId,
            useThinking: true,
            ...(args.rerankTopN != null ? { topN: args.rerankTopN } : {}),
          },
        },
      );

      const { jsonPath: evidenceJsonPath } = writeEvidenceArtifacts({
        outputRoot: outputDir,
        stamp,
        result: evidenceResult,
        sourceArtifacts: [classifyJsonPath],
        familyIndex: fi,
      });
      log(
        "evidence",
        `${String(evidenceResult.summary.tasksWithEvidence)}/${String(evidenceResult.summary.totalTasks)} tasks matched evidence`,
      );

      const evidenceLedger = llmClient.getLedger();
      if (evidenceLedger.totalCalls > 0) {
        log(
          "evidence",
          `LLM reranking: ${evidenceLedger.totalCalls} calls, ~$${evidenceLedger.totalEstimatedCostUsd.toFixed(4)}`,
        );
      }

      // --- Curate ---
      log("curate", "Sampling calibration set...");
      const calibrationSet = sampleCalibrationSet(
        evidenceResult,
        undefined,
        args.targetSize,
      );

      const { jsonPath: curateJsonPath } = writeCalibrationSetArtifacts({
        outputRoot: outputDir,
        stamp,
        result: calibrationSet,
        sourceArtifacts: [evidenceJsonPath],
        familyIndex: fi,
      });
      log(
        "curate",
        `${String(calibrationSet.records.length)} calibration records`,
      );

      if (calibrationSet.records.length === 0) {
        log(
          "curate",
          "No calibration records — skipping adjudication for this family.",
        );
        continue;
      }

      // --- Adjudicate ---
      log("adjudicate", "Running LLM adjudication...");
      const adjudicationResult = await adjudicateCalibrationSet(
        calibrationSet,
        {
          apiKey: config.anthropicApiKey,
          model: "claude-opus-4-6",
          useExtendedThinking: true,
        },
        (i, total) => {
          if (i % 5 === 0 || i === total) {
            log("adjudicate", `${String(i)}/${String(total)} records`);
          }
        },
      );

      writeAdjudicationArtifacts({
        outputRoot: outputDir,
        stamp,
        result: adjudicationResult,
        sourceArtifacts: [curateJsonPath],
        model: "claude-opus-4-6",
        familyIndex: fi,
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
      log(
        "adjudicate",
        `${String(verdicts.length)} verdicts: ${String(supported)} supported, ${String(partial)} partial, ${String(notSupported)} not supported`,
      );
    }

    log("pipeline", `\nPipeline complete. All artifacts in ${outputDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
