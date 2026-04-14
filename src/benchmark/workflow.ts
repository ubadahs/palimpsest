import type {
  AdjudicationRecord,
  AdjudicationVerdict,
  AuditSample,
} from "../domain/types.js";
import type {
  AdjudicationDelta,
  AdjudicationDeltaSet,
  BenchmarkDiffEntry,
  BenchmarkDiffResult,
  BlindAdjudicationRecord,
  BlindAuditRecord,
  BlindAuditSample,
  BenchmarkSummary,
  BenchmarkSummaryEntry,
} from "./types.js";

function blindRecord(record: AdjudicationRecord): BlindAuditRecord {
  if (record.excluded === true) {
    return { ...record };
  }

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

export function createBlindAuditSample(set: AuditSample): BlindAuditSample {
  return {
    ...set,
    version: set.version ? `${set.version}-blind` : "blind-benchmark",
    revisionNote: "Blind benchmark export",
    records: set.records.map(blindRecord),
  };
}

function makeIndex(
  records: AdjudicationRecord[],
): Map<string, AdjudicationRecord> {
  return new Map(records.map((record) => [record.taskId, record]));
}

function isExcludedRecord(record: AdjudicationRecord | undefined): boolean {
  return record?.excluded === true;
}

function shouldIgnoreAdjudicationDiff(
  baseRecord: AdjudicationRecord | undefined,
  candidateRecord: AdjudicationRecord | undefined,
): boolean {
  return isExcludedRecord(baseRecord) || isExcludedRecord(candidateRecord);
}

function isAdjacentVerdictPair(
  left: AdjudicationVerdict,
  right: AdjudicationVerdict,
): boolean {
  if (left === right) {
    return true;
  }

  const adjacent = new Set<AdjudicationVerdict>([
    "supported",
    "partially_supported",
  ]);

  return adjacent.has(left) && adjacent.has(right);
}

export function diffAuditSamples(
  base: AuditSample,
  candidate: AuditSample,
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
    const ignoreAdjudicationDiff = shouldIgnoreAdjudicationDiff(
      baseRecord,
      candidateRecord,
    );
    const verdictChanged = ignoreAdjudicationDiff
      ? false
      : baseRecord?.verdict !== candidateRecord?.verdict;
    const rationaleChanged = ignoreAdjudicationDiff
      ? false
      : baseRecord?.rationale !== candidateRecord?.rationale;
    const retrievalQualityChanged = ignoreAdjudicationDiff
      ? false
      : baseRecord?.retrievalQuality !== candidateRecord?.retrievalQuality;
    const exclusionChanged =
      baseRecord?.excluded !== candidateRecord?.excluded ||
      baseRecord?.excludeReason !== candidateRecord?.excludeReason;

    if (verdictChanged) changedVerdicts++;
    if (rationaleChanged) changedRationales++;
    if (exclusionChanged) changedExclusions++;
    if (missingBase) missingInBase++;
    if (missingCandidateRecord) missingInCandidate++;

    const baseOrder = base.records.findIndex(
      (record) => record.taskId === taskId,
    );
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
        baseOrder >= 0 ? baseOrder : candidateOrder >= 0 ? candidateOrder : 0,
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

export type BenchmarkCandidateInput = {
  label: string;
  path: string;
  set: AuditSample;
};

function summarizeCandidate(
  base: AuditSample,
  candidate: BenchmarkCandidateInput,
): BenchmarkSummaryEntry {
  const baseActive = base.records.filter(
    (record) => !record.excluded && record.verdict !== undefined,
  );
  const candidateIndex = makeIndex(candidate.set.records);

  let exactAgreement = 0;
  let adjacentAgreement = 0;
  const changedTaskIds: string[] = [];
  const missingTaskIds: string[] = [];

  for (const baseRecord of baseActive) {
    const baseVerdict = baseRecord.verdict;
    if (baseVerdict === undefined) {
      continue;
    }

    const candidateRecord = candidateIndex.get(baseRecord.taskId);
    const candidateVerdict = candidateRecord?.verdict;

    if (candidateVerdict === undefined) {
      changedTaskIds.push(baseRecord.taskId);
      if (!candidateRecord) {
        missingTaskIds.push(baseRecord.taskId);
      }
      continue;
    }

    if (candidateVerdict === baseVerdict) {
      exactAgreement++;
    } else {
      changedTaskIds.push(baseRecord.taskId);
    }

    if (isAdjacentVerdictPair(baseVerdict, candidateVerdict)) {
      adjacentAgreement++;
    }
  }

  const activeRecords = baseActive.length;

  return {
    label: candidate.label,
    candidatePath: candidate.path,
    model: candidate.set.runTelemetry?.model,
    useExtendedThinking: candidate.set.runTelemetry?.useExtendedThinking,
    activeRecords,
    exactAgreement,
    exactRate: activeRecords > 0 ? exactAgreement / activeRecords : 0,
    adjacentAgreement,
    adjacentRate: activeRecords > 0 ? adjacentAgreement / activeRecords : 0,
    verdictChanges: changedTaskIds.length,
    changedTaskIds,
    missingTaskIds,
  };
}

export function summarizeBenchmarkCandidates(
  basePath: string,
  base: AuditSample,
  candidates: BenchmarkCandidateInput[],
): BenchmarkSummary {
  const entries = candidates.map((candidate) =>
    summarizeCandidate(base, candidate),
  );

  entries.sort((left, right) => {
    if (right.exactRate !== left.exactRate) {
      return right.exactRate - left.exactRate;
    }
    if (right.adjacentRate !== left.adjacentRate) {
      return right.adjacentRate - left.adjacentRate;
    }
    return left.verdictChanges - right.verdictChanges;
  });

  return {
    generatedAt: new Date().toISOString(),
    basePath,
    entries,
  };
}

function indexDeltas(
  deltas: AdjudicationDelta[],
): Map<string, AdjudicationDelta> {
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
  if (
    (targetsExcludedRecord || changesExclusion) &&
    delta.allowExcludedChange !== true
  ) {
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

export function applyAuditSampleDeltas(
  base: AuditSample,
  deltaSet: AdjudicationDeltaSet,
): AuditSample {
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
