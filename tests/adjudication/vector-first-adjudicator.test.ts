import { describe, expect, it } from "vitest";
import type { z } from "zod";

import type { AuditSample } from "../../src/domain/types.js";
import { adjudicateAuditSample } from "../../src/adjudication/llm-adjudicator.js";
import { runVectorFirstAdjudication } from "../../src/adjudication/vector-first-adjudicator.js";
import type {
  GenerateObjectParams,
  GenerateObjectResult,
  GenerateTextResult,
  LLMCallRecord,
  LLMClient,
  LLMRunLedger,
} from "../../src/integrations/llm-client.js";

function axis(score: number) {
  return { score, rationale: `score ${String(score)}` };
}

function vectorResponse(
  overrides: {
    support?: number;
    evidenceGrounding?: number;
    claimIdentity?: number;
    uncertainty?: number;
    suggestedVerdict?: "supported" | "cannot_determine";
  } = {},
) {
  return {
    axes: {
      support: axis(overrides.support ?? 0.9),
      evidenceGrounding: axis(overrides.evidenceGrounding ?? 0.9),
      claimIdentity: axis(overrides.claimIdentity ?? 0.9),
      directionalAlignment: axis(0.9),
      scopeMatch: axis(0.9),
      certaintyMatch: axis(0.9),
      attributionDirectness: axis(0.9),
      uncertainty: axis(overrides.uncertainty ?? 0.1),
    },
    scopeDirection: "none",
    certaintyDirection: "none",
    suggestedVerdict: overrides.suggestedVerdict ?? "supported",
    rationale: "The supplied evidence supports the citing claim.",
  };
}

function makeRecord(
  purpose: LLMCallRecord["purpose"],
  model: string,
): LLMCallRecord {
  return {
    purpose,
    model,
    attempted: true,
    successful: true,
    failed: false,
    billable: true,
    thinkingEnabled: false,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    latencyMs: 10,
    finishReason: "stop",
    timestamp: "2026-05-12T00:00:00.000Z",
    estimatedCostUsd: 0.001,
  };
}

function emptyLedger(): LLMRunLedger {
  return {
    totalCalls: 0,
    totalAttemptedCalls: 0,
    totalSuccessfulCalls: 0,
    totalFailedCalls: 0,
    totalBillableCalls: 0,
    totalExactCacheHits: 0,
    totalEstimatedCostUsd: 0,
    byPurpose: {},
    calls: [],
  };
}

function makeAuditSample(): AuditSample {
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
        groundedSeedClaimText: "The cited paper supports the tracked claim.",
        citingSpan: "Smith 2020 reported the tracked claim.",
        citingMarker: "Smith 2020",
        rubricQuestion: "Does the cited paper support the tracked claim?",
        evidenceSpans: [],
        evidenceRetrievalStatus: "retrieved",
      },
    ],
    samplingStrategy: {
      targetByMode: { fidelity_specific_claim: 1 },
      oversampled: [],
    },
  };
}

function makeVectorClient(responses: unknown[]): {
  client: LLMClient;
  calls: Array<{
    purpose: string;
    exactCache: unknown;
    model: string | undefined;
  }>;
} {
  const calls: Array<{
    purpose: string;
    exactCache: unknown;
    model: string | undefined;
  }> = [];

  return {
    calls,
    client: {
      generateText(): Promise<GenerateTextResult> {
        return Promise.reject(new Error("generateText should not be called"));
      },
      generateObject<T extends z.ZodType>(
        params: GenerateObjectParams<T>,
      ): Promise<GenerateObjectResult<z.infer<T>>> {
        calls.push({
          purpose: params.purpose,
          exactCache: params.exactCache,
          model: params.model,
        });
        if (params.purpose !== "fidelity-vector") {
          return Promise.reject(new Error("categorical adjudication skipped"));
        }
        const object = responses.shift();
        if (!object) {
          return Promise.reject(new Error("unexpected extra vector call"));
        }
        return Promise.resolve({
          object: object as z.infer<T>,
          record: makeRecord("fidelity-vector", params.model ?? "vector"),
        });
      },
      getLedger: emptyLedger,
    },
  };
}

