import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

import {
  appendHumanReviewRequestSchema,
  assertCorrectedCitedChunksKnown,
  assertCorrectedCitingSpanInContext,
  computeHumanReviewProgress,
  HumanReviewConflictError,
  humanReviewEventLogSchema,
  projectHumanReviewRecords,
  type AppendHumanReviewRequest,
  type HumanReviewEvent,
  type HumanReviewEventLog,
  type HumanReviewLineage,
  type HumanReviewState,
} from "../contract/human-review.js";

function createEventId(): string {
  return `hrevent_${randomBytes(16).toString("hex")}`;
}

function emptyLog(lineage: HumanReviewLineage): HumanReviewEventLog {
  return {
    schemaVersion: "human-review-events-v1",
    lineage,
    events: [],
  };
}

export function resolveHumanReviewEventsPath(input: {
  runRoot: string;
  reportArtifactId: string;
}): string {
  const reviewRoot = resolve(input.runRoot, "review");
  const lineageDir = resolve(reviewRoot, input.reportArtifactId);
  const eventsPath = resolve(lineageDir, "events.json");

  const normalizedRunRoot = resolve(input.runRoot) + sep;
  if (!eventsPath.startsWith(normalizedRunRoot)) {
    throw new Error("Human review path escaped the run root");
  }
  if (
    input.reportArtifactId.includes("..") ||
    input.reportArtifactId.includes("/") ||
    input.reportArtifactId.includes("\\")
  ) {
    throw new Error("Invalid reportArtifactId for review path");
  }
  return eventsPath;
}

