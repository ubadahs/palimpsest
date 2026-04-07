import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type {
  CachePolicy,
  ClaimDiscoveryResult,
  EdgeClassification,
  PreScreenEdge,
} from "../../domain/types.js";
import {
  claimFamilyBlocksDownstream,
  shortlistInputSchema,
} from "../../domain/types.js";
import { discoveryInputSchema } from "../../domain/discovery.js";
import { resolvePaperByDoi, resolvePaperByMetadata } from "../../integrations/paper-resolver.js";
import { createLLMClient } from "../../integrations/llm-client.js";
import * as openalex from "../../integrations/openalex.js";
import { discoverClaims } from "../../pipeline/claim-discovery.js";
import { rankClaimsByEngagement } from "../../pipeline/claim-ranking.js";
import {
  runPreScreen,
  type PreScreenAdapters,
} from "../../pipeline/pre-screen.js";
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
  loadJsonArtifact,
  writeJsonArtifact,
} from "../../shared/artifact-io.js";
import { nextRunStamp } from "../run-stamp.js";
import { toPreScreenMarkdown } from "../../reporting/pre-screen-report.js";
import {
  toM2Json,
  toM2Markdown,
} from "../../reporting/extraction-report.js";
import {
  toClassificationJson,
  toClassificationMarkdown,
} from "../../reporting/classification-report.js";
import {
  toEvidenceJson,
  toEvidenceMarkdown,
} from "../../reporting/evidence-report.js";
import {
  toCalibrationJson,
  toCalibrationMarkdown,
} from "../../reporting/adjudication-report.js";
import { toCalibrationSummaryMarkdown } from "../../reporting/calibration-summary.js";

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
} {
  let input: string | undefined;
  let shortlist: string | undefined;
  let output = "data/pipeline";
  let topN = 5;
  let noRank = false;
  let targetSize = 40;

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
    }
  }

  if (!input && !shortlist) {
    console.error(
      "Usage: pipeline --input <dois.json> [--shortlist <shortlist.json>] [--output <dir>] [--top N] [--no-rank] [--target-size N]",
    );
    process.exitCode = 1;
    throw new Error("Missing --input or --shortlist");
  }

  return { input, shortlist, output, topN, noRank, targetSize };
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
    const stamp = nextRunStamp(outputDir);

    // -----------------------------------------------------------------------
    // Stage 1: Discover (or load shortlist)
    // -----------------------------------------------------------------------

    type SeedEntry = { doi: string; trackedClaim: string; notes?: string | undefined };
    let seeds: SeedEntry[];

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
      log("discover", `Extracting claims from ${String(inputData.dois.length)} paper(s)...`);

      const discoveryClient = createLLMClient({
        apiKey: config.anthropicApiKey,
        defaultModel: "claude-opus-4-6",
      });

      const allResults: ClaimDiscoveryResult[] = [];
      seeds = [];

      for (const doi of inputData.dois) {
        log("discover", `Resolving ${doi}...`);
        const resolved = await resolvePaperByDoi(doi, {
          openAlexBaseUrl: config.providerBaseUrls.openAlex,
          semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
          openAlexEmail: config.openAlexEmail,
          semanticScholarApiKey: config.semanticScholarApiKey,
        });

        if (!resolved.ok) {
          log("discover", `Could not resolve ${doi}: ${resolved.error}`);
          continue;
        }
        log("discover", `Resolved: ${resolved.data.title}`);

        const materialized = await materializeParsedPaper(
          resolved.data,
          config.providerBaseUrls.bioRxiv,
          fullTextAdapters,
          { db: database, cachePolicy },
        );

        if (!materialized.ok) {
          log("discover", `No full text for ${doi}: ${materialized.error}`);
          continue;
        }
        log("discover", `Parsed ${String(materialized.data.parsedDocument.blocks.length)} blocks`);

        const result = await discoverClaims({
          paper: resolved.data,
          parsedDocument: materialized.data.parsedDocument,
          client: discoveryClient,
        });
        log("discover", `Extracted ${String(result.totalClaimCount)} claims (${String(result.findingCount)} findings)`);

        // Rank by citing-paper engagement
        if (!args.noRank && result.status === "completed" && result.claims.length > 0) {
          log("discover", `Ranking claims against citing papers...`);
          const citingResult = await openalex.getCitingWorks(
            resolved.data.id,
            config.providerBaseUrls.openAlex,
            200,
            config.openAlexEmail,
          );

          if (citingResult.ok && citingResult.data.length > 0) {
            const ranking = await rankClaimsByEngagement({
              seedTitle: resolved.data.title,
              claims: result.claims,
              citingPapers: citingResult.data,
              client: discoveryClient,
            });
            result.ranking = ranking;
            const withDirect = ranking.engagements.filter(
              (e) => e.directCount > 0,
            ).length;
            log("discover", `${String(withDirect)} claims with direct citing-paper engagement`);
          }
        }

        allResults.push(result);

        // Build seeds from this result
        if (result.ranking) {
          const topFindings = result.ranking.engagements
            .filter((e) => e.claimType === "finding" && e.directCount > 0)
            .slice(0, args.topN);
          for (const e of topFindings) {
            seeds.push({
              doi,
              trackedClaim: e.claimText,
              notes: `Auto-discovered; ${String(e.directCount)} direct, ${String(e.indirectCount)} indirect engagements`,
            });
          }
        } else {
          const findings = result.claims
            .filter((c) => c.claimType === "finding")
            .slice(0, args.topN);
          for (const c of findings) {
            seeds.push({
              doi,
              trackedClaim: c.claimText,
              notes: "Auto-discovered (unranked)",
            });
          }
        }
      }

      // Write discover artifacts
      writeJsonArtifact(
        resolve(outputDir, `${stamp}_discovery-results.json`),
        allResults,
      );
      writeJsonArtifact(
        resolve(outputDir, `${stamp}_discovery-shortlist.json`),
        { seeds },
      );

      const discoveryLedger = discoveryClient.getLedger();
      log("discover", `Done. ${String(seeds.length)} seeds. LLM: ${discoveryLedger.totalCalls} calls, ~$${discoveryLedger.totalEstimatedCostUsd.toFixed(4)}`);
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
        },
      },
      (event) => {
        if (event.status === "completed") {
          log("screen", `${event.step}: ${event.detail ?? "done"}`);
        }
      },
    );

    // Write screen artifacts
    const screenJsonPath = resolve(outputDir, `${stamp}_pre-screen-results.json`);
    const screenMdPath = resolve(outputDir, `${stamp}_pre-screen-report.md`);
    const screenTracePath = resolve(outputDir, `${stamp}_pre-screen-grounding-trace.json`);
    writeJsonArtifact(screenJsonPath, families);
    writeJsonArtifact(screenTracePath, groundingTrace);
    writeFileSync(screenMdPath, toPreScreenMarkdown(families, { groundingTraceFileName: `${stamp}_pre-screen-grounding-trace.json` }), "utf8");

    const greenlit = families.filter((f) => f.decision === "greenlight");
    const blocked = families.filter((f) => claimFamilyBlocksDownstream(f));
    log("screen", `${String(greenlit.length)} greenlit, ${String(blocked.length)} blocked, ${String(families.length - greenlit.length - blocked.length)} deprioritized`);

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
    const rerankModelId = "claude-haiku-4-5";

    for (let fi = 0; fi < processable.length; fi++) {
      const family = processable[fi]!;
      const familyLabel = `[${String(fi + 1)}/${String(processable.length)}] ${family.seed.trackedClaim.slice(0, 60)}...`;
      log("pipeline", `\nProcessing family: ${familyLabel}`);

      // --- Extract ---
      log("extract", "Extracting citation contexts...");
      const extraction = await runM2Extraction(family, extractionAdapters, (event) => {
        if (event.status === "completed") {
          log("extract", `${event.step}: ${event.detail ?? "done"}`);
        }
      });

      const extractJsonPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_extraction.json`);
      const extractMdPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_extraction.md`);
      writeFileSync(extractJsonPath, toM2Json(extraction), "utf8");
      writeFileSync(extractMdPath, toM2Markdown(extraction), "utf8");
      log("extract", `${String(extraction.summary.successfulEdgesUsable)} usable edges, ${String(extraction.summary.usableMentionCount)} usable mentions`);

      if (extraction.summary.successfulEdgesUsable === 0) {
        log("extract", "No usable edges — skipping downstream stages for this family.");
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

      const classifyJsonPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_classification.json`);
      const classifyMdPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_classification.md`);
      writeFileSync(classifyJsonPath, toClassificationJson(classification), "utf8");
      writeFileSync(classifyMdPath, toClassificationMarkdown(classification), "utf8");
      log("classify", `${String(classification.summary.literatureStructure.totalTasks)} tasks from ${String(classification.summary.literatureStructure.edgesWithMentions)} edges`);

      if (classification.summary.literatureStructure.totalTasks === 0) {
        log("classify", "No evaluation tasks — skipping downstream stages for this family.");
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
          llmRerankerOptions: { model: rerankModelId, useThinking: true },
        },
      );

      const evidenceJsonPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_evidence.json`);
      const evidenceMdPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_evidence.md`);
      writeFileSync(evidenceJsonPath, toEvidenceJson(evidenceResult), "utf8");
      writeFileSync(evidenceMdPath, toEvidenceMarkdown(evidenceResult), "utf8");
      log("evidence", `${String(evidenceResult.summary.tasksWithEvidence)}/${String(evidenceResult.summary.totalTasks)} tasks matched evidence`);

      const evidenceLedger = llmClient.getLedger();
      if (evidenceLedger.totalCalls > 0) {
        log("evidence", `LLM reranking: ${evidenceLedger.totalCalls} calls, ~$${evidenceLedger.totalEstimatedCostUsd.toFixed(4)}`);
      }

      // --- Curate ---
      log("curate", "Sampling calibration set...");
      const calibrationSet = sampleCalibrationSet(
        evidenceResult,
        undefined,
        args.targetSize,
      );

      const curateJsonPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_calibration.json`);
      const curateMdPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_calibration-worksheet.md`);
      writeFileSync(curateJsonPath, toCalibrationJson(calibrationSet), "utf8");
      writeFileSync(curateMdPath, toCalibrationMarkdown(calibrationSet), "utf8");
      log("curate", `${String(calibrationSet.records.length)} calibration records`);

      if (calibrationSet.records.length === 0) {
        log("curate", "No calibration records — skipping adjudication for this family.");
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

      const adjJsonPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_adjudication.json`);
      const adjSummaryPath = resolve(outputDir, `${stamp}_family-${String(fi + 1)}_adjudication-summary.md`);
      writeFileSync(adjJsonPath, toCalibrationJson(adjudicationResult), "utf8");
      writeFileSync(adjSummaryPath, toCalibrationSummaryMarkdown(adjudicationResult), "utf8");

      const verdicts = adjudicationResult.records.filter(
        (r) => !r.excluded && r.verdict != null,
      );
      const supported = verdicts.filter((r) => r.verdict === "supported").length;
      const partial = verdicts.filter((r) => r.verdict === "partially_supported").length;
      const notSupported = verdicts.filter((r) => r.verdict === "not_supported").length;
      log("adjudicate", `${String(verdicts.length)} verdicts: ${String(supported)} supported, ${String(partial)} partial, ${String(notSupported)} not supported`);
    }

    log("pipeline", `\nPipeline complete. All artifacts in ${outputDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
