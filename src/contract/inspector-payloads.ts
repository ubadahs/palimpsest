import { z } from "zod";

import type { ClaimDiscoveryResult } from "../domain/discovery.js";
import type {
  AuditSample,
  ClaimFamilyPreScreen,
  FamilyClassificationResult,
  FamilyEvidenceResult,
  FamilyExtractionResult,
} from "../domain/types.js";
import type { StageKey } from "./run-types.js";

/** Attribution-first discovery primary JSON shape (compact summaries). */
export const attributionDiscoverySummarySchema = z.array(
  z
    .object({
      doi: z.string(),
      resolvedPaper: z.unknown().optional(),
      neighborhood: z
        .object({
          totalCitingPapers: z.number(),
          fullTextAvailableCount: z.number(),
        })
        .passthrough(),
      probeSelection: z
        .object({
          strategy: z.string(),
          selectedCount: z.number(),
          excludedCount: z.number(),
        })
        .passthrough(),
      mentionsHarvested: z.number(),
      inScopeExtractions: z.number(),
      rawFamilyCandidateCount: z.number().optional(),
      familyCandidateCount: z.number(),
      dedupeMergedCount: z.number().optional(),
      shortlistEntries: z.array(z.record(z.string(), z.unknown())),
      warnings: z.array(z.string()),
    })
    .passthrough(),
);
export type AttributionDiscoverySummary = z.infer<
  typeof attributionDiscoverySummarySchema
>;

export function buildLegacyDiscoverInspectorPayload(
  data: ClaimDiscoveryResult[],
) {
  return {
    strategy: "legacy" as const,
    papers: data.map((result) => ({
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
          (entry) => entry.claimIndex === i,
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
export type LegacyDiscoverInspectorPayload = ReturnType<
  typeof buildLegacyDiscoverInspectorPayload
>;

export function buildAttributionDiscoverInspectorPayload(
  data: AttributionDiscoverySummary,
) {
  return {
    strategy: "attribution_first" as const,
    results: data.map((result) => ({
      doi: result.doi,
      neighborhood: result.neighborhood,
      probeSelection: result.probeSelection,
      mentionsHarvested: result.mentionsHarvested,
      inScopeExtractions: result.inScopeExtractions,
      rawFamilyCandidateCount:
        "rawFamilyCandidateCount" in result
          ? result.rawFamilyCandidateCount
          : undefined,
      familyCandidateCount: result.familyCandidateCount,
      dedupeMergedCount:
        "dedupeMergedCount" in result ? result.dedupeMergedCount : undefined,
      shortlistEntries: result.shortlistEntries,
      warnings: result.warnings,
    })),
  };
}
export type AttributionDiscoverInspectorPayload = ReturnType<
  typeof buildAttributionDiscoverInspectorPayload
>;

export function buildScreenInspectorPayload(data: ClaimFamilyPreScreen[]) {
  return {
    families: data.map((family) => ({
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
export type ScreenInspectorPayload = ReturnType<
  typeof buildScreenInspectorPayload
>;

export function buildExtractInspectorPayload(data: FamilyExtractionResult) {
  return {
    seed: data.seed,
    summary: data.summary,
    edgeResults: data.edgeResults.map((edge) => ({
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
export type ExtractInspectorPayload = ReturnType<
  typeof buildExtractInspectorPayload
>;

export function buildClassifyInspectorPayload(
  data: FamilyClassificationResult,
) {
  return {
    seed: data.seed,
    summary: data.summary,
    packets: data.packets.map((packet) => ({
      packetId: packet.packetId,
      citingPaperTitle: packet.citingPaper.title,
      citingPaperDoi: packet.citingPaper.doi,
      citedPaperDoi: packet.citedPaper.doi,
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
export type ClassifyInspectorPayload = ReturnType<
  typeof buildClassifyInspectorPayload
>;

export function buildEvidenceInspectorPayload(data: FamilyEvidenceResult) {
  return {
    seed: data.seed,
    summary: data.summary,
    citedPaperSource: data.citedPaperSource,
    edges: data.edges.map((edge) => ({
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
export type EvidenceInspectorPayload = ReturnType<
  typeof buildEvidenceInspectorPayload
>;

export function buildCurateInspectorPayload(data: AuditSample) {
  return {
    seed: data.seed,
    summary: data.samplingStrategy,
    records: data.records.map((record) => ({
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
export type CurateInspectorPayload = ReturnType<
  typeof buildCurateInspectorPayload
>;

export function buildAdjudicateInspectorPayload(data: AuditSample) {
  const partiallySupported = data.records.filter(
    (record) => record.verdict === "partially_supported",
  );

  // Advisor passthrough fields are present at runtime when adjudicateAdvisor
  // was enabled. They survive serialization via AuditSample's .passthrough().
  const raw = data as Record<string, unknown>;
  const advisorInfo =
    typeof raw["escalationCount"] === "number"
      ? {
          escalationCount: raw["escalationCount"],
          firstPassTelemetry: raw["firstPassTelemetry"] as
            | AuditSample["runTelemetry"]
            | undefined,
          escalationTelemetry: raw["escalationTelemetry"] as
            | AuditSample["runTelemetry"]
            | undefined,
        }
      : undefined;

  return {
    seed: data.seed,
    runTelemetry: data.runTelemetry,
    /** Present when adjudication used the two-pass advisor strategy. */
    advisor: advisorInfo,
    defaultVerdictFilter: "partially_supported" as const,
    verdictCounts: {
      supported: data.records.filter((record) => record.verdict === "supported")
        .length,
      partially_supported: partiallySupported.length,
      overstated_or_generalized: data.records.filter(
        (record) => record.verdict === "overstated_or_generalized",
      ).length,
      not_supported: data.records.filter(
        (record) => record.verdict === "not_supported",
      ).length,
      cannot_determine: data.records.filter(
        (record) => record.verdict === "cannot_determine",
      ).length,
    },
    highlightedTaskIds: partiallySupported.map((record) => record.taskId),
    records: data.records.map((record) => ({
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
      groundedSeedClaimText: record.groundedSeedClaimText,
      comparison: record.comparison,
      evidenceSpans: record.evidenceSpans,
    })),
  };
}
export type AdjudicateInspectorPayload = ReturnType<
  typeof buildAdjudicateInspectorPayload
>;

export type StageArtifactMap = {
  discover: ClaimDiscoveryResult[] | AttributionDiscoverySummary;
  screen: ClaimFamilyPreScreen[];
  extract: FamilyExtractionResult;
  classify: FamilyClassificationResult;
  evidence: FamilyEvidenceResult;
  curate: AuditSample;
  adjudicate: AuditSample;
};

export type StageInspectorPayloadMap = {
  discover:
    | LegacyDiscoverInspectorPayload
    | AttributionDiscoverInspectorPayload;
  screen: ScreenInspectorPayload;
  extract: ExtractInspectorPayload;
  classify: ClassifyInspectorPayload;
  evidence: EvidenceInspectorPayload;
  curate: CurateInspectorPayload;
  adjudicate: AdjudicateInspectorPayload;
};

export type StageInspectorPayload<K extends StageKey = StageKey> =
  StageInspectorPayloadMap[K];
