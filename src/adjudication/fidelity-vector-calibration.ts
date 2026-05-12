import type {
  CertaintyDirectionDistribution,
  FidelityVectorAggregate,
  FidelityVectorVerdict,
  ScopeDirectionDistribution,
} from "../domain/types.js";

export type AxisDerivedVerdictResult = {
  verdict: FidelityVectorVerdict;
  reason: string;
  rule: string;
};

// Heuristic v1 thresholds. These are intentionally conservative and
// uncalibrated; tune them against benchmarked examples before treating the
// derived verdict as anything more than diagnostic.
export const AXIS_DERIVED_VERDICT_THRESHOLDS = {
  highSupport: 0.75,
  highEvidenceGrounding: 0.8,
  highClaimIdentity: 0.8,
  highDirectionalAlignment: 0.8,
  highScopeMatch: 0.8,
  highCertaintyMatch: 0.75,
  maxSupportedUncertainty: 0.45,
  decentSupport: 0.65,
  decentEvidenceGrounding: 0.6,
  materialScopeMismatch: 0.7,
  materialCertaintyMismatch: 0.7,
  veryLowSupport: 0.4,
  veryLowEvidenceGrounding: 0.45,
  veryLowClaimIdentity: 0.45,
  veryLowDirectionalAlignment: 0.45,
  veryHighUncertainty: 0.75,
} as const;

export function deriveAxisVerdict(
  aggregate: Pick<
    FidelityVectorAggregate,
    | "meanAxes"
    | "scopeDirectionDistribution"
    | "certaintyDirectionDistribution"
    | "overallUncertainty"
  >,
): AxisDerivedVerdictResult {
  const axes = aggregate.meanAxes;
  const thresholds = AXIS_DERIVED_VERDICT_THRESHOLDS;
  const scopeDirection = dominantScopeDirection(
    aggregate.scopeDirectionDistribution,
  );
  const certaintyDirection = dominantCertaintyDirection(
    aggregate.certaintyDirectionDistribution,
  );
  const uncertainty = Math.max(axes.uncertainty, aggregate.overallUncertainty);
  const hasMaterialScopeProblem =
    scopeDirection === "expansion" &&
    axes.scopeMatch < thresholds.materialScopeMismatch;
  const hasMaterialCertaintyProblem =
    certaintyDirection === "escalation" &&
    axes.certaintyMatch < thresholds.materialCertaintyMismatch;

  if (
    axes.evidenceGrounding < thresholds.veryLowEvidenceGrounding ||
    uncertainty >= thresholds.veryHighUncertainty
  ) {
    return {
      verdict: "cannot_determine",
      rule: "cannot_determine_low_grounding_or_high_uncertainty",
      reason:
        "Evidence grounding is very low or uncertainty is very high, so the diagnostic verdict cannot be determined from the retrieved snippets.",
    };
  }

  if (
    axes.directionalAlignment < thresholds.veryLowDirectionalAlignment &&
    axes.evidenceGrounding >= thresholds.decentEvidenceGrounding
  ) {
    return {
      verdict: "not_supported",
      rule: "not_supported_directional_mismatch",
      reason:
        "Directional alignment is very low while evidence grounding is adequate, indicating the citing claim points away from the cited evidence.",
    };
  }

  if (
    axes.support < thresholds.veryLowSupport ||
    (axes.claimIdentity < thresholds.veryLowClaimIdentity &&
      axes.evidenceGrounding >= thresholds.decentEvidenceGrounding)
  ) {
    return {
      verdict: "not_supported",
      rule: "not_supported_low_support_or_identity",
      reason:
        "Support or claim identity is very low despite usable evidence, so the retrieved evidence does not support the citing claim.",
    };
  }

  if (
    axes.support >= thresholds.highSupport &&
    axes.evidenceGrounding >= thresholds.highEvidenceGrounding &&
    axes.claimIdentity >= thresholds.highClaimIdentity &&
    axes.directionalAlignment >= thresholds.highDirectionalAlignment &&
    axes.scopeMatch >= thresholds.highScopeMatch &&
    axes.certaintyMatch >= thresholds.highCertaintyMatch &&
    uncertainty < thresholds.maxSupportedUncertainty &&
    !hasMaterialScopeProblem &&
    !hasMaterialCertaintyProblem
  ) {
    return {
      verdict: "supported",
      rule: "supported_all_core_axes_strong",
      reason:
        "Core support, grounding, identity, direction, scope, and certainty axes are strong, with low uncertainty and no scope or certainty warning.",
    };
  }

  if (
    axes.support >= thresholds.decentSupport &&
    axes.evidenceGrounding >= thresholds.decentEvidenceGrounding &&
    (hasMaterialScopeProblem || hasMaterialCertaintyProblem)
  ) {
    return {
      verdict: "overstated_or_generalized",
      rule: "overstated_scope_or_certainty_warning",
      reason:
        "Evidence broadly supports the claim, but a scope expansion or certainty escalation is paired with a materially weakened match axis.",
    };
  }

  if (
    axes.support >= thresholds.decentSupport &&
    axes.evidenceGrounding >= thresholds.decentEvidenceGrounding
  ) {
    return {
      verdict: "partially_supported",
      rule: "partially_supported_weakened_noncritical_axis",
      reason:
        "Evidence broadly supports the claim, but one or more identity, scope, certainty, directness, or uncertainty axes is weakened.",
    };
  }

  return {
    verdict: "cannot_determine",
    rule: "cannot_determine_insufficient_support_or_grounding",
    reason:
      "Support or evidence grounding is below the threshold needed for a partial-support diagnostic verdict.",
  };
}

function dominantScopeDirection(
  distribution: ScopeDirectionDistribution,
): keyof ScopeDirectionDistribution {
  return selectDominant(distribution, [
    "expansion",
    "shift",
    "unclear",
    "contraction",
    "none",
  ]);
}

function dominantCertaintyDirection(
  distribution: CertaintyDirectionDistribution,
): keyof CertaintyDirectionDistribution {
  return selectDominant(distribution, [
    "escalation",
    "shift",
    "unclear",
    "deflation",
    "none",
  ]);
}

function selectDominant<T extends string>(
  distribution: Record<T, number>,
  tieBreakOrder: T[],
): T {
  let best = tieBreakOrder[0]!;
  let bestCount = distribution[best];

  for (const key of tieBreakOrder.slice(1)) {
    const count = distribution[key];
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }

  return best;
}
