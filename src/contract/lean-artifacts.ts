/**
 * The canonical artifact contract, as one import surface.
 *
 * The definitions live in `artifacts/`, one module per stage plus the shared
 * envelope and the leaf consistency checks. This file exists so every caller
 * keeps a single stable import path.
 */
export {
  artifactReferenceSchema,
  leanArtifactIdSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "./lean-artifact-primitives.js";
export {
  adjudicateArtifactPayloadSchema,
  adjudicateFailureCodeSchema,
  adjudicateFatalFailureCodeSchema,
  adjudicateGateCodeSchema,
  adjudicateLineageSchema,
  adjudicateNonfatalFailureCodeSchema,
  adjudicateRecordOutcomeSchema,
  buildAdjudicationResultId,
  canonicalAdjudicateMethod,
  canonicalAdjudicateMethodId,
  canonicalAdjudicateMethodSchema,
  canonicalAdjudicateModelOutputSchema,
  hashCanonicalAdjudicatePrompt,
  hashCanonicalAdjudicateRequest,
  type AdjudicateArtifactPayload,
  type AdjudicateFailureCode,
  type AdjudicateFatalFailureCode,
  type AdjudicateGateCode,
  type AdjudicateLineage,
  type AdjudicateNonfatalFailureCode,
  type AdjudicateRecordOutcome,
  type CanonicalAdjudicateMethod,
  type CanonicalAdjudicateModelOutput,
} from "./canonical-adjudicate.js";
export {
  evidenceRerankStatusSchema,
  evidenceRetrievalStatusSchema,
  type EvidenceRerankStatus,
  type EvidenceRetrievalStatus,
} from "./canonical-evidence-statuses.js";
export {
  REPORT_INTERPRETATION_WARNING,
  REPORT_PUBLICATION_REASON,
  REQUIRED_REPORT_RATE_METRIC_IDS,
  buildReportDecisionRecordId,
  buildReportCount,
  buildReportRate,
  canonicalReportMethod,
  canonicalReportMethodId,
  canonicalReportMethodSchema,
  reportArtifactPayloadSchema,
  reportInterpretationStatusSchema,
  reportLineageSchema,
  reportRateSchema,
  reportRecordTraceSchema,
  type CanonicalReportMethod,
  type ReportArtifactPayload,
  type ReportCount,
  type ReportDecisionSummary,
  type ReportFamilyMutation,
  type ReportFamilyMutationRecord,
  type ReportFunnelCounts,
  type ReportLineage,
  type ReportRate,
  type ReportRecordTrace,
  type ReportInterpretationStatus,
} from "./canonical-report.js";

export * from "./artifacts/envelope.js";
export * from "./artifacts/discover.js";
export * from "./artifacts/scope.js";
export * from "./artifacts/prepare.js";
export * from "./artifacts/evidence.js";
export * from "./artifacts/seed-section-role.js";
