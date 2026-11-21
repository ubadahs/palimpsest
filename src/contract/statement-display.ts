import { compareCodeUnits } from "../shared/order.js";
import type { ReportRecordTrace } from "./artifacts/report.js";
import type {
  ScopeCitationStatement,
  ScopeSeedInventory,
} from "./artifacts/scope-statements.js";

function comparePublicationYears(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left === right) return 0;
  return (
    (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY)
  );
}

export function comparePaperPublicationDates(
  left: {
    publicationYear?: number | undefined;
    title: string;
    paperId: string;
  },
  right: {
    publicationYear?: number | undefined;
    title: string;
    paperId: string;
  },
): number {
  return (
    comparePublicationYears(left.publicationYear, right.publicationYear) ||
    compareCodeUnits(left.title, right.title) ||
    compareCodeUnits(left.paperId, right.paperId)
  );
}

export function compareStatementDates(
  left: ScopeCitationStatement,
  right: ScopeCitationStatement,
): number {
  return (
    comparePublicationYears(
      left.citingPublicationYear,
      right.citingPublicationYear,
    ) ||
    compareCodeUnits(left.citingTitle, right.citingTitle) ||
    compareCodeUnits(left.statementId, right.statementId)
  );
}

export function compareSeedInventoryDates(
  left: ScopeSeedInventory,
  right: ScopeSeedInventory,
): number {
  return (
    comparePublicationYears(
      left.seedPublicationYear,
      right.seedPublicationYear,
    ) ||
    compareCodeUnits(left.seedTitle, right.seedTitle) ||
    compareCodeUnits(left.seedId, right.seedId)
  );
}

export function titleWithPublicationYear(
  title: string,
  year: number | undefined,
): string {
  return `${title} (${year == null ? "year unknown" : String(year)})`;
}

const relationshipLabels: Readonly<Record<string, string>> = {
  full: "Full restatement",
  partial: "Partial restatement",
  scope_changed: "Scope changed",
  distinct: "Distinct statement",
  uncertain: "Relationship uncertain",
  unassessed: "Relationship unassessed",
};

export function statementRelationshipLabel(relationship: string): string {
  return relationshipLabels[relationship] ?? relationship.replaceAll("_", " ");
}

export function statementCreditLabel(credit: string): string {
  switch (credit) {
    case "single_reference":
      return "Single cited reference";
    case "shared_reference_group":
      return "Shared citation credit";
    default:
      return "Citation credit unverified";
  }
}

/** Offsets refer to the saved context, so repeated markers stay distinct. */
export function splitCitationMarker(
  context: string,
  span?: { charOffsetStart: number; charOffsetEnd: number },
): { before: string; marker: string; after: string } | undefined {
  if (
    !span ||
    span.charOffsetStart < 0 ||
    span.charOffsetStart >= span.charOffsetEnd ||
    span.charOffsetEnd > context.length
  ) {
    return undefined;
  }
  return {
    before: context.slice(0, span.charOffsetStart),
    marker: context.slice(span.charOffsetStart, span.charOffsetEnd),
    after: context.slice(span.charOffsetEnd),
  };
}

export type ReportStatementFidelity = {
  recordId: string;
  adjudication: ReportRecordTrace["adjudication"];
};

export function indexReportStatementFidelity(
  traces: readonly ReportRecordTrace[],
): Record<string, ReportStatementFidelity[]> {
  const entries = new Map<string, ReportStatementFidelity[]>();
  for (const { recordId, adjudication, citationStatementIds } of traces) {
    for (const statementId of citationStatementIds) {
      const results = entries.get(statementId) ?? [];
      results.push({ recordId, adjudication });
      entries.set(statementId, results);
    }
  }
  return Object.fromEntries(entries);
}

export function statementFidelityLabel({
  adjudication: result,
}: ReportStatementFidelity): string {
  switch (result.status) {
    case "adjudicated":
      return result.verdict;
    case "not_adjudicated":
      return `Unexamined (${result.gateCode.replaceAll("_", " ")})`;
    case "adjudication_failed":
      return `Adjudication failed (${result.failureCode.replaceAll("_", " ")})`;
    case "invalid_output":
      return "Invalid adjudication output";
  }
}
