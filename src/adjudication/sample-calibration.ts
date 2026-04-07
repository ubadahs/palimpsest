import { randomUUID } from "node:crypto";

import type {
  AdjudicationRecord,
  CalibrationSet,
  EvaluationMode,
  FamilyEvidenceResult,
  TaskWithEvidence,
} from "../domain/types.js";

type SamplingTarget = Partial<Record<EvaluationMode, number>>;

/** Proportions per mode — must sum to 1. */
const MODE_PROPORTIONS: SamplingTarget = {
  fidelity_specific_claim: 0.3,
  fidelity_background_framing: 0.2,
  fidelity_methods_use: 0.15,
  fidelity_bundled_use: 0.2,
  review_transmission: 0.15,
};

const DEFAULT_TOTAL = 40;

function scaleTargets(
  proportions: SamplingTarget,
  totalTarget: number,
): SamplingTarget {
  const entries = Object.entries(proportions) as [EvaluationMode, number][];
  const scaled: SamplingTarget = {};
  let assigned = 0;

  for (let i = 0; i < entries.length; i++) {
    const [mode, proportion] = entries[i]!;
    if (i === entries.length - 1) {
      // Last mode gets the remainder to avoid rounding drift
      scaled[mode] = totalTarget - assigned;
    } else {
      const count = Math.round(proportion * totalTarget);
      scaled[mode] = count;
      assigned += count;
    }
  }

  return scaled;
}

type ScoredTask = {
  task: TaskWithEvidence;
  citingPaperTitle: string;
  citedPaperTitle: string;
  priority: number;
  oversampled: string[];
};

function prioritize(
  task: TaskWithEvidence,
  _citingPaperTitle: string,
): { priority: number; tags: string[] } {
  let priority = 0;
  const tags: string[] = [];

  if (task.modifiers.isBundled && task.citationRole === "background_context") {
    priority += 3;
    tags.push("bundled_background");
  }
  if (
    task.modifiers.isReviewMediated &&
    task.citationRole === "substantive_attribution"
  ) {
    priority += 3;
    tags.push("review_mediated_substantive");
  }
  if (
    task.evidenceRetrievalStatus === "retrieved" &&
    task.citedPaperEvidenceSpans.length > 0 &&
    task.citedPaperEvidenceSpans[0]!.relevanceScore < 10
  ) {
    priority += 2;
    tags.push("ambiguous_retrieval_fit");
  }
  if (
    task.evaluationMode === "manual_review_role_ambiguous" &&
    task.mentions.length > 0 &&
    task.mentions[0]!.confidence === "high"
  ) {
    priority += 2;
    tags.push("high_confidence_unclear");
  }
  if (task.modifiers.isBundled) {
    priority += 1;
    tags.push("bundled");
  }

  return { priority, tags };
}

function taskToRecord(
  task: TaskWithEvidence,
  citingPaperTitle: string,
  citedPaperTitle: string,
  groundedSeedClaimText: string | undefined,
): AdjudicationRecord {
  const bestMention = task.mentions[0];

  return {
    recordId: randomUUID(),
    taskId: task.taskId,
    evaluationMode: task.evaluationMode,
    citationRole: task.citationRole,
    modifiers: task.modifiers,

    citingPaperTitle,
    citedPaperTitle,
    groundedSeedClaimText,

    citingSpan: bestMention?.rawContext ?? "",
    citingSpanSection: bestMention?.sectionTitle,
    citingMarker: bestMention?.citationMarker ?? "",

    rubricQuestion: task.rubricQuestion,
    evidenceSpans: task.citedPaperEvidenceSpans,
    evidenceRetrievalStatus: task.evidenceRetrievalStatus,

    verdict: undefined,
    rationale: undefined,
    retrievalQuality: undefined,
    judgeConfidence: undefined,
    adjudicator: undefined,
    adjudicatedAt: undefined,
    excluded: undefined,
    excludeReason: undefined,
    telemetry: undefined,
  };
}

export function sampleCalibrationSet(
  evidence: FamilyEvidenceResult,
  targets?: SamplingTarget,
  totalTarget: number = DEFAULT_TOTAL,
): CalibrationSet {
  const effectiveTargets =
    targets ?? scaleTargets(MODE_PROPORTIONS, totalTarget);
  const allTasks: ScoredTask[] = [];

  for (const edge of evidence.edges) {
    for (const task of edge.tasks) {
      if (task.evidenceRetrievalStatus === "not_attempted") continue;

      const { priority, tags } = prioritize(task, edge.citingPaperTitle);
      allTasks.push({
        task,
        citingPaperTitle: edge.citingPaperTitle,
        citedPaperTitle: edge.citedPaperTitle,
        priority,
        oversampled: tags,
      });
    }
  }

  const records: AdjudicationRecord[] = [];
  const selectedIds = new Set<string>();
  const oversampled: string[] = [];

  const byMode = new Map<EvaluationMode, ScoredTask[]>();
  for (const st of allTasks) {
    const mode = st.task.evaluationMode;
    const existing = byMode.get(mode);
    if (existing) {
      existing.push(st);
    } else {
      byMode.set(mode, [st]);
    }
  }

  for (const [, tasks] of byMode) {
    tasks.sort((a, b) => b.priority - a.priority);
  }

  for (const [targetMode, target] of Object.entries(effectiveTargets) as [
    EvaluationMode,
    number,
  ][]) {
    const pool = byMode.get(targetMode) ?? [];
    let taken = 0;

    for (const st of pool) {
      if (taken >= target || records.length >= totalTarget) break;
      if (selectedIds.has(st.task.taskId)) continue;

      selectedIds.add(st.task.taskId);
      records.push(
        taskToRecord(
          st.task,
          st.citingPaperTitle,
          st.citedPaperTitle,
          evidence.groundedSeedClaimText,
        ),
      );
      if (st.oversampled.length > 0) oversampled.push(...st.oversampled);
      taken++;
    }
  }

  if (records.length < totalTarget) {
    const remaining = allTasks
      .filter((st) => !selectedIds.has(st.task.taskId))
      .sort((a, b) => b.priority - a.priority);

    for (const st of remaining) {
      if (records.length >= totalTarget) break;
      selectedIds.add(st.task.taskId);
      records.push(
        taskToRecord(
          st.task,
          st.citingPaperTitle,
          st.citedPaperTitle,
          evidence.groundedSeedClaimText,
        ),
      );
      if (st.oversampled.length > 0) oversampled.push(...st.oversampled);
    }
  }

  return {
    seed: evidence.seed,
    resolvedSeedPaperTitle: evidence.resolvedSeedPaperTitle,
    studyMode: evidence.studyMode,
    createdAt: new Date().toISOString(),
    targetSize: totalTarget,
    records,
    samplingStrategy: {
      targetByMode: effectiveTargets,
      oversampled: [...new Set(oversampled)],
    },
    runTelemetry: undefined,
  };
}
