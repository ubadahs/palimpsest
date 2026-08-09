import type { StageInspectorPayload } from "palimpsest/contract";

export type ReportPayload = StageInspectorPayload<"report">;

export type RecordFilter =
  | "all"
  | "F"
  | "D"
  | "E"
  | "U"
  | "not_adjudicated"
  | "failed";

export type ReportTab =
  | "overview"
  | "families"
  | "records"
  | "review"
  | "audit";
