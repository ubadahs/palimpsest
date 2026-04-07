import type { AuditabilityStatus } from "./taxonomy.js";
import type { ResolvedPaper } from "./types.js";

export type AuditabilityAssessment = {
  status: AuditabilityStatus;
  reason: string;
};

const STRUCTURED_SOURCES = new Set([
  "biorxiv_xml",
  "pmc_xml",
  "pubmed_xml",
  "jats_xml",
]);

export function isAuditableForPreScreen(status: AuditabilityStatus): boolean {
  return status === "auditable_structured" || status === "auditable_pdf";
}

export function assessAuditability(
  paper: ResolvedPaper,
): AuditabilityAssessment {
  if (paper.fullTextHints.providerAvailability === "unavailable") {
    return {
      status: "not_auditable",
      reason: paper.fullTextHints.providerReason ?? "No open-access full text",
    };
  }

  if (paper.fullTextHints.providerAvailability === "abstract_only") {
    return {
      status: "partially_auditable",
      reason: "Only abstract text is available",
    };
  }

  if (
    paper.fullTextHints.providerSourceHint &&
    STRUCTURED_SOURCES.has(paper.fullTextHints.providerSourceHint)
  ) {
    return {
      status: "auditable_structured",
      reason: `Structured full text from ${paper.fullTextHints.providerSourceHint}`,
    };
  }

  return {
    status: "auditable_pdf",
    reason: `Full text available as PDF from ${paper.fullTextHints.providerSourceHint ?? "provider hint"}`,
  };
}
