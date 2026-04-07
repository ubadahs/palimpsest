import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { z } from "zod";

import {
  calibrationSetSchema,
  familyClassificationResultSchema,
  familyEvidenceResultSchema,
  familyExtractionResultSchema,
  preScreenResultsSchema,
} from "../domain/types.js";
import { claimDiscoveryResultSchema } from "../domain/discovery.js";
import {
  artifactManifestSchema,
  loadJsonArtifact,
  manifestPathForArtifact,
} from "../shared/artifact-io.js";
import type { ArtifactManifest } from "../shared/artifact-io.js";
import type { CalibrationSet } from "../domain/types.js";
import { getStageDefinition } from "./stages.js";
import type {
  AnalysisRunStageStatus,
  AnalysisStageSummary,
  StageArtifactPointer,
  StageKey,
} from "./run-types.js";
import {
  isGenericStageErrorMessage,
  summarizeFailureDetail,
} from "./workflow.js";

type ArtifactLoadResult =
  | {
      kind: "discover";
      data: ReturnType<typeof claimDiscoveryResultSchema.parse>[];
    }
  | {
      kind: "screen";
      data: ReturnType<typeof preScreenResultsSchema.parse>;
    }
  | {
      kind: "extract";
      data: ReturnType<typeof familyExtractionResultSchema.parse>;
    }
  | {
      kind: "classify";
      data: ReturnType<typeof familyClassificationResultSchema.parse>;
    }
  | {
      kind: "evidence";
      data: ReturnType<typeof familyEvidenceResultSchema.parse>;
    }
  | {
      kind: "curate";
      data: ReturnType<typeof calibrationSetSchema.parse>;
    }
  | {
      kind: "adjudicate";
      data: ReturnType<typeof calibrationSetSchema.parse>;
    };

export type StageArtifactSet = {
  primaryArtifactPath?: string;
  reportArtifactPath?: string;
  manifestPath?: string;
  extraArtifacts: StageArtifactPointer[];
};

function metric(
  label: string,
  value: string | number,
): {
  label: string;
  value: string;
} {
  return { label, value: String(value) };
}

const discoveryResultsArraySchema = z.array(claimDiscoveryResultSchema);

function loadArtifactForStage(
  stageKey: StageKey,
  artifactPath: string,
): ArtifactLoadResult {
  if (stageKey === "discover") {
    return {
      kind: stageKey,
      data: loadJsonArtifact(
        artifactPath,
        discoveryResultsArraySchema,
        "discovery results",
      ),
    };
  }

  if (stageKey === "screen") {
    return {
      kind: stageKey,
      data: loadJsonArtifact(
        artifactPath,
        preScreenResultsSchema,
        "screen results",
      ),
    };
  }

  if (stageKey === "extract") {
    return {
      kind: stageKey,
      data: loadJsonArtifact(
        artifactPath,
        familyExtractionResultSchema,
        "extraction results",
      ),
    };
  }

  if (stageKey === "classify") {
    return {
      kind: stageKey,
      data: loadJsonArtifact(
        artifactPath,
        familyClassificationResultSchema,
        "classification results",
      ),
    };
  }

  if (stageKey === "evidence") {
    return {
      kind: stageKey,
      data: loadJsonArtifact(
        artifactPath,
        familyEvidenceResultSchema,
        "evidence results",
      ),
    };
  }

  return {
    kind: stageKey,
    data: loadJsonArtifact(
      artifactPath,
      calibrationSetSchema,
      stageKey === "curate" ? "calibration set" : "llm calibration",
    ),
  };
}

