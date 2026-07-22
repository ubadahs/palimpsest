import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { loadCanonicalAdjudicateArtifact } from "../pipeline/canonical-adjudicate-artifact.js";
import { loadCanonicalDiscoverArtifact } from "../pipeline/canonical-discover-artifact.js";
import { loadCanonicalEvidenceArtifact } from "../pipeline/canonical-evidence-artifact.js";
import { loadCanonicalPrepareArtifact } from "../pipeline/canonical-prepare-artifact.js";
import { loadCanonicalReportArtifact } from "../pipeline/canonical-report-artifact.js";
import { loadCanonicalScopeArtifact } from "../pipeline/canonical-scope-artifact.js";
import { manifestPathForArtifact } from "../shared/artifact-io.js";
import type {
  BuildStageInspectorOptions,
  ReportInspectorEvidencePassage,
  ReportInspectorRecordRow,
  StageArtifactMap,
  StageInspectorPayload,
} from "./inspector-payloads.js";
import { getStageDefinition } from "./stages.js";
import type {
  AnalysisStageSummary,
  StageArtifactPointer,
  StageKey,
} from "./run-types.js";

export type StageArtifactSet = {
  primaryArtifactPath?: string;
  reportArtifactPath?: string;
  manifestPath?: string;
  extraArtifacts: StageArtifactPointer[];
};

type CanonicalArtifact = StageArtifactMap[StageKey];

function metric(
  label: string,
  value: string | number,
): {
  label: string;
  value: string;
} {
  return { label, value: String(value) };
}

function countBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = key(value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function loadCanonicalArtifact(
  stageKey: "discover",
  artifactPath: string,
): StageArtifactMap["discover"];
function loadCanonicalArtifact(
  stageKey: "scope",
  artifactPath: string,
): StageArtifactMap["scope"];
function loadCanonicalArtifact(
  stageKey: "prepare",
  artifactPath: string,
): StageArtifactMap["prepare"];
function loadCanonicalArtifact(
  stageKey: "evidence",
  artifactPath: string,
): StageArtifactMap["evidence"];
function loadCanonicalArtifact(
  stageKey: "adjudicate",
  artifactPath: string,
): StageArtifactMap["adjudicate"];
function loadCanonicalArtifact(
  stageKey: "report",
  artifactPath: string,
): StageArtifactMap["report"];
function loadCanonicalArtifact(
  stageKey: StageKey,
  artifactPath: string,
): CanonicalArtifact {
  switch (stageKey) {
    case "discover":
      return loadCanonicalDiscoverArtifact(artifactPath);
    case "scope":
      return loadCanonicalScopeArtifact(artifactPath);
    case "prepare":
      return loadCanonicalPrepareArtifact(artifactPath);
    case "evidence":
      return loadCanonicalEvidenceArtifact(artifactPath);
    case "adjudicate":
      return loadCanonicalAdjudicateArtifact(artifactPath);
    case "report":
      return loadCanonicalReportArtifact(artifactPath);
  }
}

/**
 * Lists only current canonical artifacts. There are no legacy artifact aliases.
 */
export function listStageArtifacts(
  stageKey: StageKey,
  stageDirectory: string,
): StageArtifactSet {
  const definition = getStageDefinition(stageKey);
  const entries = existsSync(stageDirectory) ? readdirSync(stageDirectory) : [];
  const latest = (suffix: string): string | undefined =>
    entries
      .filter((entry) => entry.endsWith(suffix))
      .sort()
      .at(-1);

  const primaryName = latest(definition.artifactGlobs.primarySuffix);
  const reportName = definition.artifactGlobs.reportSuffix
    ? latest(definition.artifactGlobs.reportSuffix)
    : undefined;
  const primaryArtifactPath = primaryName
    ? resolve(stageDirectory, primaryName)
    : undefined;
  const artifactSet: StageArtifactSet = {
    extraArtifacts: [],
    ...(primaryArtifactPath ? { primaryArtifactPath } : {}),
    ...(reportName
      ? { reportArtifactPath: resolve(stageDirectory, reportName) }
      : {}),
    ...(primaryArtifactPath &&
    existsSync(manifestPathForArtifact(primaryArtifactPath))
      ? { manifestPath: manifestPathForArtifact(primaryArtifactPath) }
      : {}),
  };
  return artifactSet;
}

/** Resolve a canonical artifact set for an explicit attempt stem. */
export function listStageArtifactsForStem(
  stageKey: StageKey,
  stageDirectory: string,
  artifactStem: string,
): StageArtifactSet {
  const definition = getStageDefinition(stageKey);
  const primaryArtifactPath = resolve(
    stageDirectory,
    `${artifactStem}${definition.artifactGlobs.primarySuffix}`,
  );
  const reportArtifactPath = definition.artifactGlobs.reportSuffix
    ? resolve(
        stageDirectory,
        `${artifactStem}${definition.artifactGlobs.reportSuffix}`,
      )
    : undefined;
  return {
    extraArtifacts: [],
    ...(existsSync(primaryArtifactPath) ? { primaryArtifactPath } : {}),
    ...(reportArtifactPath && existsSync(reportArtifactPath)
      ? { reportArtifactPath }
      : {}),
    ...(existsSync(manifestPathForArtifact(primaryArtifactPath))
      ? { manifestPath: manifestPathForArtifact(primaryArtifactPath) }
      : {}),
  };
}

export function artifactStemFromPrimaryPath(
  primaryPath: string,
  stageKey: StageKey,
): string {
  const suffix = getStageDefinition(stageKey).artifactGlobs.primarySuffix;
  const base = basename(primaryPath);
  return base.endsWith(suffix)
    ? base.slice(0, base.length - suffix.length)
    : base.replace(/\.[^.]+$/, "");
}

export function deriveCanonicalStageSummary(
  stageKey: "discover",
  artifact: StageArtifactMap["discover"],
): AnalysisStageSummary;
export function deriveCanonicalStageSummary(
  stageKey: "scope",
  artifact: StageArtifactMap["scope"],
): AnalysisStageSummary;
export function deriveCanonicalStageSummary(
  stageKey: "prepare",
  artifact: StageArtifactMap["prepare"],
): AnalysisStageSummary;
export function deriveCanonicalStageSummary(
  stageKey: "evidence",
  artifact: StageArtifactMap["evidence"],
): AnalysisStageSummary;
export function deriveCanonicalStageSummary(
  stageKey: "adjudicate",
  artifact: StageArtifactMap["adjudicate"],
): AnalysisStageSummary;
export function deriveCanonicalStageSummary(
  stageKey: "report",
  artifact: StageArtifactMap["report"],
): AnalysisStageSummary;
export function deriveCanonicalStageSummary(
  stageKey: StageKey,
  artifact: CanonicalArtifact,
): AnalysisStageSummary {
  if (stageKey === "discover") {
    const data = artifact as StageArtifactMap["discover"];
    return {
      headline: "Citing-neighborhood discovery ledger",
      metrics: [
        metric("Seeds", data.payload.seeds.length),
        metric("Citing observations", data.payload.citingPapers.length),
        metric("Citation occurrences", data.payload.citationMentions.length),
        metric("Attributed claims", data.payload.attributedClaimRecords.length),
        metric("Candidates", data.payload.claimCandidates.length),
        metric(
          "Selected for Scope",
          data.payload.candidateDispositions.filter(
            (item) => item.selectedForScope,
          ).length,
        ),
      ],
      artifacts: [],
    };
  }
  if (stageKey === "scope") {
    const data = artifact as StageArtifactMap["scope"];
    return {
      headline: "Scoped families and seed grounding",
      metrics: [
        metric("Candidate decisions", data.payload.candidateDecisions.length),
        metric(
          "Selected candidates",
          data.payload.candidateDecisions.filter(
            (item) => item.disposition === "scoped",
          ).length,
        ),
        metric("Families", data.payload.families.length),
        metric(
          "Materialized seeds",
          data.payload.seedMaterializations.filter(
            (item) => item.status === "materialized",
          ).length,
        ),
      ],
      artifacts: [],
    };
  }
  if (stageKey === "prepare") {
    const data = artifact as StageArtifactMap["prepare"];
    const classifications = countBy(
      data.payload.records,
      (record) => record.classification.status,
    );
    return {
      headline: "Occurrence-local citation records",
      metrics: [
        metric("Families", data.payload.scopedFamilies.length),
        metric("Records", data.payload.records.length),
        metric("Classified", classifications.get("classified") ?? 0),
        metric("Ambiguous", classifications.get("ambiguous") ?? 0),
        metric("Failed", classifications.get("failed") ?? 0),
      ],
      artifacts: [],
    };
  }
  if (stageKey === "evidence") {
    const data = artifact as StageArtifactMap["evidence"];
    const retrieval = countBy(
      data.payload.records,
      (record) => record.retrievalStatus,
    );
    return {
      headline: "Seed-text evidence retrieval",
      metrics: [
        metric("Record outcomes", data.payload.records.length),
        metric("Retrieved", retrieval.get("retrieved") ?? 0),
        metric("No lexical matches", retrieval.get("no_lexical_matches") ?? 0),
        metric("Selections", data.payload.selections.length),
        metric("BM25 runs", data.payload.bm25Runs.length),
        metric("Rerank runs", data.payload.rerankRuns.length),
      ],
      artifacts: [],
    };
  }
  if (stageKey === "adjudicate") {
    const data = artifact as StageArtifactMap["adjudicate"];
    const outcomes = countBy(data.payload.records, (record) => record.status);
    const verdicts = countBy(
      data.payload.records.filter(
        (record): record is Extract<typeof record, { status: "adjudicated" }> =>
          record.status === "adjudicated",
      ),
      (record) => record.verdict,
    );
    return {
      headline: "Canonical categorical adjudication",
      metrics: [
        metric("Records", data.payload.records.length),
        metric("Adjudicated", outcomes.get("adjudicated") ?? 0),
        metric("F", verdicts.get("F") ?? 0),
        metric("D", verdicts.get("D") ?? 0),
        metric("E", verdicts.get("E") ?? 0),
        metric("U", verdicts.get("U") ?? 0),
        metric("Not adjudicated", outcomes.get("not_adjudicated") ?? 0),
        metric("Adjudication failed", outcomes.get("adjudication_failed") ?? 0),
        metric("Invalid output", outcomes.get("invalid_output") ?? 0),
      ],
      artifacts: [],
    };
  }

  const data = artifact as StageArtifactMap["report"];
  const { funnel } = data.payload;
  return {
    headline: "Canonical audit report",
    metrics: [
      metric("Seeds", funnel.discover.seeds.count),
      metric("Candidates", funnel.discover.candidateClaims.count),
      metric("Families", funnel.scope.families.count),
      metric("Records", funnel.prepare.preparedRecords.count),
      metric("F", funnel.adjudicate.verdictCounts.F.count),
      metric("D", funnel.adjudicate.verdictCounts.D.count),
      metric("E", funnel.adjudicate.verdictCounts.E.count),
      metric("U", funnel.adjudicate.verdictCounts.U.count),
      metric("Not adjudicated", funnel.adjudicate.notAdjudicated.count),
    ],
    artifacts: [],
  };
}

export function deriveCanonicalStageSummaryFromPath(
  stageKey: StageKey,
  artifactPath: string,
): AnalysisStageSummary {
  switch (stageKey) {
    case "discover":
      return deriveCanonicalStageSummary(
        "discover",
        loadCanonicalArtifact("discover", artifactPath),
      );
    case "scope":
      return deriveCanonicalStageSummary(
        "scope",
        loadCanonicalArtifact("scope", artifactPath),
      );
    case "prepare":
      return deriveCanonicalStageSummary(
        "prepare",
        loadCanonicalArtifact("prepare", artifactPath),
      );
    case "evidence":
      return deriveCanonicalStageSummary(
        "evidence",
        loadCanonicalArtifact("evidence", artifactPath),
      );
    case "adjudicate":
      return deriveCanonicalStageSummary(
        "adjudicate",
        loadCanonicalArtifact("adjudicate", artifactPath),
      );
    case "report":
      return deriveCanonicalStageSummary(
        "report",
        loadCanonicalArtifact("report", artifactPath),
      );
  }
}

function buildDiscoverInspectorPayload(
  artifact: StageArtifactMap["discover"],
): StageInspectorPayload<"discover"> {
  return {
    stageKey: "discover",
    rawArtifact: artifact,
    summary: {
      seeds: artifact.payload.seeds.length,
      citingPaperObservations: artifact.payload.citingPapers.length,
      citationOccurrences: artifact.payload.citationMentions.length,
      attributedClaims: artifact.payload.attributedClaimRecords.length,
      candidates: artifact.payload.claimCandidates.length,
      selectedForScope: artifact.payload.candidateDispositions.filter(
        (item) => item.selectedForScope,
      ).length,
    },
  };
}

function buildScopeInspectorPayload(
  artifact: StageArtifactMap["scope"],
): StageInspectorPayload<"scope"> {
  return {
    stageKey: "scope",
    rawArtifact: artifact,
    summary: {
      candidateDecisions: artifact.payload.candidateDecisions.length,
      selectedCandidates: artifact.payload.candidateDecisions.filter(
        (item) => item.disposition === "scoped",
      ).length,
      families: artifact.payload.families.length,
      materializedSeeds: artifact.payload.seedMaterializations.filter(
        (item) => item.status === "materialized",
      ).length,
    },
  };
}

function buildPrepareInspectorPayload(
  artifact: StageArtifactMap["prepare"],
): StageInspectorPayload<"prepare"> {
  const statuses = countBy(
    artifact.payload.records,
    (record) => record.classification.status,
  );
  return {
    stageKey: "prepare",
    rawArtifact: artifact,
    summary: {
      families: artifact.payload.scopedFamilies.length,
      records: artifact.payload.records.length,
      classified: statuses.get("classified") ?? 0,
      ambiguous: statuses.get("ambiguous") ?? 0,
      failed: statuses.get("failed") ?? 0,
    },
  };
}

function buildEvidenceInspectorPayload(
  artifact: StageArtifactMap["evidence"],
): StageInspectorPayload<"evidence"> {
  return {
    stageKey: "evidence",
    rawArtifact: artifact,
    summary: {
      records: artifact.payload.records.length,
      retrievalOutcomes: Object.fromEntries(
        countBy(artifact.payload.records, (record) => record.retrievalStatus),
      ),
      selections: artifact.payload.selections.length,
      bm25Runs: artifact.payload.bm25Runs.length,
      rerankRuns: artifact.payload.rerankRuns.length,
    },
  };
}

function buildAdjudicateInspectorPayload(
  artifact: StageArtifactMap["adjudicate"],
): StageInspectorPayload<"adjudicate"> {
  const statuses = countBy(artifact.payload.records, (record) => record.status);
  const verdicts = countBy(
    artifact.payload.records.filter(
      (record): record is Extract<typeof record, { status: "adjudicated" }> =>
        record.status === "adjudicated",
    ),
    (record) => record.verdict,
  );
  return {
    stageKey: "adjudicate",
    rawArtifact: artifact,
    summary: {
      records: artifact.payload.records.length,
      adjudicated: statuses.get("adjudicated") ?? 0,
      F: verdicts.get("F") ?? 0,
      D: verdicts.get("D") ?? 0,
      E: verdicts.get("E") ?? 0,
      U: verdicts.get("U") ?? 0,
      notAdjudicated: statuses.get("not_adjudicated") ?? 0,
      adjudicationFailed: statuses.get("adjudication_failed") ?? 0,
      invalidOutput: statuses.get("invalid_output") ?? 0,
    },
  };
}

function indexByRecordId<T extends { recordId: string }>(
  records: readonly T[],
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const record of records) {
    if (map.has(record.recordId)) {
      throw new Error(
        `Duplicate ${label} recordId for report inspector join: ${record.recordId}`,
      );
    }
    map.set(record.recordId, record);
  }
  return map;
}

