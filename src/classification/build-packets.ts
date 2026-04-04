import { randomUUID } from "node:crypto";

import type {
  AuditabilityStatus,
  CitationRole,
  ClassificationSummary,
  ClassifiedMention,
  Confidence,
  EdgeClassification,
  EdgeEvaluationPacket,
  EvaluationMode,
  EvaluationTask,
  ExtractionState,
  ExtractionStateSummary,
  FamilyClassificationResult,
  FamilyExtractionResult,
  LiteratureStructureSummary,
  PreScreenEdge,
  StudyMode,
  TransmissionModifiers,
} from "../domain/types.js";
import { classifyMention } from "./classify-citation-function.js";
import { deriveEvaluationMode } from "./evaluation-mode.js";

// --- Extraction state derivation ---

function deriveExtractionState(outcome: string): ExtractionState {
  if (outcome.startsWith("success")) return "extracted";
  if (outcome.startsWith("skipped")) return "skipped";
  return "failed";
}

function edgeConfidence(
  extractionSuccess: boolean,
  mentionCount: number,
): Confidence {
  if (!extractionSuccess || mentionCount === 0) return "low";
  if (mentionCount >= 3) return "high";
  return "medium";
}

// --- Task generation from mention clusters ---

function groupMentionsByRole(
  mentions: ClassifiedMention[],
): Map<CitationRole, ClassifiedMention[]> {
  const groups = new Map<CitationRole, ClassifiedMention[]>();
  for (const m of mentions) {
    const existing = groups.get(m.citationRole);
    if (existing) {
      existing.push(m);
    } else {
      groups.set(m.citationRole, [m]);
    }
  }
  return groups;
}

function buildTasks(
  mentions: ClassifiedMention[],
  edgeModifiers: TransmissionModifiers,
  extractionConfidence: Confidence,
): EvaluationTask[] {
  const groups = groupMentionsByRole(mentions);
  const tasks: EvaluationTask[] = [];

  for (const [role, cluster] of groups) {
    const clusterHasBundled = cluster.some((m) => m.modifiers.isBundled);
    const taskModifiers: TransmissionModifiers = {
      isBundled: clusterHasBundled,
      isReviewMediated: edgeModifiers.isReviewMediated,
    };

    tasks.push({
      taskId: randomUUID(),
      evaluationMode: deriveEvaluationMode(
        role,
        taskModifiers,
        extractionConfidence,
      ),
      citationRole: role,
      modifiers: taskModifiers,
      mentions: cluster,
      mentionCount: cluster.length,
    });
  }

  return tasks;
}

// --- Packet assembly ---

export function buildPackets(
  extraction: FamilyExtractionResult,
  studyMode: StudyMode,
  edgeClassifications: Record<string, EdgeClassification>,
  preScreenEdges?: Record<string, PreScreenEdge>,
): FamilyClassificationResult {
  const seedPaper = extraction.resolvedSeedPaper;
  const packets: EdgeEvaluationPacket[] = [];

  for (const edge of extraction.edgeResults) {
    const edgeClass = edgeClassifications[edge.citingPaperId];
    const psEdge = preScreenEdges?.[edge.citingPaperId];
    const isReviewPaper = edgeClass?.isReview ?? false;

    const classified: ClassifiedMention[] = edge.mentions.map((m) =>
      classifyMention(m, isReviewPaper),
    );

    const edgeModifiers: TransmissionModifiers = {
      isBundled: classified.some((m) => m.modifiers.isBundled),
      isReviewMediated: isReviewPaper,
    };

    const confidence = edgeConfidence(
      edge.extractionSuccess,
      classified.length,
    );
    const tasks = buildTasks(classified, edgeModifiers, confidence);
    const rolesPresent = [...new Set(classified.map((m) => m.citationRole))];

    const usableMentions = classified.filter(
      (m) => m.confidence !== "low" || m.contextType === "narrative_like",
    );
    const bundledMentions = classified.filter((m) => m.isBundledCitation);

    const requiresManualReview =
      tasks.some(
        (t) =>
          t.evaluationMode === "manual_review_role_ambiguous" ||
          t.evaluationMode === "manual_review_extraction_limited",
      ) ||
      (edge.usableForGrounding === "unknown" && classified.length > 0);

    const auditabilityStatus: AuditabilityStatus =
      psEdge?.auditabilityStatus ?? "not_auditable";

    packets.push({
      packetId: randomUUID(),
      studyMode,

      citingPaper: {
        id: edge.citingPaperId,
        doi: undefined,
        title: edge.citingPaperTitle,
        paperType: edgeClass?.isReview
          ? "review"
          : (psEdge?.paperType ?? undefined),
      },
      citedPaper: {
        id: edge.citedPaperId,
        doi: seedPaper.doi,
        pmcid: seedPaper.pmcid,
        pmid: seedPaper.pmid,
        title: seedPaper.title,
        authors: seedPaper.authors,
        publicationYear: seedPaper.publicationYear,
      },

      extractionState: deriveExtractionState(edge.extractionOutcome),
      extractionOutcome: edge.extractionOutcome,
      auditabilityStatus,
      sourceType: edge.sourceType,
      extractionConfidence: confidence,
      usableForGrounding: edge.usableForGrounding,
      failureReason: edge.failureReason,

      mentions: classified,
      tasks,
      rolesPresent,

      isReviewMediated: isReviewPaper,
      requiresManualReview,

      usableMentionsCount: usableMentions.length,
      bundledMentionsCount: bundledMentions.length,

      cachedPaperRef: undefined,

      provenance: {
        preScreenRunId: undefined,
        extractionRunId: undefined,
        classificationTimestamp: new Date().toISOString(),
      },
    });
  }

  const summary = computeSummary(packets);

  return {
    seed: extraction.seed,
    resolvedSeedPaperTitle: seedPaper?.title ?? extraction.seed.doi,
    studyMode,
    packets,
    summary,
  };
}