export function listStageArtifacts(
  stageKey: StageKey,
  stageDirectory: string,
): StageArtifactSet {
  const definition = getStageDefinition(stageKey);
  const entries = existsSync(stageDirectory) ? readdirSync(stageDirectory) : [];

  function findLatestBySuffix(suffix: string): string | undefined {
    return entries
      .filter((entry) => entry.endsWith(suffix))
      .sort()
      .at(-1);
  }

  const primaryName = findLatestBySuffix(
    definition.artifactGlobs.primarySuffix,
  );
  const reportName = findLatestBySuffix(definition.artifactGlobs.reportSuffix);
  const primaryArtifactPath = primaryName
    ? resolve(stageDirectory, primaryName)
    : undefined;
  const reportArtifactPath = reportName
    ? resolve(stageDirectory, reportName)
    : undefined;
  const manifestPath =
    primaryArtifactPath &&
    existsSync(manifestPathForArtifact(primaryArtifactPath))
      ? manifestPathForArtifact(primaryArtifactPath)
      : undefined;
  const extraArtifacts = definition.artifactGlobs.extraSuffixes
    .map((suffix) => {
      const match = findLatestBySuffix(suffix);
      return match
        ? {
            kind: suffix.replace(/^_/, "").replace(/\.[^.]+$/, ""),
            path: resolve(stageDirectory, match),
          }
        : undefined;
    })
    .filter((item): item is StageArtifactPointer => item != null);

  const artifactSet: StageArtifactSet = {
    extraArtifacts,
  };

  if (primaryArtifactPath) {
    artifactSet.primaryArtifactPath = primaryArtifactPath;
  }
  if (reportArtifactPath) {
    artifactSet.reportArtifactPath = reportArtifactPath;
  }
  if (manifestPath) {
    artifactSet.manifestPath = manifestPath;
  }

  return artifactSet;
}

export function readArtifactManifest(
  manifestPath: string | undefined,
): ArtifactManifest | undefined {
  if (!manifestPath || !existsSync(manifestPath)) {
    return undefined;
  }

  return artifactManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
  );
}

function summarizeCalibration(
  calibration: CalibrationSet,
  label: string,
): AnalysisStageSummary {
  const active = calibration.records.filter((record) => !record.excluded);
  const verdicts = active.filter((record) => record.verdict != null);
  const partial = active.filter(
    (record) => record.verdict === "partially_supported",
  ).length;

  return {
    headline: label,
    metrics: [
      metric("Records", calibration.records.length),
      metric("Active", active.length),
      metric("Judged", verdicts.length),
      metric("Partial", partial),
    ],
    artifacts: [],
  };
}

export function deriveStageSummary(
  stageKey: StageKey,
  artifactPath: string | undefined,
  artifactPointers: StageArtifactPointer[] = [],
  context?: {
    stageStatus?: AnalysisRunStageStatus;
    errorMessage?: string;
  },
): AnalysisStageSummary | undefined {
  if (!artifactPath || !existsSync(artifactPath)) {
    return undefined;
  }

  let artifact: ReturnType<typeof loadArtifactForStage>;
  try {
    artifact = loadArtifactForStage(stageKey, artifactPath);
  } catch {
    return undefined;
  }

  const failedStage =
    context?.stageStatus === "failed" ||
    context?.stageStatus === "cancelled" ||
    context?.stageStatus === "interrupted";
  const failureHeadline =
    context?.errorMessage && !isGenericStageErrorMessage(context.errorMessage)
      ? summarizeFailureDetail(context.errorMessage)
      : undefined;

  if (artifact.kind === "discover") {
    const completed = artifact.data.filter((r) => r.status === "completed");
    const findings = artifact.data.reduce((s, r) => s + r.findingCount, 0);
    const total = artifact.data.reduce((s, r) => s + r.totalClaimCount, 0);
    const firstFailure = artifact.data.find((result) => result.status !== "completed");

    return {
      headline:
        failureHeadline ??
        (failedStage
          ? (firstFailure?.statusDetail ??
            "Claim discovery stopped before extraction could be finalized.")
          : "Discovered claim units"),
      metrics: [
        metric("Papers", artifact.data.length),
        metric("Completed", completed.length),
        metric("Claims", total),
        metric("Findings", findings),
      ],
      artifacts: artifactPointers,
    };
  }

  if (artifact.kind === "screen") {
    const greenlit = artifact.data.filter(
      (entry) => entry.decision === "greenlight",
    );
    const edges = artifact.data.reduce(
      (count, entry) => count + entry.edges.length,
      0,
    );

    return {
      headline: failureHeadline ?? "Family viability and auditability",
      metrics: [
        metric("Families", artifact.data.length),
        metric("Greenlit", greenlit.length),
        metric("Edges", edges),
      ],
      artifacts: artifactPointers,
    };
  }

  if (artifact.kind === "extract") {
    return {
      headline: failureHeadline ?? "Citation extraction outcomes",
      metrics: [
        metric("Usable edges", artifact.data.summary.successfulEdgesUsable),
        metric("Mentions", artifact.data.summary.deduplicatedMentionCount),
        metric("Usable mentions", artifact.data.summary.usableMentionCount),
      ],
      artifacts: artifactPointers,
    };
  }

  if (artifact.kind === "classify") {
    return {
      headline: failureHeadline ?? "Evaluation task packets",
      metrics: [
        metric("Tasks", artifact.data.summary.literatureStructure.totalTasks),
        metric(
          "Edges with mentions",
          artifact.data.summary.literatureStructure.edgesWithMentions,
        ),
        metric(
          "Manual review",
          artifact.data.summary.literatureStructure.manualReviewTaskCount,
        ),
      ],
      artifacts: artifactPointers,
    };
  }

  if (artifact.kind === "evidence") {
    return {
      headline: failureHeadline ?? "Retrieved evidence blocks",
      metrics: [
        metric("Tasks", artifact.data.summary.totalTasks),
        metric("With evidence", artifact.data.summary.tasksWithEvidence),
        metric("Evidence spans", artifact.data.summary.totalEvidenceSpans),
      ],
      artifacts: artifactPointers,
    };
  }

  if (artifact.kind === "curate") {
    return {
      ...summarizeCalibration(
        artifact.data,
        failureHeadline ?? "Calibration set",
      ),
      artifacts: artifactPointers,
    };
  }

  return {
    ...summarizeCalibration(artifact.data, failureHeadline ?? "LLM verdicts"),
    artifacts: artifactPointers,
  };
}