function requireJoinedRecord<T>(
  map: Map<string, T>,
  recordId: string,
  label: string,
): T {
  const record = map.get(recordId);
  if (!record) {
    throw new Error(
      `Report recordTraces spine is missing ${label} record ${recordId}`,
    );
  }
  return record;
}

function buildEvidencePassages(input: {
  evidence: StageArtifactMap["evidence"];
  evidenceRecord: StageArtifactMap["evidence"]["payload"]["records"][number];
  modelCitedChunkIds: readonly string[];
}): ReportInspectorEvidencePassage[] {
  const { evidence, evidenceRecord, modelCitedChunkIds } = input;
  if (evidenceRecord.finalSelectionId == null) {
    return [];
  }
  const selection = evidence.payload.selections.find(
    (item) => item.selectionId === evidenceRecord.finalSelectionId,
  );
  if (!selection) {
    throw new Error(
      `Evidence selection ${evidenceRecord.finalSelectionId} missing for record ${evidenceRecord.recordId}`,
    );
  }
  const chunksById = new Map(
    evidence.payload.corpora.flatMap((corpus) =>
      corpus.chunks.map((chunk) => [chunk.chunkId, chunk] as const),
    ),
  );
  const pinned = new Set(selection.pinnedChunkIds ?? []);
  const modelCited = new Set(modelCitedChunkIds);
  return selection.selectedChunkIds.map((chunkId) => {
    const chunk = chunksById.get(chunkId);
    if (!chunk) {
      throw new Error(
        `Evidence chunk ${chunkId} missing for selection ${selection.selectionId}`,
      );
    }
    return {
      chunkId,
      text: chunk.text,
      sourceBlockKind: chunk.sourceBlockKind,
      ...(chunk.sourceSectionTitle
        ? { sourceSectionTitle: chunk.sourceSectionTitle }
        : {}),
      pinned: pinned.has(chunkId),
      modelCited: modelCited.has(chunkId),
    };
  });
}

