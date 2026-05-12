import { describe, expect, it } from "vitest";

import { deriveAxisVerdict } from "../../src/adjudication/fidelity-vector-calibration.js";
import { aggregateFidelityVectorSamples } from "../../src/adjudication/fidelity-vector-stats.js";
import type {
  FidelityVectorAxisValues,
  FidelityVectorSample,
} from "../../src/domain/types.js";

const strongAxes: FidelityVectorAxisValues = {
  support: 0.9,
  evidenceGrounding: 0.9,
  claimIdentity: 0.9,
  directionalAlignment: 0.9,
  scopeMatch: 0.9,
  certaintyMatch: 0.85,
  attributionDirectness: 0.8,
  uncertainty: 0.2,
};

function aggregate(
  axes: Partial<FidelityVectorAxisValues>,
  scopeDirection: FidelityVectorSample["scopeDirection"] = "none",
  certaintyDirection: FidelityVectorSample["certaintyDirection"] = "none",
) {
  return {
    meanAxes: { ...strongAxes, ...axes },
    scopeDirectionDistribution: {
      none: scopeDirection === "none" ? 1 : 0,
      expansion: scopeDirection === "expansion" ? 1 : 0,
      contraction: scopeDirection === "contraction" ? 1 : 0,
      shift: scopeDirection === "shift" ? 1 : 0,
      unclear: scopeDirection === "unclear" ? 1 : 0,
    },
    certaintyDirectionDistribution: {
      none: certaintyDirection === "none" ? 1 : 0,
      escalation: certaintyDirection === "escalation" ? 1 : 0,
      deflation: certaintyDirection === "deflation" ? 1 : 0,
      shift: certaintyDirection === "shift" ? 1 : 0,
      unclear: certaintyDirection === "unclear" ? 1 : 0,
    },
    overallUncertainty: axes.uncertainty ?? strongAxes.uncertainty,
  };
}

function axis(score: number) {
  return { score, rationale: `score ${String(score)}` };
}

function sample(
  axes: Partial<FidelityVectorAxisValues>,
  suggestedVerdict: FidelityVectorSample["suggestedVerdict"],
): FidelityVectorSample {
  const scores = { ...strongAxes, ...axes };
  return {
    sampleIndex: 0,
    axes: {
      support: axis(scores.support),
      evidenceGrounding: axis(scores.evidenceGrounding),
      claimIdentity: axis(scores.claimIdentity),
      directionalAlignment: axis(scores.directionalAlignment),
      scopeMatch: axis(scores.scopeMatch),
      certaintyMatch: axis(scores.certaintyMatch),
      attributionDirectness: axis(scores.attributionDirectness),
      uncertainty: axis(scores.uncertainty),
    },
    scopeDirection: "none",
    certaintyDirection: "none",
    suggestedVerdict,
    rationale: "sample rationale",
  };
}

describe("fidelity vector axis-derived verdict calibration", () => {
  it("requires all core axes to be strong for supported", () => {
    expect(deriveAxisVerdict(aggregate({})).verdict).toBe("supported");
    expect(deriveAxisVerdict(aggregate({ claimIdentity: 0.72 })).verdict).toBe(
      "partially_supported",
    );
  });

  it("allows support at 0.75 when other core axes are strong", () => {
    expect(deriveAxisVerdict(aggregate({ support: 0.75 })).verdict).toBe(
      "supported",
    );
  });

  it("maps mild scope mismatch to partially_supported", () => {
    const derived = deriveAxisVerdict(
      aggregate({ scopeMatch: 0.72 }, "expansion"),
    );

    expect(derived.verdict).toBe("partially_supported");
  });

  it("maps severe scope expansion to overstated_or_generalized", () => {
    const derived = deriveAxisVerdict(
      aggregate({ scopeMatch: 0.6 }, "expansion"),
    );

    expect(derived.verdict).toBe("overstated_or_generalized");
  });

  it("maps mild certainty weakness to partially_supported", () => {
    const derived = deriveAxisVerdict(
      aggregate({ certaintyMatch: 0.72 }, "none", "escalation"),
    );

    expect(derived.verdict).toBe("partially_supported");
  });

  it("maps severe certainty escalation to overstated_or_generalized", () => {
    const derived = deriveAxisVerdict(
      aggregate({ certaintyMatch: 0.6 }, "none", "escalation"),
    );

    expect(derived.verdict).toBe("overstated_or_generalized");
  });

  it("maps very low evidence grounding to cannot_determine", () => {
    expect(
      deriveAxisVerdict(aggregate({ evidenceGrounding: 0.2 })).verdict,
    ).toBe("cannot_determine");
  });

  it("prevents supported when claim identity is very low", () => {
    expect(deriveAxisVerdict(aggregate({ claimIdentity: 0.3 })).verdict).toBe(
      "not_supported",
    );
  });

  it("maps very low directional alignment to not_supported", () => {
    expect(
      deriveAxisVerdict(aggregate({ directionalAlignment: 0.2 })).verdict,
    ).toBe("not_supported");
  });

  it("keeps sampled model verdict separate from axis-derived verdict", () => {
    const aggregateResult = aggregateFidelityVectorSamples([
      sample({ claimIdentity: 0.72, attributionDirectness: 0.55 }, "supported"),
    ]);

    expect(
      aggregateResult.sampledVerdictDistribution.modalSampledVerdict,
    ).toBe("supported");
    expect(aggregateResult.axisDerivedVerdict).toBe("partially_supported");
  });
});
