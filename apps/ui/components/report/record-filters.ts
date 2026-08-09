import type { ReportInspectorRecordRow } from "palimpsest/contract";

import type { RecordFilter } from "./types";

export function matchesRecordFilter(
  record: ReportInspectorRecordRow,
  filter: RecordFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "not_adjudicated") {
    return record.adjudicationStatus === "not_adjudicated";
  }
  if (filter === "failed") {
    return (
      record.adjudicationStatus === "adjudication_failed" ||
      record.adjudicationStatus === "invalid_output"
    );
  }
  return (
    record.adjudicationStatus === "adjudicated" && record.verdict === filter
  );
}
