import type { ReportInspectorRecordRow } from "palimpsest/contract";

export type ReportRateLike = {
  metricId: string;
  numerator: number;
  denominator: number;
  value: number | null;
  unit: string;
  populationLabel: string;
  numeratorDefinition: string;
  denominatorDefinition: string;
};

export type ReportCountLike = {
  metricId: string;
  count: number;
  unit: string;
  population: string;
};

const RATE_LABELS: Record<string, string> = {
  scope_selection_rate: "Scope selection",
  retrieval_coverage: "Retrieval coverage",
  adjudication_coverage: "Adjudication coverage",
  verdict_F_rate: "F rate",
  verdict_D_rate: "D rate",
  verdict_E_rate: "E rate",
  verdict_U_rate: "U rate",
};

export function rateLabel(metricId: string): string {
  return RATE_LABELS[metricId] ?? metricId.replaceAll("_", " ");
}

export function formatRateValue(rate: ReportRateLike): string {
  if (rate.value == null || rate.denominator === 0) {
    return "Not estimable";
  }
  return `${(rate.value * 100).toFixed(rate.value === 0 || rate.value === 1 ? 0 : 1)}%`;
}

export function formatRateFraction(rate: ReportRateLike): string {
  return `${String(rate.numerator)} / ${String(rate.denominator)}`;
}

export function humanizeCode(value: string): string {
  return value.replaceAll("_", " ");
}

export function recordOutcomeLabel(record: ReportInspectorRecordRow): string {
  if (record.adjudicationStatus === "adjudicated" && record.verdict) {
    return record.verdict;
  }
  if (record.adjudicationStatus === "not_adjudicated") {
    return record.gateCode ? humanizeCode(record.gateCode) : "Not adjudicated";
  }
  if (record.adjudicationStatus === "adjudication_failed") {
    return record.failureCode
      ? humanizeCode(record.failureCode)
      : "Adjudication failed";
  }
  return "Invalid output";
}

export function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}