export function buildStageInspectorPayload(
  stageKey: StageKey,
  artifactPath: string,
): unknown {
  const artifact = loadArtifactForStage(stageKey, artifactPath);

  if (artifact.kind === "discover") {
    return {
      papers: artifact.data.map((result) => ({
        doi: result.doi,
        title: result.resolvedPaper?.title,
        status: result.status,
        statusDetail: result.statusDetail,
        findingCount: result.findingCount,
        totalClaimCount: result.totalClaimCount,
        ranking: result.ranking
          ? { citingPapersAnalyzed: result.ranking.citingPapersAnalyzed }
          : undefined,
        claims: result.claims.map((claim, i) => {
          const engagement = result.ranking?.engagements.find(
            (e) => e.claimIndex === i,
          );
          const rank = engagement
            ? result.ranking!.engagements.indexOf(engagement) + 1
            : undefined;
          return {
            claimText: claim.claimText,
            section: claim.section,
            claimType: claim.claimType,
            confidence: claim.confidence,
            citedReferences: claim.citedReferences,
            rank,
            directCount: engagement?.directCount ?? 0,
            indirectCount: engagement?.indirectCount ?? 0,
          };
        }),
      })),
    };
  }

  if (artifact.kind === "screen") {
    return {
      families: artifact.data.map((family) => ({
        seedDoi: family.seed.doi,
        trackedClaim: family.seed.trackedClaim,
        decision: family.decision,
        decisionReason: family.decisionReason,
        familyUseProfile: family.familyUseProfile,
        m2Priority: family.m2Priority,
        metrics: family.metrics,
        edges: family.edges.map((edge) => ({
          citingPaperId: edge.citingPaperId,
          auditabilityStatus: edge.auditabilityStatus,
          auditabilityReason: edge.auditabilityReason,
          paperType: edge.paperType,
          referencedWorksCount: edge.referencedWorksCount,
          classification: edge.classification,
        })),
      })),
    };
  }

  if (artifact.kind === "extract") {
    return {
      seed: artifact.data.seed,
      summary: artifact.data.summary,
      edgeResults: artifact.data.edgeResults.map((edge) => ({
        citingPaperId: edge.citingPaperId,
        citingPaperTitle: edge.citingPaperTitle,
        extractionOutcome: edge.extractionOutcome,
        extractionSuccess: edge.extractionSuccess,
        usableForGrounding: edge.usableForGrounding,
        mentionCount: edge.mentions.length,
        failureReason: edge.failureReason,
        mentions: edge.mentions.map((mention) => ({
          mentionIndex: mention.mentionIndex,
          rawContext: mention.rawContext,
          citationMarker: mention.citationMarker,
          sectionTitle: mention.sectionTitle,
          markerStyle: mention.markerStyle,
          contextType: mention.contextType,
          confidence: mention.confidence,
          isDuplicate: mention.isDuplicate,
          isBundledCitation: mention.isBundledCitation,
          bundlePattern: mention.bundlePattern,
        })),
      })),
    };
  }

  if (artifact.kind === "classify") {
    return {
      seed: artifact.data.seed,
      summary: artifact.data.summary,
      packets: artifact.data.packets.map((packet) => ({
        packetId: packet.packetId,
        citingPaperTitle: packet.citingPaper.title,
        extractionState: packet.extractionState,
        citationRoles: packet.rolesPresent,
        isReviewMediated: packet.isReviewMediated,
        requiresManualReview: packet.requiresManualReview,
        tasks: packet.tasks.map((task) => ({
          taskId: task.taskId,
          evaluationMode: task.evaluationMode,
          citationRole: task.citationRole,
          mentionCount: task.mentionCount,
          bundled: task.modifiers.isBundled,
          reviewMediated: task.modifiers.isReviewMediated,
        })),
      })),
    };
  }

  if (artifact.kind === "evidence") {
    return {
      seed: artifact.data.seed,
      summary: artifact.data.summary,
      citedPaperSource: artifact.data.citedPaperSource,
      edges: artifact.data.edges.map((edge) => ({
        packetId: edge.packetId,
        citingPaperTitle: edge.citingPaperTitle,
        citedPaperTitle: edge.citedPaperTitle,
        extractionState: edge.extractionState,
        isReviewMediated: edge.isReviewMediated,
        tasks: edge.tasks.map((task) => ({
          taskId: task.taskId,
          evaluationMode: task.evaluationMode,
          citationRole: task.citationRole,
          modifiers: task.modifiers,
          rubricQuestion: task.rubricQuestion,
          evidenceRetrievalStatus: task.evidenceRetrievalStatus,
          citingMentions: task.mentions.map((mention) => ({
            mentionIndex: mention.mentionIndex,
            rawContext: mention.rawContext,
            citationMarker: mention.citationMarker,
            sectionTitle: mention.sectionTitle,
          })),
          evidenceSpans: task.citedPaperEvidenceSpans.map((span) => ({
            spanId: span.spanId,
            text: span.text,
            sectionTitle: span.sectionTitle,
            blockKind: span.blockKind,
            matchMethod: span.matchMethod,
            relevanceScore: span.relevanceScore,
            bm25Score: span.bm25Score,
            rerankScore: span.rerankScore,
          })),
        })),
      })),
    };
  }

  if (artifact.kind === "curate") {
    return {
      summary: artifact.data.samplingStrategy,
      records: artifact.data.records.map((record) => ({
        recordId: record.recordId,
        taskId: record.taskId,
        evaluationMode: record.evaluationMode,
        citationRole: record.citationRole,
        citingPaperTitle: record.citingPaperTitle,
        citedPaperTitle: record.citedPaperTitle,
        excluded: record.excluded,
        excludeReason: record.excludeReason,
        evidenceRetrievalStatus: record.evidenceRetrievalStatus,
        evidenceCount: record.evidenceSpans.length,
      })),
    };
  }

  const partiallySupported = artifact.data.records.filter(
    (record) => record.verdict === "partially_supported",
  );

  return {
    runTelemetry: artifact.data.runTelemetry,
    defaultVerdictFilter: "partially_supported",
    verdictCounts: {
      supported: artifact.data.records.filter(
        (record) => record.verdict === "supported",
      ).length,
      partially_supported: partiallySupported.length,
      overstated_or_generalized: artifact.data.records.filter(
        (record) => record.verdict === "overstated_or_generalized",
      ).length,
      not_supported: artifact.data.records.filter(
        (record) => record.verdict === "not_supported",
      ).length,
      cannot_determine: artifact.data.records.filter(
        (record) => record.verdict === "cannot_determine",
      ).length,
    },
    highlightedTaskIds: partiallySupported.map((record) => record.taskId),
    records: artifact.data.records.map((record) => ({
      recordId: record.recordId,
      taskId: record.taskId,
      evaluationMode: record.evaluationMode,
      citationRole: record.citationRole,
      citingPaperTitle: record.citingPaperTitle,
      citedPaperTitle: record.citedPaperTitle,
      verdict: record.verdict,
      rationale: record.rationale,
      retrievalQuality: record.retrievalQuality,
      judgeConfidence: record.judgeConfidence,
      excluded: record.excluded,
      excludeReason: record.excludeReason,
      citingSpan: record.citingSpan,
      rubricQuestion: record.rubricQuestion,
      evidenceSpans: record.evidenceSpans,
    })),
  };
}

export function artifactLabel(path: string): string {
  return basename(path);
}
