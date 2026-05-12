import { describe, expect, it } from "vitest";

import type { FidelityVectorSample } from "../../src/domain/types.js";
import {
  aggregateFidelityVectorSamples,
  computeMean,
  computeNormalizedEntropy,
  computeSampleVariance,
  selectModalVerdict,
} from "../../src/adjudication/fidelity-vector-stats.js";

function axis(score: number) {
  return { score, rationale: `score ${String(score)}` };
}

function sample(
  sampleIndex: number,
  support: number,
  suggestedVerdict: FidelityVectorSample["suggestedVerdict"],
): FidelityVectorSample {
  return {
    sampleIndex,
    axes: {
      support: axis(support),
      evidenceGrounding: axis(0.8),
      claimIdentity: axis(0.7),
      directionalAlignment: axis(0.6),
      scopeMatch: axis(0.5),
      certaintyMatch: axis(0.4),
      attributionDirectness: axis(0.9),
      uncertainty: axis(0.2 + sampleIndex * 0.1),
    },
    scopeDirection: sampleIndex === 1 ? "expansion" : "none",
    certaintyDirection: sampleIndex === 2 ? "escalation" : "none",
    suggestedVerdict,
    rationale: "sample rationale",
  };
}

describe("fidelity vector stats", () => {
  it("computes mean and sample variance", () => {
    expect(computeMean([1, 0, 0.5])).toBeCloseTo(0.5);
    expect(computeSampleVariance([1, 0, 0.5])).toBeCloseTo(0.25);
    expect(computeSampleVariance([1])).toBe(0);
  });

  it("computes normalized entropy bounded in the unit interval", () => {
    expect(computeNormalizedEntropy({ a: 3, b: 0, c: 0 })).toBe(0);
    const entropy = computeNormalizedEntropy({ a: 1, b: 1, c: 1 });
    expect(entropy).toBeGreaterThan(0.99);
    expect(entropy).toBeLessThanOrEqual(1);
  });

  it("selects modal verdict with conservative tie-break", () => {
    expect(
      selectModalVerdict({
        supported: 1,
        partially_supported: 0,
        overstated_or_generalized: 1,
        not_supported: 1,
        cannot_determine: 0,
      }),
    ).toBe("not_supported");
  });

  it("aggregates axes, verdicts, directions, and uncertainty", () => {
    const aggregate = aggregateFidelityVectorSamples([
      sample(0, 1, "supported"),
      sample(1, 0, "not_supported"),
      sample(2, 0.5, "not_supported"),
    ]);

    expect(aggregate.meanAxes.support).toBeCloseTo(0.5);
    expect(aggregate.varianceAxes.support).toBeCloseTo(0.25);
    expect(aggregate.verdictDistribution.counts.not_supported).toBe(2);
    expect(aggregate.verdictDistribution.modalVerdict).toBe("not_supported");
    expect(aggregate.scopeDirectionDistribution.expansion).toBe(1);
    expect(aggregate.certaintyDirectionDistribution.escalation).toBe(1);
    expect(aggregate.disagreementScore).toBeGreaterThanOrEqual(0);
    expect(aggregate.disagreementScore).toBeLessThanOrEqual(1);
    expect(aggregate.overallUncertainty).toBeGreaterThanOrEqual(0);
    expect(aggregate.overallUncertainty).toBeLessThanOrEqual(1);
  });
});