function buildReportInspectorRecordRow(input: {
  prepareRecord: StageArtifactMap["prepare"]["payload"]["records"][number];
  evidenceRecord: StageArtifactMap["evidence"]["payload"]["records"][number];
  adjudicateRecord: StageArtifactMap["adjudicate"]["payload"]["records"][number];
  evidence: StageArtifactMap["evidence"];
  rankingSource?: string;
}): ReportInspectorRecordRow {
  const {
    prepareRecord,
    evidenceRecord,
    adjudicateRecord,
    evidence,
    rankingSource,
  } = input;
  const paper = prepareRecord.citingPaper.paper;
  const occurrence = prepareRecord.citationOccurrence;
  const classification = prepareRecord.classification;
  const modelCitedChunkIds =
    adjudicateRecord.status === "adjudicated"
      ? adjudicateRecord.modelCitedChunkIds
      : [];
  const evidencePassages = buildEvidencePassages({
    evidence,
    evidenceRecord,
    modelCitedChunkIds,
  });

  const evaluatedClaimText =
    adjudicateRecord.status === "adjudicated"
      ? adjudicateRecord.evaluatedCitingClaimText
      : (prepareRecord.occurrenceSourceClaimRecords[0]?.extractedClaimText ??
        prepareRecord.family.trackedClaim);

  const row: ReportInspectorRecordRow = {
    recordId: prepareRecord.recordId,
    familyId: prepareRecord.familyId,
    citationOccurrenceId: prepareRecord.citationOccurrenceId,
    trackedClaim: prepareRecord.family.trackedClaim,
    evaluatedClaimText,
    citingPaperTitle: paper.title,
    citationContext: prepareRecord.context.verbatim.text,
    classificationStatus: classification.status,
    groundingStatus: prepareRecord.family.grounding.status,
    retrievalStatus: evidenceRecord.retrievalStatus,
    rerankStatus: evidenceRecord.rerankStatus,
    evidencePassages,
    adjudicationStatus: adjudicateRecord.status,
  };

  if (paper.doi) row.citingPaperDoi = paper.doi;
  if (paper.publicationYear != null)
    row.citingPaperYear = paper.publicationYear;
  if (occurrence.seedRefLabel) row.seedRefLabel = occurrence.seedRefLabel;
  if (occurrence.sectionTitle) row.sectionTitle = occurrence.sectionTitle;
  if (classification.status !== "failed") {
    row.citationRole = classification.citationRole;
    row.evaluationMode = classification.evaluationMode;
  }
  if (rankingSource) row.rankingSource = rankingSource;

  if (adjudicateRecord.status === "adjudicated") {
    row.verdict = adjudicateRecord.verdict;
    row.confidence = adjudicateRecord.confidence;
    row.comparison = adjudicateRecord.comparison;
    row.rationale = adjudicateRecord.rationale;
  } else if (adjudicateRecord.status === "not_adjudicated") {
    row.gateCode = adjudicateRecord.gateCode;
    row.operationalReason = adjudicateRecord.reason;
  } else if (adjudicateRecord.status === "adjudication_failed") {
    row.failureCode = adjudicateRecord.failureCode;
    row.operationalReason = adjudicateRecord.reason;
  } else {
    row.operationalReason = adjudicateRecord.reason;
  }

  return row;
}

