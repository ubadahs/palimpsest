import { describe, expect, it } from "vitest";

import type {
  AuditSample,
  FidelityVectorTrace,
} from "../../src/domain/types.js";
import { toAuditSampleSummaryMarkdown } from "../../src/reporting/audit-sample-summary.js";

function trace(): FidelityVectorTrace {
  return {
    version: "fidelity-vector-trace-v1",
    model: "claude-sonnet-4-6",
    temperature: 0.7,
    sampleCount: 1,
    samples: [],
    aggregate: {
      meanAxes: {
        support: 0.812,
        evidenceGrounding: 0.734,
        claimIdentity: 0.7,
        directionalAlignment: 0.9,
        scopeMatch: 0.456,
        certaintyMatch: 0.345,
        attributionDirectness: 0.8,
        uncertainty: 0.234,
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
    telemetry: {
      totalCalls: 1,
      successfulCalls: 1,
      failedCalls: 0,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalReasoningTokens: 0,
      totalTokens: 120,
      totalLatencyMs: 10,
      estimatedCostUsd: 0.0012,
      calls: [],
    },
  };
}

function sample(withTrace: boolean): AuditSample {
  return {
    seed: { doi: "10.1234/seed", trackedClaim: "Tracked claim" },
    resolvedSeedPaperTitle: "Cited Paper",
    studyMode: "all_functions_census",
    createdAt: "2026-05-12T00:00:00.000Z",
    targetSize: 1,
    records: [
      {
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
        evidenceRetrievalStatus: "no_matches",
        verdict: "supported",
        rationale: "Supported.",
        retrievalQuality: "high",
        judgeConfidence: "high",
        ...(withTrace ? { fidelityVectorTrace: trace() } : {}),
      },
    ],
    samplingStrategy: {
      targetByMode: { fidelity_specific_claim: 1 },
      oversampled: [],
    },
  };
}

describe("audit sample summary", () => {
  it("omits fidelity vector section when traces are absent", () => {
    expect(toAuditSampleSummaryMarkdown(sample(false))).not.toContain(
      "Fidelity Vector Trace Summary",
    );
  });

  it("summarizes fidelity vector traces when present", () => {
    const markdown = toAuditSampleSummaryMarkdown(sample(true));

    expect(markdown).toContain("## Fidelity Vector Trace Summary");
    expect(markdown).toContain(
      "| task-1 | supported | supported | overstated_or_generalized | no | 0.81 | 0.73 | 0.70 | 0.46 | 0.34 | 0.23 |",
    );
    expect(markdown).toContain(
      "Vector trace calls: 1; estimated vector cost: $0.0012.",
    );
  });

  it("summarizes vector-first routing only when provenance is present", () => {
    const withRouting: AuditSample = {
      ...sample(true),
      records: [
        {
          ...sample(true).records[0]!,
          vectorRoutingDecision: {
            version: "vector-routing-v1",
            adjudicationMode: "vector_first",
            finalVerdictSource: "axis_derived",
            triggeredAdaptiveSampling: true,
            triggeredCategoricalAdjudicator: false,
            initialSampleCount: 1,
            finalSampleCount: 3,
            adaptiveSamplingReasons: ["core_axis_borderline"],
            categoricalEscalationReasons: [],
            acceptedAxisDerivedVerdict: "supported",
          },
        },
      ],
    };

    expect(toAuditSampleSummaryMarkdown(sample(true))).not.toContain(
      "Vector-First Routing Summary",
    );

    const markdown = toAuditSampleSummaryMarkdown(withRouting);
    expect(markdown).toContain("## Vector-First Routing Summary");
    expect(markdown).toContain("| Vector-derived accepted records | 1 |");
    expect(markdown).toContain("| axis_derived | 1 |");
    expect(markdown).toContain("| core_axis_borderline | 1 |");
  });
});
