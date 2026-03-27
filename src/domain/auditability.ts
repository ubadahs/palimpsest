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
  if (paper.fullTextStatus.status === "unavailable") {
    return {
      status: "not_auditable",
      reason: paper.fullTextStatus.reason,
    };
  }

  if (paper.fullTextStatus.status === "abstract_only") {
    return {
      status: "partially_auditable",
      reason: "Only abstract text is available",
    };
  }

  if (STRUCTURED_SOURCES.has(paper.fullTextStatus.source)) {
    return {
      status: "auditable_structured",
      reason: `Structured full text from ${paper.fullTextStatus.source}`,
    };
  }

  return {
    status: "auditable_pdf",
    reason: `Full text available as PDF from ${paper.fullTextStatus.source}`,
  };
}
