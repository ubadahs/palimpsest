import { randomUUID } from "node:crypto";

import type {
  AdjudicationRecord,
  CalibrationSet,
  EvaluationMode,
  FamilyEvidenceResult,
  TaskWithEvidence,
} from "../domain/types.js";

type SamplingTarget = Partial<Record<EvaluationMode, number>>;

const DEFAULT_TARGETS: SamplingTarget = {
  fidelity_specific_claim: 12,
  fidelity_background_framing: 8,
  fidelity_methods_use: 6,
  fidelity_bundled_use: 8,
  review_transmission: 6,
};

const DEFAULT_TOTAL = 40;

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
  targets: SamplingTarget = DEFAULT_TARGETS,
  totalTarget: number = DEFAULT_TOTAL,
): CalibrationSet {
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

  for (const [targetMode, target] of Object.entries(targets) as [
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
        taskToRecord(st.task, st.citingPaperTitle, st.citedPaperTitle),
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
        taskToRecord(st.task, st.citingPaperTitle, st.citedPaperTitle),
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
      targetByMode: targets,
      oversampled: [...new Set(oversampled)],
    },
    runTelemetry: undefined,
  };
}
