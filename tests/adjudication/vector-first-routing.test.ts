import { describe, expect, it } from "vitest";

import type {
  AdjudicationRecord,
  FidelityVectorAggregate,
  FidelityVectorAxisValues,
} from "../../src/domain/types.js";
import {
  decideAdaptiveSampling,
  decideCategoricalEscalation,
  deriveVectorFirstJudgeConfidence,
  deriveVectorFirstRetrievalQuality,
} from "../../src/adjudication/vector-first-routing.js";

function axes(overrides: Partial<FidelityVectorAxisValues> = {}) {
  return {
    support: 0.9,
    evidenceGrounding: 0.9,
    claimIdentity: 0.9,
    directionalAlignment: 0.9,
    scopeMatch: 0.9,
    certaintyMatch: 0.9,
    attributionDirectness: 0.9,
    uncertainty: 0.1,
    ...overrides,
  };
}

function aggregate(
  overrides: Partial<FidelityVectorAggregate> = {},
): FidelityVectorAggregate {
  return {
    meanAxes: axes(),
    varianceAxes: axes({
      support: 0,
      evidenceGrounding: 0,
      claimIdentity: 0,
      directionalAlignment: 0,
      scopeMatch: 0,
      certaintyMatch: 0,
      attributionDirectness: 0,
      uncertainty: 0,
    }),
    sampledVerdictDistribution: {
      sampleCount: 1,
      counts: {
        supported: 1,
        partially_supported: 0,
        overstated_or_generalized: 0,
        not_supported: 0,
        cannot_determine: 0,
      },
      modalSampledVerdict: "supported",
      entropy: 0,
    },
    axisDerivedVerdict: "supported",
    axisDerivedVerdictReason: "All core axes are strong.",
    axisDerivedVerdictRule: "supported_all_core_axes_strong",
    scopeDirectionDistribution: {
      none: 1,
      expansion: 0,
      contraction: 0,
      shift: 0,
      unclear: 0,
    },
    certaintyDirectionDistribution: {
      none: 1,
      escalation: 0,
      deflation: 0,
      shift: 0,
      unclear: 0,
    },
    disagreementScore: 0,
    overallUncertainty: 0.1,
    ...overrides,
  };
}

function record(
  overrides: Partial<AdjudicationRecord> = {},
): AdjudicationRecord {
  return {
    recordId: "record-1",
    taskId: "task-1",
    evaluationMode: "fidelity_specific_claim",
    citationRole: "substantive_attribution",
    modifiers: { isBundled: false, isReviewMediated: false },
    citingPaperTitle: "Citing Paper",
    citedPaperTitle: "Cited Paper",
    citingSpan: "Citing context.",
    citingMarker: "Smith 2020",
    rubricQuestion: "Question?",
    evidenceSpans: [],
    evidenceRetrievalStatus: "retrieved",
    ...overrides,
  };
}

describe("vector-first routing policy", () => {
  it("does not route clean high-confidence aggregates", () => {
    const clean = aggregate();

    expect(decideAdaptiveSampling(record(), clean)).toMatchObject({
      triggered: false,
      reasons: [],
    });
    expect(decideCategoricalEscalation(record(), clean)).toMatchObject({
      triggered: false,
      reasons: [],
    });
    expect(deriveVectorFirstRetrievalQuality(clean)).toBe("high");
    expect(deriveVectorFirstJudgeConfidence(clean)).toBe("high");
  });

  it("triggers adaptive sampling for borderline core axes", () => {
    const borderline = aggregate({
      meanAxes: axes({ support: 0.7 }),
    });

    expect(decideAdaptiveSampling(record(), borderline).reasons).toContain(
      "core_axis_borderline",
    );
  });

  it("escalates uncertain and poorly grounded aggregates", () => {
    const risky = aggregate({
      meanAxes: axes({ evidenceGrounding: 0.4, uncertainty: 0.7 }),
      axisDerivedVerdict: "cannot_determine",
      overallUncertainty: 0.7,
    });

    expect(decideCategoricalEscalation(record(), risky).reasons).toEqual(
      expect.arrayContaining([
        "axis_verdict_cannot_determine",
        "aggregate_uncertainty_high",
        "evidence_grounding_low",
      ]),
    );
    expect(deriveVectorFirstRetrievalQuality(risky)).toBe("low");
    expect(deriveVectorFirstJudgeConfidence(risky)).toBe("medium");
  });
});
