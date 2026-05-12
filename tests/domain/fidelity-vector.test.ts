import { describe, expect, it } from "vitest";

import {
  adjudicationRecordSchema,
  fidelityVectorSampleSchema,
  fidelityVectorTraceSchema,
  type FidelityVectorTrace,
} from "../../src/domain/types.js";

function axis(score: number) {
  return { score, rationale: `rationale ${String(score)}` };
}

function axes() {
  return {
    support: axis(0.8),
    evidenceGrounding: axis(0.7),
    claimIdentity: axis(0.6),
    directionalAlignment: axis(0.9),
    scopeMatch: axis(0.5),
    certaintyMatch: axis(0.4),
    attributionDirectness: axis(0.75),
    uncertainty: axis(0.2),
  };
}

function validTrace(): FidelityVectorTrace {
  return {
    version: "fidelity-vector-trace-v1",
    model: "claude-sonnet-4-6",
    temperature: 0.7,
    sampleCount: 1,
    samples: [
      {
        sampleIndex: 0,
        axes: axes(),
        scopeDirection: "none",
        certaintyDirection: "none",
        suggestedVerdict: "supported",
        rationale: "The evidence supports the citing claim.",
      },
    ],
    aggregate: {
      meanAxes: {
        support: 0.8,
        evidenceGrounding: 0.7,
        claimIdentity: 0.6,
        directionalAlignment: 0.9,
        scopeMatch: 0.5,
        certaintyMatch: 0.4,
        attributionDirectness: 0.75,
        uncertainty: 0.2,
      },
      varianceAxes: {
        support: 0,
        evidenceGrounding: 0,
        claimIdentity: 0,
        directionalAlignment: 0,
        scopeMatch: 0,
        certaintyMatch: 0,
        attributionDirectness: 0,
        uncertainty: 0,
      },
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
      axisDerivedVerdict: "overstated_or_generalized",
      axisDerivedVerdictReason:
        "Evidence broadly supports the claim, but scope or certainty axes indicate expansion, shift, escalation, or weakened match.",
      axisDerivedVerdictRule: "overstated_scope_or_certainty_warning",
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
    },
    canonicalVerdict: "supported",
    canonicalVerdictAgreement: true,
    canonicalSampledVerdictAgreement: true,
    canonicalAxisDerivedVerdictAgreement: false,
  };
}

function validRecord() {
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
    rubricQuestion: "Does the cited paper support the claim?",
    evidenceSpans: [],
    evidenceRetrievalStatus: "no_matches",
  };
}

describe("fidelity vector schemas", () => {
  it("parses adjudication records without a fidelity vector trace", () => {
    expect(adjudicationRecordSchema.parse(validRecord())).toMatchObject({
      recordId: "record-1",
    });
  });

  it("parses adjudication records with a valid fidelity vector trace", () => {
    const parsed = adjudicationRecordSchema.parse({
      ...validRecord(),
      fidelityVectorTrace: validTrace(),
    });

    expect(
      parsed.fidelityVectorTrace?.aggregate.sampledVerdictDistribution,
    ).toMatchObject({
      modalSampledVerdict: "supported",
    });
    expect(parsed.fidelityVectorTrace?.aggregate.axisDerivedVerdict).toBe(
      "overstated_or_generalized",
    );
  });

  it("parses adjudication records with vector-first routing provenance", () => {
    const parsed = adjudicationRecordSchema.parse({
      ...validRecord(),
      vectorRoutingDecision: {
        version: "vector-routing-v1",
        adjudicationMode: "vector_first",
        finalVerdictSource: "axis_derived",
        triggeredAdaptiveSampling: false,
        triggeredCategoricalAdjudicator: false,
        initialSampleCount: 1,
        finalSampleCount: 1,
        adaptiveSamplingReasons: [],
        categoricalEscalationReasons: [],
        acceptedAxisDerivedVerdict: "supported",
      },
    });

    expect(parsed.vectorRoutingDecision?.finalVerdictSource).toBe(
      "axis_derived",
    );
  });

  it("rejects axis scores outside the unit interval", () => {
    const trace = validTrace();
    trace.samples[0]!.axes.support.score = 1.1;

    expect(() => fidelityVectorTraceSchema.parse(trace)).toThrow();
  });

  it("requires every v1 axis and rejects extra axis names", () => {
    const sample = validTrace().samples[0]!;

    expect(() =>
      fidelityVectorSampleSchema.parse({
        ...sample,
        axes: {
          ...sample.axes,
          uncertainty: undefined,
        },
      }),
    ).toThrow();

    expect(() =>
      fidelityVectorSampleSchema.parse({
        ...sample,
        axes: {
          ...sample.axes,
          extraAxis: axis(0.5),
        },
      }),
    ).toThrow();
  });

  it("rejects invalid direction values", () => {
    const sample = validTrace().samples[0]!;

    expect(() =>
      fidelityVectorSampleSchema.parse({
        ...sample,
        scopeDirection: "broader",
      }),
    ).toThrow();
  });
});