/**
 * Join Prepare, Evidence, and Adjudicate onto the Report recordTraces spine.
 * Throws when a spine ID is missing or inconsistently joined.
 */
export function buildReportInspectorRecords(input: {
  report: StageArtifactMap["report"];
  prepare: StageArtifactMap["prepare"];
  evidence: StageArtifactMap["evidence"];
  adjudicate: StageArtifactMap["adjudicate"];
}): ReportInspectorRecordRow[] {
  const prepareById = indexByRecordId(input.prepare.payload.records, "Prepare");
  const evidenceById = indexByRecordId(
    input.evidence.payload.records,
    "Evidence",
  );
  const adjudicateById = indexByRecordId(
    input.adjudicate.payload.records,
    "Adjudicate",
  );

  return input.report.payload.recordTraces.map((trace) => {
    const prepareRecord = requireJoinedRecord(
      prepareById,
      trace.recordId,
      "Prepare",
    );
    const evidenceRecord = requireJoinedRecord(
      evidenceById,
      trace.recordId,
      "Evidence",
    );
    const adjudicateRecord = requireJoinedRecord(
      adjudicateById,
      trace.recordId,
      "Adjudicate",
    );

    if (prepareRecord.familyId !== trace.familyId) {
      throw new Error(
        `Prepare familyId mismatch for report record ${trace.recordId}`,
      );
    }
    if (prepareRecord.citationOccurrenceId !== trace.citationOccurrenceId) {
      throw new Error(
        `Prepare citationOccurrenceId mismatch for report record ${trace.recordId}`,
      );
    }
    if (
      evidenceRecord.familyId !== trace.familyId ||
      evidenceRecord.citationOccurrenceId !== trace.citationOccurrenceId
    ) {
      throw new Error(
        `Evidence identity mismatch for report record ${trace.recordId}`,
      );
    }
    if (
      adjudicateRecord.familyId !== trace.familyId ||
      adjudicateRecord.citationOccurrenceId !== trace.citationOccurrenceId
    ) {
      throw new Error(
        `Adjudicate identity mismatch for report record ${trace.recordId}`,
      );
    }
    if (evidenceRecord.retrievalStatus !== trace.evidence.retrievalStatus) {
      throw new Error(
        `Evidence retrievalStatus mismatch for report record ${trace.recordId}`,
      );
    }
    if (adjudicateRecord.status !== trace.adjudication.status) {
      throw new Error(
        `Adjudication status mismatch for report record ${trace.recordId}`,
      );
    }
    if (
      adjudicateRecord.status === "adjudicated" &&
      trace.adjudication.status === "adjudicated" &&
      adjudicateRecord.verdict !== trace.adjudication.verdict
    ) {
      throw new Error(
        `Adjudication verdict mismatch for report record ${trace.recordId}`,
      );
    }

    return buildReportInspectorRecordRow({
      prepareRecord,
      evidenceRecord,
      adjudicateRecord,
      evidence: input.evidence,
      ...(trace.evidence.rankingSource
        ? { rankingSource: trace.evidence.rankingSource }
        : {}),
    });
  });
}

