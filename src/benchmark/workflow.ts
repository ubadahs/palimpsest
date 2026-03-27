import type {
  AdjudicationRecord,
  CalibrationSet,
} from "../domain/types.js";
import type {
  AdjudicationDelta,
  AdjudicationDeltaSet,
  BenchmarkDiffEntry,
  BenchmarkDiffResult,
  BlindAdjudicationRecord,
  BlindCalibrationSet,
} from "./types.js";

function blindRecord(record: AdjudicationRecord): BlindAdjudicationRecord {
  const blind = { ...record } as Record<string, unknown>;
  delete blind["verdict"];
  delete blind["rationale"];
  delete blind["retrievalQuality"];
  delete blind["judgeConfidence"];
  delete blind["adjudicator"];
  delete blind["adjudicatedAt"];
  delete blind["telemetry"];
  return blind as BlindAdjudicationRecord;
}

export function createBlindCalibrationSet(
  set: CalibrationSet,
): BlindCalibrationSet {
  return {
    ...set,
    version: set.version ? `${set.version}-blind` : "blind-benchmark",
    revisionNote: "Blind benchmark export",
    records: set.records.map(blindRecord),
  };
}

function makeIndex(records: AdjudicationRecord[]): Map<string, AdjudicationRecord> {
  return new Map(records.map((record) => [record.taskId, record]));
}

export function diffCalibrationSets(
  base: CalibrationSet,
  candidate: CalibrationSet,
): BenchmarkDiffResult {
  const baseIndex = makeIndex(base.records);
  const candidateIndex = makeIndex(candidate.records);
  const allTaskIds = new Set<string>([
    ...base.records.map((record) => record.taskId),
    ...candidate.records.map((record) => record.taskId),
  ]);

  const entries: BenchmarkDiffEntry[] = [];
  let changedVerdicts = 0;
  let changedRationales = 0;
  let changedExclusions = 0;
  let missingInBase = 0;
  let missingInCandidate = 0;

  for (const taskId of allTaskIds) {
    const baseRecord = baseIndex.get(taskId);
    const candidateRecord = candidateIndex.get(taskId);
    const missingBase = !baseRecord;
    const missingCandidateRecord = !candidateRecord;
    const verdictChanged = baseRecord?.verdict !== candidateRecord?.verdict;
    const rationaleChanged = baseRecord?.rationale !== candidateRecord?.rationale;
    const retrievalQualityChanged =
      baseRecord?.retrievalQuality !== candidateRecord?.retrievalQuality;
    const exclusionChanged =
      baseRecord?.excluded !== candidateRecord?.excluded ||
      baseRecord?.excludeReason !== candidateRecord?.excludeReason;

    if (verdictChanged) changedVerdicts++;
    if (rationaleChanged) changedRationales++;
    if (exclusionChanged) changedExclusions++;
    if (missingBase) missingInBase++;
    if (missingCandidateRecord) missingInCandidate++;

    const baseOrder = base.records.findIndex((record) => record.taskId === taskId);
    const candidateOrder = candidate.records.findIndex(
      (record) => record.taskId === taskId,
    );

    entries.push({
      taskId,
      citingPaperTitle:
        baseRecord?.citingPaperTitle ??
        candidateRecord?.citingPaperTitle ??
        taskId,
      recordOrder:
        baseOrder >= 0
          ? baseOrder
          : candidateOrder >= 0
            ? candidateOrder
            : 0,
      baseVerdict: baseRecord?.verdict,
      candidateVerdict: candidateRecord?.verdict,
      verdictChanged,
      rationaleChanged,
      retrievalQualityChanged,
      exclusionChanged,
      missingInBase: missingBase,
      missingInCandidate: missingCandidateRecord,
    });
  }

  entries.sort((left, right) => left.recordOrder - right.recordOrder);

  return {
    summary: {
      totalBaseRecords: base.records.length,
      totalCandidateRecords: candidate.records.length,
      changedVerdicts,
      changedRationales,
      changedExclusions,
      missingInBase,
      missingInCandidate,
    },
    entries,
  };
}

function indexDeltas(deltas: AdjudicationDelta[]): Map<string, AdjudicationDelta> {
  const index = new Map<string, AdjudicationDelta>();
  for (const delta of deltas) {
    if (index.has(delta.taskId)) {
      throw new Error(`Duplicate delta for taskId ${delta.taskId}`);
    }
    index.set(delta.taskId, delta);
  }
  return index;
}

function applyDelta(
  record: AdjudicationRecord,
  delta: AdjudicationDelta,
): AdjudicationRecord {
  const targetsExcludedRecord = record.excluded === true;
  const changesExclusion =
    delta.excluded !== undefined || delta.excludeReason !== undefined;
  if ((targetsExcludedRecord || changesExclusion) && delta.allowExcludedChange !== true) {
    throw new Error(
      `Delta for taskId ${delta.taskId} touches an excluded record or exclusion fields without allowExcludedChange`,
    );
  }

  return {
    ...record,
    verdict: delta.finalVerdict,
    rationale: delta.rationale ?? record.rationale,
    retrievalQuality: delta.retrievalQuality ?? record.retrievalQuality,
    judgeConfidence: delta.judgeConfidence ?? record.judgeConfidence,
    excluded: delta.excluded ?? record.excluded,
    excludeReason: delta.excludeReason ?? record.excludeReason,
  };
}

export function applyCalibrationDeltas(
  base: CalibrationSet,
  deltaSet: AdjudicationDeltaSet,
): CalibrationSet {
  const deltaIndex = indexDeltas(deltaSet.deltas);

  for (const taskId of deltaIndex.keys()) {
    if (!base.records.some((record) => record.taskId === taskId)) {
      throw new Error(`Unknown taskId in delta set: ${taskId}`);
    }
  }

  const records = base.records.map((record) => {
    const delta = deltaIndex.get(record.taskId);
    if (!delta) {
      return record;
    }
    return applyDelta(record, delta);
  });

  return {
    ...base,
    records,
    version: deltaSet.version ?? base.version,
    revisionNote: deltaSet.revisionNote ?? base.revisionNote,
  };
}