describe("vector-first adjudicator", () => {
  it("accepts clean axis-derived records without categorical calls or post-hoc tracing", async () => {
    const { client, calls } = makeVectorClient([vectorResponse()]);

    const result = await adjudicateAuditSample(makeAuditSample(), {
      apiKey: "test",
      adjudicationMode: "vector_first",
      llmClient: client,
      vectorFirst: {
        initialSamples: 1,
        maxSamples: 3,
        model: "claude-sonnet-4-6",
        temperature: 0.7,
        concurrency: 1,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.purpose === "fidelity-vector")).toBe(
      true,
    );
    expect(calls.every((call) => call.exactCache == null)).toBe(true);
    expect(result.records[0]!.verdict).toBe("supported");
    expect(result.records[0]!.adjudicator).toBe(
      "vector-first:claude-sonnet-4-6:axis-derived",
    );
    expect(result.records[0]!.rationale).toContain("Axis-derived verdict:");
    expect(result.records[0]!.comparison).toContain("Axis-derived");
    expect(result.records[0]!.vectorRoutingDecision).toMatchObject({
      finalVerdictSource: "axis_derived",
      acceptedAxisDerivedVerdict: "supported",
      triggeredCategoricalAdjudicator: false,
    });
  });

  it("adaptively samples borderline records before accepting the aggregate", async () => {
    const { client } = makeVectorClient([
      vectorResponse({ support: 0.7 }),
      vectorResponse(),
      vectorResponse(),
    ]);

    const result = await adjudicateAuditSample(makeAuditSample(), {
      apiKey: "test",
      adjudicationMode: "vector_first",
      llmClient: client,
      vectorFirst: {
        initialSamples: 1,
        maxSamples: 3,
        model: "claude-sonnet-4-6",
        temperature: 0.7,
        concurrency: 1,
      },
    });

    expect(result.records[0]!.fidelityVectorTrace?.sampleCount).toBe(3);
    expect(result.records[0]!.vectorRoutingDecision).toMatchObject({
      triggeredAdaptiveSampling: true,
      finalSampleCount: 3,
      finalVerdictSource: "axis_derived",
    });
    expect(
      result.records[0]!.vectorRoutingDecision?.adaptiveSamplingReasons,
    ).toContain("core_axis_borderline");
  });

  it("escalates risky records using original unmodified audit records", async () => {
    const { client, calls } = makeVectorClient([
      vectorResponse({
        evidenceGrounding: 0.3,
        claimIdentity: 0.3,
        uncertainty: 0.9,
        suggestedVerdict: "cannot_determine",
      }),
    ]);
    let sawOriginalSubset = false;

    const result = await runVectorFirstAdjudication({
      set: makeAuditSample(),
      client,
      options: {
        initialSamples: 1,
        maxSamples: 1,
        model: "claude-sonnet-4-6",
        temperature: 0.7,
        concurrency: 1,
      },
      runCategoricalAdjudication: (subset) => {
        const record = subset.records[0]!;
        sawOriginalSubset =
          record.verdict == null &&
          record.comparison == null &&
          record.rationale == null &&
          record.fidelityVectorTrace == null &&
          record.vectorRoutingDecision == null;
        return Promise.resolve({
          ...subset,
          records: [
            {
              ...record,
              comparison:
                "The citing paper attributes X. The cited paper shows X.",
              verdict: "supported",
              rationale: "Categorical fallback supported the claim.",
              retrievalQuality: "high",
              judgeConfidence: "high",
              adjudicator: "llm:claude-opus-4-6",
              adjudicatedAt: "2026-05-12T00:00:00.000Z",
              telemetry: makeRecord("adjudication", "claude-opus-4-6"),
            },
          ],
          runTelemetry: {
            model: "claude-opus-4-6",
            useExtendedThinking: false,
            totalCalls: 1,
            successfulCalls: 1,
            failedCalls: 0,
            totalInputTokens: 100,
            totalOutputTokens: 20,
            totalReasoningTokens: 0,
            totalTokens: 120,
            totalLatencyMs: 10,
            averageLatencyMs: 10,
            estimatedCostUsd: 0.001,
            calls: [],
          },
        });
      },
    });

    expect(sawOriginalSubset).toBe(true);
    expect(calls).toHaveLength(1);
    expect(result.records[0]!.verdict).toBe("supported");
    expect(result.records[0]!.rationale).toBe(
      "Categorical fallback supported the claim.",
    );
    expect(result.records[0]!.fidelityVectorTrace?.sampleCount).toBe(1);
    expect(result.records[0]!.vectorRoutingDecision).toMatchObject({
      finalVerdictSource: "categorical_escalation",
      triggeredCategoricalAdjudicator: true,
      categoricalVerdict: "supported",
    });
  });
});