function buildReportInspectorPayload(
  artifact: StageArtifactMap["report"],
  options?: BuildStageInspectorOptions,
): StageInspectorPayload<"report"> {
  const preparePath = options?.preparePath;
  const evidencePath = options?.evidencePath;
  const adjudicatePath = options?.adjudicatePath;
  if (!preparePath || !evidencePath || !adjudicatePath) {
    throw new Error(
      "Report inspector requires preparePath, evidencePath, and adjudicatePath for record joins",
    );
  }

  const prepare = loadCanonicalArtifact("prepare", preparePath);
  const evidence = loadCanonicalArtifact("evidence", evidencePath);
  const adjudicate = loadCanonicalArtifact("adjudicate", adjudicatePath);
  const records = buildReportInspectorRecords({
    report: artifact,
    prepare,
    evidence,
    adjudicate,
  });

  return {
    stageKey: "report",
    rawArtifact: artifact,
    summary: {
      interpretationStatus: artifact.payload.interpretationStatus,
      interpretationWarning: artifact.payload.interpretationWarning,
      method: artifact.payload.method,
      lineage: artifact.payload.lineage,
      funnel: artifact.payload.funnel,
      rates: artifact.payload.rates,
      decisionSummaries: artifact.payload.decisionSummaries,
      exclusionSummaries: artifact.payload.exclusionSummaries,
      records,
    },
    ...(options?.markdownPath ? { markdownPath: options.markdownPath } : {}),
  };
}

