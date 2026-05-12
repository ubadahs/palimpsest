import type {
  AdjudicationRecord,
  Confidence,
  FidelityAxis,
  FidelityVectorAggregate,
  RetrievalQuality,
  VectorRoutingAdaptiveReason,
  VectorRoutingCategoricalEscalationReason,
} from "../domain/types.js";
import { fidelityAxisValues } from "../domain/types.js";

export const VECTOR_FIRST_ROUTING_POLICY = {
  nearThresholdMargin: 0.05,
  adaptiveUncertaintyMin: 0.55,
  adaptiveCoreAxisBorderlineMin: 0.55,
  adaptiveCoreAxisBorderlineMax: 0.75,
  escalateUncertaintyMin: 0.65,
  escalateDisagreementMin: 0.5,
  escalateMeanAxisVarianceMin: 0.04,
  escalateGroundingMin: 0.65,
  escalateClaimIdentityMin: 0.65,
  retrievalQualityHighGrounding: 0.8,
  retrievalQualityMediumGrounding: 0.6,
  judgeConfidenceHighUncertaintyMax: 0.35,
  judgeConfidenceHighDisagreementMax: 0.15,
  judgeConfidenceHighVarianceMax: 0.03,
} as const;

const CORE_AXES: FidelityAxis[] = [
  "support",
  "evidenceGrounding",
  "claimIdentity",
  "directionalAlignment",
  "scopeMatch",
  "certaintyMatch",
];

export type VectorRoutingDecisionResult<TReason extends string> = {
  triggered: boolean;
  reasons: TReason[];
};

export function decideAdaptiveSampling(
  record: AdjudicationRecord,
  aggregate: FidelityVectorAggregate,
): VectorRoutingDecisionResult<VectorRoutingAdaptiveReason> {
  const reasons: VectorRoutingAdaptiveReason[] = [];
  const axes = aggregate.meanAxes;
  const modalVerdict = aggregate.sampledVerdictDistribution.modalSampledVerdict;

  if (aggregate.axisDerivedVerdict === "cannot_determine") {
    reasons.push("axis_verdict_cannot_determine");
  }
  if (
    Math.max(axes.uncertainty, aggregate.overallUncertainty) >=
    VECTOR_FIRST_ROUTING_POLICY.adaptiveUncertaintyMin
  ) {
    reasons.push("uncertainty_borderline");
  }
  if (CORE_AXES.some((axis) => isAdaptiveBorderline(axes[axis]))) {
    reasons.push("core_axis_borderline");
  }
  if (modalVerdict !== aggregate.axisDerivedVerdict) {
    reasons.push("sampled_verdict_disagrees_with_axis");
  }
  if (
    record.modifiers.isBundled &&
    (modalVerdict !== aggregate.axisDerivedVerdict ||
      aggregate.overallUncertainty >=
        VECTOR_FIRST_ROUTING_POLICY.adaptiveUncertaintyMin)
  ) {
    reasons.push("bundled_citation_scope_ambiguous");
  }

  return {
    triggered: reasons.length > 0,
    reasons: dedupeReasons(reasons),
  };
}

export function decideCategoricalEscalation(
  record: AdjudicationRecord,
  aggregate: FidelityVectorAggregate,
): VectorRoutingDecisionResult<VectorRoutingCategoricalEscalationReason> {
  const reasons: VectorRoutingCategoricalEscalationReason[] = [];
  const axes = aggregate.meanAxes;
  const modalVerdict = aggregate.sampledVerdictDistribution.modalSampledVerdict;

  if (aggregate.axisDerivedVerdict === "cannot_determine") {
    reasons.push("axis_verdict_cannot_determine");
  }
  if (
    Math.max(axes.uncertainty, aggregate.overallUncertainty) >=
    VECTOR_FIRST_ROUTING_POLICY.escalateUncertaintyMin
  ) {
    reasons.push("aggregate_uncertainty_high");
  }
  if (
    aggregate.sampledVerdictDistribution.entropy >=
    VECTOR_FIRST_ROUTING_POLICY.escalateDisagreementMin
  ) {
    reasons.push("sample_disagreement_high");
  }
  if (
    meanAxisVariance(aggregate) >=
    VECTOR_FIRST_ROUTING_POLICY.escalateMeanAxisVarianceMin
  ) {
    reasons.push("axis_variance_high");
  }
  if (
    axes.evidenceGrounding < VECTOR_FIRST_ROUTING_POLICY.escalateGroundingMin
  ) {
    reasons.push("evidence_grounding_low");
  }
  if (
    axes.claimIdentity < VECTOR_FIRST_ROUTING_POLICY.escalateClaimIdentityMin
  ) {
    reasons.push("claim_identity_low");
  }
  if (modalVerdict !== aggregate.axisDerivedVerdict) {
    reasons.push("modal_sampled_verdict_disagrees_with_axis");
  }
  if (
    record.modifiers.isBundled &&
    (modalVerdict !== aggregate.axisDerivedVerdict ||
      aggregate.overallUncertainty >=
        VECTOR_FIRST_ROUTING_POLICY.escalateUncertaintyMin)
  ) {
    reasons.push("bundled_citation_scope_ambiguous");
  }

  return {
    triggered: reasons.length > 0,
    reasons: dedupeReasons(reasons),
  };
}

export function deriveVectorFirstRetrievalQuality(
  aggregate: FidelityVectorAggregate,
): RetrievalQuality {
  const grounding = aggregate.meanAxes.evidenceGrounding;
  if (grounding >= VECTOR_FIRST_ROUTING_POLICY.retrievalQualityHighGrounding) {
    return "high";
  }
  if (
    grounding >= VECTOR_FIRST_ROUTING_POLICY.retrievalQualityMediumGrounding
  ) {
    return "medium";
  }
  return "low";
}

export function deriveVectorFirstJudgeConfidence(
  aggregate: FidelityVectorAggregate,
): Confidence {
  if (
    Math.max(aggregate.meanAxes.uncertainty, aggregate.overallUncertainty) <=
      VECTOR_FIRST_ROUTING_POLICY.judgeConfidenceHighUncertaintyMax &&
    aggregate.disagreementScore <=
      VECTOR_FIRST_ROUTING_POLICY.judgeConfidenceHighDisagreementMax &&
    meanAxisVariance(aggregate) <=
      VECTOR_FIRST_ROUTING_POLICY.judgeConfidenceHighVarianceMax &&
    aggregate.sampledVerdictDistribution.modalSampledVerdict ===
      aggregate.axisDerivedVerdict
  ) {
    return "high";
  }

  return "medium";
}

export function meanAxisVariance(aggregate: FidelityVectorAggregate): number {
  const variances = fidelityAxisValues.map(
    (axis) => aggregate.varianceAxes[axis],
  );
  return variances.reduce((sum, value) => sum + value, 0) / variances.length;
}

function isAdaptiveBorderline(value: number): boolean {
  return (
    value >= VECTOR_FIRST_ROUTING_POLICY.adaptiveCoreAxisBorderlineMin &&
    value <= VECTOR_FIRST_ROUTING_POLICY.adaptiveCoreAxisBorderlineMax
  );
}

function dedupeReasons<TReason extends string>(reasons: TReason[]): TReason[] {
  return [...new Set(reasons)];
}
