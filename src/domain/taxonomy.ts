import { z } from "zod";

export const citationFunctionValues = [
  "empirical_attribution",
  "methodological_reference",
  "conceptual_framing",
  "priority_claim",
  "rhetorical_bundling",
  "contrast_or_disagreement",
] as const;

export const citationFunctionSchema = z.enum(citationFunctionValues);
export type CitationFunction = z.infer<typeof citationFunctionSchema>;

export const supportedCitationFunction = "empirical_attribution" as const;

export const auditabilityStatusValues = [
  "auditable_structured",
  "auditable_pdf",
  "partially_auditable",
  "not_auditable",
] as const;

export const auditabilityStatusSchema = z.enum(auditabilityStatusValues);
export type AuditabilityStatus = z.infer<typeof auditabilityStatusSchema>;

export const fidelityTopLabelValues = ["F", "D", "E", "U"] as const;

export const fidelityTopLabelSchema = z.enum(fidelityTopLabelValues);
export type FidelityTopLabel = z.infer<typeof fidelityTopLabelSchema>;

// Note: DistortionSubtype (D1-D5), ErrorSubtype (E1-E3), EvidenceVsInterpretation,
// and ConfidenceLevel were removed as unused. The subtype codes are defined in the
// PRD (docs/conception/prd.md) and can be reintroduced with an explicit label mapping
// if fidelity classification advances to subtype granularity. Confidence is defined
// in extraction.ts.