export function buildStageInspectorPayload<K extends StageKey>(
  stageKey: K,
  primaryPath: string,
  options?: BuildStageInspectorOptions,
): StageInspectorPayload<K> {
  switch (stageKey) {
    case "discover":
      return buildDiscoverInspectorPayload(
        loadCanonicalArtifact("discover", primaryPath),
      ) as StageInspectorPayload<K>;
    case "scope":
      return buildScopeInspectorPayload(
        loadCanonicalArtifact("scope", primaryPath),
      ) as StageInspectorPayload<K>;
    case "prepare":
      return buildPrepareInspectorPayload(
        loadCanonicalArtifact("prepare", primaryPath),
      ) as StageInspectorPayload<K>;
    case "evidence":
      return buildEvidenceInspectorPayload(
        loadCanonicalArtifact("evidence", primaryPath),
      ) as StageInspectorPayload<K>;
    case "adjudicate":
      return buildAdjudicateInspectorPayload(
        loadCanonicalArtifact("adjudicate", primaryPath),
      ) as StageInspectorPayload<K>;
    case "report": {
      if (
        !options?.preparePath ||
        !options.evidencePath ||
        !options.adjudicatePath
      ) {
        throw new Error(
          "Report inspector requires preparePath, evidencePath, and adjudicatePath for record joins",
        );
      }
      return buildReportInspectorPayload(
        loadCanonicalArtifact("report", primaryPath),
        options,
      ) as StageInspectorPayload<K>;
    }
    default: {
      const _exhaustive: never = stageKey;
      throw new Error(`Unsupported stage key: ${String(_exhaustive)}`);
    }
  }
}
