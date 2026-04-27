import type Database from "better-sqlite3";

import type { AppConfig } from "../config/app-config.js";
import {
  type CachePolicy,
  type ClaimFamilyPreScreen,
  type EdgeClassification,
  type PreScreenEdge,
  type ResolvedPaper,
  type Result,
  type TaskWithEvidence,
} from "../domain/types.js";
import type { DiscoveryHandoffMap } from "../domain/discovery-handoff.js";
import {
  createLLMClient,
  isFatalProviderError,
  type LLMTelemetryCollector,
} from "../integrations/llm-client.js";
import {
  resolvePaperByDoi,
  resolvePaperByMetadata,
} from "../integrations/paper-resolver.js";
import { adjudicateAuditSample } from "../adjudication/llm-adjudicator.js";
import { sampleAuditSet } from "../adjudication/sample-audit.js";
import { buildPackets } from "../classification/build-packets.js";
import type { AnalysisRunConfig, StageKey } from "../contract/run-types.js";
import { resolveCitedPaperSource } from "./evidence.js";
import { runM2Extraction } from "./extract.js";
import type { RunTracker } from "./run-tracker.js";
import type { FullTextFetchAdapters } from "../retrieval/fulltext-fetch.js";
import { retrieveEvidence } from "../retrieval/evidence-retrieval.js";
import type { LocalReranker } from "../retrieval/local-reranker.js";
import {
  materializeLocalPdf,
  materializeParsedPaper,
} from "../retrieval/parsed-paper.js";
import {
  writeAdjudicationArtifacts,
  writeAuditSampleArtifacts,
  writeClassificationArtifacts,
  writeEvidenceArtifacts,
  writeExtractionArtifacts,
} from "../cli/stage-artifact-writers.js";
import { createStageReporter, log } from "../cli/stage-reporter.js";

type ExtractionCacheValue = {
  resolvedSeedPaper: Awaited<
    ReturnType<typeof runM2Extraction>
  >["resolvedSeedPaper"];
  edgeResults: Awaited<ReturnType<typeof runM2Extraction>>["edgeResults"];
  summary: Awaited<ReturnType<typeof runM2Extraction>>["summary"];
};

type ClassificationCacheValue = {
  resolvedSeedPaperTitle: string;
  packets: ReturnType<typeof buildPackets>["packets"];
  summary: ReturnType<typeof buildPackets>["summary"];
  studyMode: ReturnType<typeof buildPackets>["studyMode"];
};

export type FamilyRunFatalProviderFailure = {
  message: string;
  stageKey: StageKey;
  familyIndex: number;
};

export type FamilyRunFatalProviderState = {
  current: FamilyRunFatalProviderFailure | undefined;
};

export type FamilyRunCaches = {
  extraction: Map<string, ExtractionCacheValue>;
  classification: Map<string, ClassificationCacheValue>;
};

export type RunFamilyStagesParams = {
  family: ClaimFamilyPreScreen;
  familyIndex: number;
  screenJsonPath: string;
  outputDir: string;
  stamp: string;
  apiKey: string;
  database: Database.Database;
  config: AppConfig;
  runConfig: AnalysisRunConfig;
  cachePolicy: CachePolicy;
  fullTextAdapters: FullTextFetchAdapters;
  reranker: LocalReranker | undefined;
  rerankModelId: string;
  telemetryCollector: LLMTelemetryCollector;
  tracker: RunTracker;
  discoveryHandoffs: DiscoveryHandoffMap | undefined;
  caches: FamilyRunCaches;
  fatalProviderFailure: FamilyRunFatalProviderState;
};

function buildExtractionCacheKey(family: ClaimFamilyPreScreen): string {
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
  family: ClaimFamilyPreScreen,
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

export async function runFamilyStages(
  params: RunFamilyStagesParams,
): Promise<void> {
  const {
    family,
    familyIndex: fi,
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
  } = params;

  if (fatalProviderFailure.current) {
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
    const cachedExtraction = caches.extraction.get(extractionCacheKey);

    // For attribution-first runs, extend adapters with pre-harvested mentions
    // so probed papers skip the full-text fetch. Non-probed papers fall back.
    const extractionAdapters = {
      fullText: fullTextAdapters,
      biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
      cache: { db: database, cachePolicy },
    };
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
      caches.extraction.set(extractionCacheKey, {
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

    if (fatalProviderFailure.current) {
      return;
    }

    // --- Classify ---
    currentStageKey = "classify";
    const classifyReporter = createStageReporter("classify", outputDir, fi);
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
    const cachedClassification = caches.classification.get(
      classificationCacheKey,
    );
    const classification = cachedClassification
      ? {
          seed: extraction.seed,
          resolvedSeedPaperTitle: cachedClassification.resolvedSeedPaperTitle,
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
      caches.classification.set(classificationCacheKey, {
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

    if (fatalProviderFailure.current) {
      return;
    }

    // --- Evidence ---
    currentStageKey = "evidence";
    const evidenceReporter = createStageReporter("evidence", outputDir, fi);
    evidenceReporter.log("Resolving cited paper and retrieving evidence...");
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
              semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
              openAlexEmail: config.openAlexEmail,
              semanticScholarApiKey: config.semanticScholarApiKey,
            }),
          ),
        resolveByMetadata: async (locator) =>
          patchAvailability(
            await resolvePaperByMetadata(locator, {
              openAlexBaseUrl: config.providerBaseUrls.openAlex,
              semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
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

    if (fatalProviderFailure.current) {
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
      const curatedTaskIds = new Set(auditSample.records.map((r) => r.taskId));
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
          record.evidenceRetrievalStatus = reranked.evidenceRetrievalStatus;
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
    curateReporter.log(`${String(auditSample.records.length)} audit records`);

    if (runConfig.stopAfterStage === "curate") {
      return;
    }

    if (auditSample.records.length === 0) {
      curateReporter.log(
        "No audit records — skipping adjudication for this family.",
      );
      return;
    }

    if (fatalProviderFailure.current) {
      return;
    }

    // --- Adjudicate ---
    currentStageKey = "adjudicate";
    const adjudicateReporter = createStageReporter("adjudicate", outputDir, fi);
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
    const supported = verdicts.filter((r) => r.verdict === "supported").length;
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
      fatalProviderFailure.current ??= {
        message: error.message,
        stageKey: currentStageKey,
        familyIndex: fi,
      };
      tracker.blockPendingFamilyStages(error.message);
    }
    throw error;
  }
}
