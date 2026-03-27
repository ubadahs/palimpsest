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

export const distortionSubtypeValues = ["D1", "D2", "D3", "D4", "D5"] as const;

export const distortionSubtypeSchema = z.enum(distortionSubtypeValues);
export type DistortionSubtype = z.infer<typeof distortionSubtypeSchema>;

export const errorSubtypeValues = ["E1", "E2", "E3"] as const;

export const errorSubtypeSchema = z.enum(errorSubtypeValues);
export type ErrorSubtype = z.infer<typeof errorSubtypeSchema>;

export const evidenceVsInterpretationValues = [
  "evidence",
  "interpretation",
  "both",
  "unclear",
] as const;

export const evidenceVsInterpretationSchema = z.enum(
  evidenceVsInterpretationValues,
);
export type EvidenceVsInterpretation = z.infer<
  typeof evidenceVsInterpretationSchema
>;

export const confidenceLevelValues = ["low", "medium", "high"] as const;

export const confidenceLevelSchema = z.enum(confidenceLevelValues);
export type ConfidenceLevel = z.infer<typeof confidenceLevelSchema>;
