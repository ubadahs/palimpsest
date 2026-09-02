import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { buildClaimUnitKey } from "../contract/claim-unit.js";
import {
  appendHumanReviewRequestSchema,
  assertCorrectedCitedChunksKnown,
  assertCorrectedCitingSpanInContext,
  computeHumanReviewProgress,
  deriveVerdictAgreement,
  HumanReviewConflictError,
  humanReviewEventLogSchema,
  projectHumanReviewRecords,
  type AppendHumanReviewRequest,
  type HumanReviewEvent,
  type HumanReviewEventLog,
  type HumanReviewLineage,
  type HumanReviewState,
  type HumanYesNo,
  type HumanYesNoNa,
} from "../contract/human-review.js";

function createEventId(): string {
  return `hrevent_${randomBytes(16).toString("hex")}`;
}

function emptyLog(lineage: HumanReviewLineage): HumanReviewEventLog {
  return {
    schemaVersion: "human-review-events-v2",
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
  unitKey: string;
  machine: Record<string, unknown>;
  human: {
    status: string;
    reviewer: string;
    updatedAt: string;
    eventId: string;
    revisionCount: number;
    assessment: HumanReviewEvent["assessment"];
  } | null;
  /** Derived per the evaluation protocol; absent until the record is reviewed. */
  calibration: HumanReviewCalibration | null;
};

/**
 * The three protocol measures, scored separately so a retrieval failure is
 * never counted as a classification error.
 */
export type HumanReviewCalibration = {
  /** Human and model top-label match; `not_applicable` when there is no pair. */
  labelAgreement: HumanYesNoNa;
  /** The reviewer judged the packet's evidence able to support a judgment. */
  evidenceSufficiency: HumanYesNo;
  /** Label agreement, sufficient evidence, and a sound packet, together. */
  endToEndValid: HumanYesNoNa;
  /** Whether the model's verdict stayed hidden for the whole review. */
  blinded: boolean;
};

/**
 * One row of calibration data: a seed finding as restated by one citing paper.
 * A citer that mentions the seed twice produces two machine records and one
 * unit, and pooling them would double-count the same restatement.
 */
export type HumanReviewExportUnit = {
  unitKey: string;
  familyId: string;
  citingPaperId: string;
  citingPaperTitle: string;
  trackedClaim: string;
  recordIds: string[];
  reviewedRecordCount: number;
  /** Distinct machine outcomes over the unit's records, in order. */
  machineVerdicts: string[];
  /** Distinct reviewer labels over the unit's records, in order. */
  humanVerdicts: string[];
  humanMutationKinds: string[];
  machineMutationKinds: string[];
  reviewers: string[];
  reviewStatuses: string[];
  notes: string[];
  calibration: HumanReviewCalibration | null;
};

function deriveCalibration(
  assessment: HumanReviewEvent["assessment"],
  machineVerdict: string | undefined,
): HumanReviewCalibration {
  const labelAgreement = deriveVerdictAgreement({
    humanVerdict: assessment.humanVerdict,
    machineVerdict,
  });
  const evidenceSufficiency =
    assessment.evidenceSufficiency === "sufficient" ? "yes" : "no";
  const packetSound =
    assessment.inScope === "yes" &&
    assessment.citingSpanValid === "yes" &&
    assessment.citedEvidenceValid === "yes";
  const endToEndValid: HumanYesNoNa =
    labelAgreement === "not_applicable"
      ? "not_applicable"
      : labelAgreement === "yes" && evidenceSufficiency === "yes" && packetSound
        ? "yes"
        : "no";
  return {
    labelAgreement,
    evidenceSufficiency,
    endToEndValid,
    blinded: assessment.blinded,
  };
}

/** The unit's measure is the weakest of its records: one bad packet spoils it. */
function collapseCalibration(
  measures: readonly HumanReviewCalibration[],
): HumanReviewCalibration | null {
  const first = measures[0];
  if (!first) return null;
  const worstYesNoNa = (values: readonly HumanYesNoNa[]): HumanYesNoNa =>
    values.includes("no")
      ? "no"
      : values.includes("not_applicable")
        ? "not_applicable"
        : "yes";
  return {
    labelAgreement: worstYesNoNa(measures.map((m) => m.labelAgreement)),
    evidenceSufficiency: measures.some((m) => m.evidenceSufficiency === "no")
      ? "no"
      : "yes",
    endToEndValid: worstYesNoNa(measures.map((m) => m.endToEndValid)),
    blinded: measures.every((m) => m.blinded),
  };
}

function machineString(
  snapshot: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = snapshot[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function machineStringArray(
  snapshot: Record<string, unknown>,
  key: string,
): string[] {
  const value = snapshot[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export type HumanReviewMachineRecord = {
  recordId: string;
  familyId: string;
  citingPaperId: string;
  claimTexts: readonly string[];
  snapshot: Record<string, unknown>;
};

export function buildHumanReviewExportBundle(input: {
  lineage: HumanReviewLineage;
  events: readonly HumanReviewEvent[];
  machineRecords: readonly HumanReviewMachineRecord[];
}): {
  schemaVersion: "human-review-export-v2";
  exportedAt: string;
  lineage: HumanReviewLineage;
  progress: ReturnType<typeof computeHumanReviewProgress>;
  records: HumanReviewExportRecord[];
  units: HumanReviewExportUnit[];
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
        unitKey: buildClaimUnitKey({
          familyId: machine.familyId,
          citingPaperId: machine.citingPaperId,
          claimTexts: machine.claimTexts,
        }),
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
        calibration: human
          ? deriveCalibration(
              human.assessment,
              machineString(machine.snapshot, "verdict"),
            )
          : null,
      };
    },
  );

  return {
    schemaVersion: "human-review-export-v2",
    exportedAt: new Date().toISOString(),
    lineage: input.lineage,
    progress: computeHumanReviewProgress({
      totalRecords: input.machineRecords.length,
      records: [...latest.values()],
    }),
    records,
    units: collapseToClaimUnits(records),
    events: [...input.events],
  };
}

function collapseToClaimUnits(
  records: readonly HumanReviewExportRecord[],
): HumanReviewExportUnit[] {
  const byUnit = new Map<string, HumanReviewExportRecord[]>();
  for (const record of records) {
    const group = byUnit.get(record.unitKey) ?? [];
    group.push(record);
    byUnit.set(record.unitKey, group);
  }

  return [...byUnit.entries()]
    .map(([unitKey, group]) => {
      const exemplar = group[0]!;
      const reviewed = group.filter((record) => record.human != null);
      return {
        unitKey,
        familyId: exemplar.familyId,
        citingPaperId: machineString(exemplar.machine, "citingPaperId") ?? "",
        citingPaperTitle:
          machineString(exemplar.machine, "citingPaperTitle") ?? "",
        trackedClaim: machineString(exemplar.machine, "trackedClaim") ?? "",
        recordIds: group.map((record) => record.recordId).sort(compareText),
        reviewedRecordCount: reviewed.length,
        machineVerdicts: distinct(
          group.map(
            (record) =>
              machineString(record.machine, "verdict") ??
              machineString(record.machine, "adjudicationStatus") ??
              "",
          ),
        ),
        humanVerdicts: distinct(
          reviewed.map((record) => record.human!.assessment.humanVerdict),
        ),
        humanMutationKinds: distinct(
          reviewed.flatMap((record) => record.human!.assessment.mutationKinds),
        ),
        machineMutationKinds: distinct(
          group.flatMap((record) =>
            machineStringArray(record.machine, "mutationKinds"),
          ),
        ),
        reviewers: distinct(reviewed.map((record) => record.human!.reviewer)),
        reviewStatuses: distinct(
          reviewed.map((record) => record.human!.status),
        ),
        notes: reviewed
          .map((record) => record.human!.assessment.notes)
          .filter((note) => note.length > 0),
        calibration: collapseCalibration(
          reviewed.flatMap((record) =>
            record.calibration ? [record.calibration] : [],
          ),
        ),
      };
    })
    .sort(
      (left, right) =>
        compareText(left.familyId, right.familyId) ||
        compareText(left.citingPaperId, right.citingPaperId),
    );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * One descriptor per column, used for both the header and every row, so a new
 * field cannot be added to one and forgotten in the other.
 */
const CLAIM_UNIT_CSV_FIELDS: {
  header: string;
  value: (unit: HumanReviewExportUnit) => string;
}[] = [
  { header: "familyId", value: (unit) => unit.familyId },
  { header: "citingPaperId", value: (unit) => unit.citingPaperId },
  { header: "citingPaperTitle", value: (unit) => unit.citingPaperTitle },
  { header: "trackedClaim", value: (unit) => unit.trackedClaim },
  { header: "recordIds", value: (unit) => unit.recordIds.join("|") },
  {
    header: "recordCount",
    value: (unit) => String(unit.recordIds.length),
  },
  {
    header: "reviewedRecordCount",
    value: (unit) => String(unit.reviewedRecordCount),
  },
  {
    header: "machineVerdicts",
    value: (unit) => unit.machineVerdicts.join("|"),
  },
  { header: "humanVerdicts", value: (unit) => unit.humanVerdicts.join("|") },
  {
    header: "machineMutationKinds",
    value: (unit) => unit.machineMutationKinds.join("|"),
  },
  {
    header: "humanMutationKinds",
    value: (unit) => unit.humanMutationKinds.join("|"),
  },
  {
    header: "labelAgreement",
    value: (unit) => unit.calibration?.labelAgreement ?? "",
  },
  {
    header: "evidenceSufficiency",
    value: (unit) => unit.calibration?.evidenceSufficiency ?? "",
  },
  {
    header: "endToEndValid",
    value: (unit) => unit.calibration?.endToEndValid ?? "",
  },
  {
    header: "blinded",
    value: (unit) => (unit.calibration ? String(unit.calibration.blinded) : ""),
  },
  { header: "reviewers", value: (unit) => unit.reviewers.join("|") },
  { header: "reviewStatuses", value: (unit) => unit.reviewStatuses.join("|") },
  { header: "notes", value: (unit) => unit.notes.join(" | ") },
];

export function renderHumanReviewCsv(
  units: readonly HumanReviewExportUnit[],
): string {
  const lines = [CLAIM_UNIT_CSV_FIELDS.map((field) => field.header).join(",")];
  for (const unit of units) {
    lines.push(
      CLAIM_UNIT_CSV_FIELDS.map((field) => csvEscape(field.value(unit))).join(
        ",",
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function loadHumanReviewExport(input: {
  runId: string;
  runRoot: string;
  reportArtifactId: string;
  reportContentHash: string;
  machineRecords: readonly HumanReviewMachineRecord[];
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