// --- Summary: two separate layers ---

function emptyRoleCounts(): Record<CitationRole, number> {
  return {
    substantive_attribution: 0,
    background_context: 0,
    methods_materials: 0,
    acknowledgment_or_low_information: 0,
    unclear: 0,
  };
}

function emptyModeCounts(): Record<EvaluationMode, number> {
  return {
    fidelity_specific_claim: 0,
    fidelity_background_framing: 0,
    fidelity_bundled_use: 0,
    fidelity_methods_use: 0,
    review_transmission: 0,
    skip_low_information: 0,
    manual_review_role_ambiguous: 0,
    manual_review_extraction_limited: 0,
  };
}

function computeSummary(
  packets: EdgeEvaluationPacket[],
): ClassificationSummary {
  // Extraction state layer
  let extracted = 0;
  let failed = 0;
  let skipped = 0;
  const failureCounts: Record<string, number> = {};

  for (const p of packets) {
    if (p.extractionState === "extracted") extracted++;
    else if (p.extractionState === "skipped") skipped++;
    else {
      failed++;
      const count = failureCounts[p.extractionOutcome] ?? 0;
      failureCounts[p.extractionOutcome] = count + 1;
    }
  }

  const extractionStateSummary: ExtractionStateSummary = {
    totalEdges: packets.length,
    extracted,
    failed,
    skipped,
    failureCountsByOutcome: failureCounts,
  };

  // Literature structure layer (only from edges with mentions)
  const withMentions = packets.filter((p) => p.mentions.length > 0);
  const roleCounts = emptyRoleCounts();
  const modeCounts = emptyModeCounts();
  let totalMentions = 0;
  let totalTasks = 0;
  let bundledMentions = 0;
  let reviewMediatedEdges = 0;
  let manualReviewTasks = 0;

  for (const p of withMentions) {
    totalMentions += p.mentions.length;
    totalTasks += p.tasks.length;
    bundledMentions += p.bundledMentionsCount;
    if (p.isReviewMediated) reviewMediatedEdges++;

    for (const t of p.tasks) {
      roleCounts[t.citationRole]++;
      modeCounts[t.evaluationMode]++;
      if (
        t.evaluationMode === "manual_review_role_ambiguous" ||
        t.evaluationMode === "manual_review_extraction_limited"
      ) {
        manualReviewTasks++;
      }
    }
  }

  const mentionDenom = totalMentions || 1;
  const edgeDenom = withMentions.length || 1;

  const literatureStructure: LiteratureStructureSummary = {
    edgesWithMentions: withMentions.length,
    totalMentions,
    totalTasks,
    countsByRole: roleCounts,
    countsByMode: modeCounts,
    bundledMentionCount: bundledMentions,
    bundledMentionRate: bundledMentions / mentionDenom,
    reviewMediatedEdgeCount: reviewMediatedEdges,
    reviewMediatedEdgeRate: reviewMediatedEdges / edgeDenom,
    manualReviewTaskCount: manualReviewTasks,
  };

  return {
    extractionState: extractionStateSummary,
    literatureStructure,
  };
}
