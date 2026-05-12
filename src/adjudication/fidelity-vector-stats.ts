import type {
  CertaintyDirection,
  CertaintyDirectionDistribution,
  FidelityAxis,
  FidelityVectorAggregate,
  FidelityVectorAxisValues,
  FidelityVectorSample,
  FidelityVectorVerdict,
  FidelityVectorVerdictCounts,
  ScopeDirection,
  ScopeDirectionDistribution,
} from "../domain/types.js";
import { fidelityAxisValues } from "../domain/types.js";
import { deriveAxisVerdict } from "./fidelity-vector-calibration.js";

const CONSERVATIVE_VERDICT_ORDER: FidelityVectorVerdict[] = [
  "cannot_determine",
  "not_supported",
  "overstated_or_generalized",
  "partially_supported",
  "supported",
];

export function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeSampleVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = computeMean(values);
  const squaredDiffs = values.map((value) => (value - mean) ** 2);
  return (
    squaredDiffs.reduce((sum, value) => sum + value, 0) / (values.length - 1)
  );
}

export function computeNormalizedEntropy(
  counts: Record<string, number>,
): number {
  const values = Object.values(counts);
  const total = values.reduce((sum, count) => sum + count, 0);
  if (total <= 0 || values.length <= 1) return 0;

  let entropy = 0;
  for (const count of values) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log(p);
  }

  return clamp01(entropy / Math.log(values.length));
}

export function selectModalVerdict(
  counts: FidelityVectorVerdictCounts,
): FidelityVectorVerdict {
  let best = CONSERVATIVE_VERDICT_ORDER[0]!;
  let bestCount = counts[best];

  for (const verdict of CONSERVATIVE_VERDICT_ORDER.slice(1)) {
    const count = counts[verdict];
    if (count > bestCount) {
      best = verdict;
      bestCount = count;
    }
  }

  return best;
}

export function aggregateFidelityVectorSamples(
  samples: FidelityVectorSample[],
): FidelityVectorAggregate {
  const meanAxes = mapAxisValues((axis) =>
    computeMean(samples.map((sample) => sample.axes[axis].score)),
  );
  const varianceAxes = mapAxisValues((axis) =>
    computeSampleVariance(samples.map((sample) => sample.axes[axis].score)),
  );

  const verdictCounts = countVerdicts(samples);
  const verdictEntropy = computeNormalizedEntropy(verdictCounts);
  const meanAxisVariance = computeMean(
    fidelityAxisValues.map((axis) => varianceAxes[axis]),
  );
  const scopeDirectionDistribution = countScopeDirections(samples);
  const certaintyDirectionDistribution = countCertaintyDirections(samples);
  const overallUncertainty = clamp01(
    0.5 * meanAxes.uncertainty + 0.3 * verdictEntropy + 0.2 * meanAxisVariance,
  );
  const axisDerived = deriveAxisVerdict({
    meanAxes,
    scopeDirectionDistribution,
    certaintyDirectionDistribution,
    overallUncertainty,
  });

  return {
    meanAxes,
    varianceAxes,
    sampledVerdictDistribution: {
      sampleCount: samples.length,
      counts: verdictCounts,
      modalSampledVerdict: selectModalVerdict(verdictCounts),
      entropy: verdictEntropy,
    },
    axisDerivedVerdict: axisDerived.verdict,
    axisDerivedVerdictReason: axisDerived.reason,
    axisDerivedVerdictRule: axisDerived.rule,
    scopeDirectionDistribution,
    certaintyDirectionDistribution,
    disagreementScore: verdictEntropy,
    overallUncertainty,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mapAxisValues(
  mapper: (axis: FidelityAxis) => number,
): FidelityVectorAxisValues {
  return {
    support: mapper("support"),
    evidenceGrounding: mapper("evidenceGrounding"),
    claimIdentity: mapper("claimIdentity"),
    directionalAlignment: mapper("directionalAlignment"),
    scopeMatch: mapper("scopeMatch"),
    certaintyMatch: mapper("certaintyMatch"),
    attributionDirectness: mapper("attributionDirectness"),
    uncertainty: mapper("uncertainty"),
  };
}

function countVerdicts(
  samples: FidelityVectorSample[],
): FidelityVectorVerdictCounts {
  const counts: FidelityVectorVerdictCounts = {
    supported: 0,
    partially_supported: 0,
    overstated_or_generalized: 0,
    not_supported: 0,
    cannot_determine: 0,
  };

  for (const sample of samples) {
    counts[sample.suggestedVerdict]++;
  }

  return counts;
}

function countScopeDirections(
  samples: FidelityVectorSample[],
): ScopeDirectionDistribution {
  const counts: ScopeDirectionDistribution = {
    none: 0,
    expansion: 0,
    contraction: 0,
    shift: 0,
    unclear: 0,
  };

  for (const sample of samples) {
    incrementDirection(counts, sample.scopeDirection);
  }

  return counts;
}

function countCertaintyDirections(
  samples: FidelityVectorSample[],
): CertaintyDirectionDistribution {
  const counts: CertaintyDirectionDistribution = {
    none: 0,
    escalation: 0,
    deflation: 0,
    shift: 0,
    unclear: 0,
  };

  for (const sample of samples) {
    incrementDirection(counts, sample.certaintyDirection);
  }

  return counts;
}

function incrementDirection<
  TDirection extends ScopeDirection | CertaintyDirection,
  TCounts extends Record<TDirection, number>,
>(counts: TCounts, direction: TDirection): void {
  counts[direction]++;
}