export function loadHumanReviewEventLog(
  eventsPath: string,
): HumanReviewEventLog | undefined {
  if (!existsSync(eventsPath)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(eventsPath, "utf8"));
  } catch {
    throw new Error(`Malformed human review event log at ${eventsPath}`);
  }
  const parsed = humanReviewEventLogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid human review event log at ${eventsPath}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function writeEventLogAtomic(
  eventsPath: string,
  log: HumanReviewEventLog,
): void {
  const validated = humanReviewEventLogSchema.parse(log);
  mkdirSync(dirname(eventsPath), { recursive: true });
  const tempPath = `${eventsPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  renameSync(tempPath, eventsPath);
}

export function getHumanReviewState(input: {
  runId: string;
  runRoot: string;
  reportArtifactId: string;
  reportContentHash: string;
  totalRecords: number;
}): HumanReviewState {
  const lineage: HumanReviewLineage = {
    runId: input.runId,
    reportArtifactId: input.reportArtifactId,
    reportContentHash: input.reportContentHash,
  };
  const eventsPath = resolveHumanReviewEventsPath({
    runRoot: input.runRoot,
    reportArtifactId: input.reportArtifactId,
  });
  const log = loadHumanReviewEventLog(eventsPath) ?? emptyLog(lineage);

  const staleReport =
    log.events.length > 0 &&
    (log.lineage.reportArtifactId !== input.reportArtifactId ||
      log.lineage.reportContentHash !== input.reportContentHash ||
      log.lineage.runId !== input.runId);

  const records = staleReport ? [] : projectHumanReviewRecords(log.events);
  const headEventId =
    staleReport || log.events.length === 0
      ? null
      : log.events[log.events.length - 1]!.eventId;

  return {
    lineage: staleReport ? lineage : log.lineage,
    headEventId,
    progress: computeHumanReviewProgress({
      totalRecords: input.totalRecords,
      records,
    }),
    records,
    staleReport,
  };
}

export function appendHumanReviewEventForRun(input: {
  runId: string;
  runRoot: string;
  totalRecords: number;
  currentReport: {
    artifactId: string;
    contentHash: string;
  };
  canonicalRecord: {
    recordId: string;
    familyId: string;
    citationContext: string;
    knownCitedChunkIds: readonly string[];
  };
  request: AppendHumanReviewRequest;
}): { event: HumanReviewEvent; state: HumanReviewState } {
  const request = appendHumanReviewRequestSchema.parse(input.request);
  const lineage: HumanReviewLineage = {
    runId: input.runId,
    reportArtifactId: input.currentReport.artifactId,
    reportContentHash: input.currentReport.contentHash,
  };

  if (
    request.reportArtifactId !== lineage.reportArtifactId ||
    request.reportContentHash !== lineage.reportContentHash
  ) {
    throw new HumanReviewConflictError(
      "stale_report_lineage",
      "Review submission is bound to a stale report artifact/hash",
      {
        current: lineage,
        received: {
          runId: input.runId,
          reportArtifactId: request.reportArtifactId,
          reportContentHash: request.reportContentHash,
        },
      },
    );
  }

  if (
    request.recordId !== input.canonicalRecord.recordId ||
    request.familyId !== input.canonicalRecord.familyId
  ) {
    throw new HumanReviewConflictError(
      "record_identity_mismatch",
      "Review record/family identity does not match the current report",
      {
        current: {
          recordId: input.canonicalRecord.recordId,
          familyId: input.canonicalRecord.familyId,
        },
        received: {
          recordId: request.recordId,
          familyId: request.familyId,
        },
      },
    );
  }

  if (request.assessment.correctedCitingSpan) {
    assertCorrectedCitingSpanInContext(
      request.assessment.correctedCitingSpan,
      input.canonicalRecord.citationContext,
    );
  }
  if (request.assessment.correctedCitedChunkIds) {
    assertCorrectedCitedChunksKnown(
      request.assessment.correctedCitedChunkIds,
      input.canonicalRecord.knownCitedChunkIds,
    );
  }

  const eventsPath = resolveHumanReviewEventsPath({
    runRoot: input.runRoot,
    reportArtifactId: lineage.reportArtifactId,
  });
  const existing = loadHumanReviewEventLog(eventsPath);

  if (existing) {
    if (
      existing.lineage.runId !== lineage.runId ||
      existing.lineage.reportArtifactId !== lineage.reportArtifactId ||
      existing.lineage.reportContentHash !== lineage.reportContentHash
    ) {
      throw new HumanReviewConflictError(
        "stale_report_lineage",
        "Review lineage is bound to a different report artifact/hash",
        {
          expected: existing.lineage,
          received: lineage,
        },
      );
    }
  }

  const log = existing ?? emptyLog(lineage);
  const headEventId =
    log.events.length === 0 ? null : log.events[log.events.length - 1]!.eventId;

  if (request.expectedHeadEventId !== headEventId) {
    throw new HumanReviewConflictError(
      "stale_head",
      "Concurrent review update: expected head event does not match",
      {
        expectedHeadEventId: request.expectedHeadEventId,
        actualHeadEventId: headEventId,
      },
    );
  }

  if (request.supersedesEventId != null) {
    const priorForRecord = [...log.events]
      .reverse()
      .find((event) => event.recordId === request.recordId);
    if (
      priorForRecord == null ||
      priorForRecord.eventId !== request.supersedesEventId
    ) {
      throw new HumanReviewConflictError(
        "invalid_supersession",
        "supersedesEventId must be the latest event for this record",
        {
          supersedesEventId: request.supersedesEventId,
          latestEventId: priorForRecord?.eventId ?? null,
        },
      );
    }
  }

  const event: HumanReviewEvent = {
    eventId: createEventId(),
    recordId: request.recordId,
    familyId: request.familyId,
    reviewer: request.reviewer,
    createdAt: new Date().toISOString(),
    status: request.status,
    assessment: request.assessment,
    ...(request.supersedesEventId
      ? { supersedesEventId: request.supersedesEventId }
      : {}),
  };

  const nextLog: HumanReviewEventLog = {
    ...log,
    events: [...log.events, event],
  };
  writeEventLogAtomic(eventsPath, nextLog);
  const records = projectHumanReviewRecords(nextLog.events);

  return {
    event,
    state: {
      lineage,
      headEventId: event.eventId,
      progress: computeHumanReviewProgress({
        totalRecords: input.totalRecords,
        records,
      }),
      records,
      staleReport: false,
    },
  };
}

export type HumanReviewExportRecord = {
  recordId: string;
  familyId: string;
  machine: Record<string, unknown>;
  human: {
    status: string;
    reviewer: string;
    updatedAt: string;
    eventId: string;
    revisionCount: number;
    assessment: HumanReviewEvent["assessment"];
  } | null;
};

export function buildHumanReviewExportBundle(input: {
  lineage: HumanReviewLineage;
  events: readonly HumanReviewEvent[];
  machineRecords: readonly {
    recordId: string;
    familyId: string;
    snapshot: Record<string, unknown>;
  }[];
}): {
  schemaVersion: "human-review-export-v1";
  exportedAt: string;
  lineage: HumanReviewLineage;
  progress: ReturnType<typeof computeHumanReviewProgress>;
  records: HumanReviewExportRecord[];
  events: HumanReviewEvent[];
} {
  const latest = new Map(
    projectHumanReviewRecords(input.events).map((record) => [
      record.recordId,
      record,
    ]),
  );
  const records: HumanReviewExportRecord[] = input.machineRecords.map(
    (machine) => {
      const human = latest.get(machine.recordId);
      return {
        recordId: machine.recordId,
        familyId: machine.familyId,
        machine: machine.snapshot,
        human: human
          ? {
              status: human.status,
              reviewer: human.reviewer,
              updatedAt: human.updatedAt,
              eventId: human.eventId,
              revisionCount: human.revisionCount,
              assessment: human.assessment,
            }
          : null,
      };
    },
  );

  return {
    schemaVersion: "human-review-export-v1",
    exportedAt: new Date().toISOString(),
    lineage: input.lineage,
    progress: computeHumanReviewProgress({
      totalRecords: input.machineRecords.length,
      records: [...latest.values()],
    }),
    records,
    events: [...input.events],
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function renderHumanReviewCsv(
  records: readonly HumanReviewExportRecord[],
): string {
  const headers = [
    "recordId",
    "familyId",
    "reviewStatus",
    "reviewer",
    "updatedAt",
    "revisionCount",
    "eligibleForAdjudication",
    "inScope",
    "citingSpanValid",
    "correctedCitingSpanText",
    "correctedCitingSpanStart",
    "correctedCitingSpanEnd",
    "citedEvidenceValid",
    "correctedCitedChunkIds",
    "evidenceSufficiency",
    "verdictAgreement",
    "overriddenVerdict",
    "notes",
    "machineTrackedClaim",
    "machineEvaluatedClaimText",
    "machineCitingPaperTitle",
    "machineCitingPaperDoi",
    "machineCitingPaperYear",
    "machineCitationContext",
    "machineEvidencePassagesJson",
    "machineVerdict",
    "machineAdjudicationStatus",
    "machineEvidenceSufficiency",
  ];
  const lines = [headers.join(",")];
  for (const record of records) {
    const assessment = record.human?.assessment;
    const machineVerdict =
      typeof record.machine["verdict"] === "string"
        ? record.machine["verdict"]
        : "";
    const machineStatus =
      typeof record.machine["adjudicationStatus"] === "string"
        ? record.machine["adjudicationStatus"]
        : "";
    const machineValue = (key: string): string => {
      const value = record.machine[key];
      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
    };
    const machineEvidencePassages = Array.isArray(
      record.machine["evidencePassages"],
    )
      ? JSON.stringify(record.machine["evidencePassages"])
      : "";
    lines.push(
      [
        record.recordId,
        record.familyId,
        record.human?.status ?? "",
        record.human?.reviewer ?? "",
        record.human?.updatedAt ?? "",
        record.human ? String(record.human.revisionCount) : "",
        assessment?.eligibleForAdjudication ?? "",
        assessment?.inScope ?? "",
        assessment?.citingSpanValid ?? "",
        assessment?.correctedCitingSpan?.text ?? "",
        assessment?.correctedCitingSpan != null
          ? String(assessment.correctedCitingSpan.charOffsetStart)
          : "",
        assessment?.correctedCitingSpan != null
          ? String(assessment.correctedCitingSpan.charOffsetEnd)
          : "",
        assessment?.citedEvidenceValid ?? "",
        assessment?.correctedCitedChunkIds?.join("|") ?? "",
        assessment?.evidenceSufficiency ?? "",
        assessment?.verdictAgreement ?? "",
        assessment?.overriddenVerdict ?? "",
        assessment?.notes ?? "",
        machineValue("trackedClaim"),
        machineValue("evaluatedClaimText"),
        machineValue("citingPaperTitle"),
        machineValue("citingPaperDoi"),
        machineValue("citingPaperYear"),
        machineValue("citationContext"),
        machineEvidencePassages,
        machineVerdict,
        machineStatus,
        machineValue("evidenceSufficiency"),
      ]
        .map((value) => csvEscape(String(value)))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function loadHumanReviewExport(input: {
  runId: string;
  runRoot: string;
  reportArtifactId: string;
  reportContentHash: string;
  machineRecords: readonly {
    recordId: string;
    familyId: string;
    snapshot: Record<string, unknown>;
  }[];
}): ReturnType<typeof buildHumanReviewExportBundle> {
  const lineage: HumanReviewLineage = {
    runId: input.runId,
    reportArtifactId: input.reportArtifactId,
    reportContentHash: input.reportContentHash,
  };
  const eventsPath = resolveHumanReviewEventsPath({
    runRoot: input.runRoot,
    reportArtifactId: input.reportArtifactId,
  });
  const log = loadHumanReviewEventLog(eventsPath);
  if (
    log &&
    (log.lineage.reportContentHash !== input.reportContentHash ||
      log.lineage.reportArtifactId !== input.reportArtifactId ||
      log.lineage.runId !== input.runId)
  ) {
    throw new HumanReviewConflictError(
      "stale_report_lineage",
      "Cannot export review bound to a different report artifact/hash",
      { expected: log.lineage, received: lineage },
    );
  }
  return buildHumanReviewExportBundle({
    lineage,
    events: log?.events ?? [],
    machineRecords: input.machineRecords,
  });
}
