import type {
  AppendHumanReviewRequest,
  HumanReviewEvent,
  HumanReviewState,
  ReportInspectorRecordRow,
  StageInspectorPayload,
} from "palimpsest/contract";
import { HumanReviewConflictError } from "palimpsest/contract";
import {
  appendHumanReviewEventForRun,
  getHumanReviewState,
  loadHumanReviewExport,
  renderHumanReviewCsv,
} from "palimpsest/review";

import { getStageGroupDetailOrThrow } from "./run-queries";
import { getRunRoot } from "./run-files";

type ReportReviewContext = {
  runId: string;
  runRoot: string;
  reportArtifactId: string;
  reportContentHash: string;
  records: ReportInspectorRecordRow[];
  payload: StageInspectorPayload<"report">;
};

function getReportReviewContext(runId: string): ReportReviewContext {
  const group = getStageGroupDetailOrThrow(runId, "report");
  const detail = group.members[0];
  if (!detail?.inspectorPayload) {
    throw new Error("Report stage is not available for human review.");
  }
  const payload = detail.inspectorPayload;
  const raw = payload.rawArtifact;
  return {
    runId,
    runRoot: getRunRoot(runId),
    reportArtifactId: raw.artifactId,
    reportContentHash: raw.contentHash,
    records: payload.summary.records,
    payload,
  };
}

export function getReviewStateForRun(runId: string): HumanReviewState {
  const context = getReportReviewContext(runId);
  return getHumanReviewState({
    runId: context.runId,
    runRoot: context.runRoot,
    reportArtifactId: context.reportArtifactId,
    reportContentHash: context.reportContentHash,
    totalRecords: context.records.length,
  });
}

export function appendReviewEventForRun(
  runId: string,
  request: AppendHumanReviewRequest,
): { event: HumanReviewEvent; state: HumanReviewState } {
  const context = getReportReviewContext(runId);
  const canonicalRecord = context.records.find(
    (record) => record.recordId === request.recordId,
  );
  if (!canonicalRecord) {
    throw new HumanReviewConflictError(
      "record_identity_mismatch",
      "Review record does not exist in the current report",
      { recordId: request.recordId },
    );
  }

  return appendHumanReviewEventForRun({
    runId: context.runId,
    runRoot: context.runRoot,
    totalRecords: context.records.length,
    currentReport: {
      artifactId: context.reportArtifactId,
      contentHash: context.reportContentHash,
    },
    canonicalRecord: {
      recordId: canonicalRecord.recordId,
      familyId: canonicalRecord.familyId,
      citationContext: canonicalRecord.citationContext,
      knownCitedChunkIds: canonicalRecord.evidencePassages.map(
        (passage) => passage.chunkId,
      ),
    },
    request,
  });
}

export function exportReviewForRun(
  runId: string,
  format: "json" | "csv",
): { contentType: string; filename: string; body: string } {
  const context = getReportReviewContext(runId);
  const bundle = loadHumanReviewExport({
    runId: context.runId,
    runRoot: context.runRoot,
    reportArtifactId: context.reportArtifactId,
    reportContentHash: context.reportContentHash,
    machineRecords: context.records.map((record) => ({
      recordId: record.recordId,
      familyId: record.familyId,
      citingPaperId: record.citingPaperId,
      claimTexts: record.occurrenceClaims.map(
        (claim) => claim.extractedClaimText,
      ),
      snapshot: { ...record },
    })),
  });

  if (format === "csv") {
    return {
      contentType: "text/csv; charset=utf-8",
      filename: `human-review-${runId}.csv`,
      body: renderHumanReviewCsv(bundle.units),
    };
  }

  return {
    contentType: "application/json; charset=utf-8",
    filename: `human-review-${runId}.json`,
    body: `${JSON.stringify(bundle, null, 2)}\n`,
  };
}
