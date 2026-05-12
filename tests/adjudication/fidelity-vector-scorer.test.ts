import { describe, expect, it } from "vitest";
import type { z } from "zod";

import type { AuditSample } from "../../src/domain/types.js";
import type {
  GenerateObjectParams,
  GenerateObjectResult,
  GenerateTextParams,
  GenerateTextResult,
  LLMCallRecord,
  LLMClient,
  LLMRunLedger,
} from "../../src/integrations/llm-client.js";
import { adjudicateAuditSample } from "../../src/adjudication/llm-adjudicator.js";

function axis(score: number) {
  return { score, rationale: `score ${String(score)}` };
}

function vectorResponse() {
  return {
    axes: {
      support: axis(0.8),
      evidenceGrounding: axis(0.7),
      claimIdentity: axis(0.8),
      directionalAlignment: axis(0.9),
      scopeMatch: axis(0.6),
      certaintyMatch: axis(0.5),
      attributionDirectness: axis(0.75),
      uncertainty: axis(0.2),
    },
    scopeDirection: "none",
    certaintyDirection: "none",
    suggestedVerdict: "supported",
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
        citingSpan: "Smith 2020 reported the finding.",
        citingMarker: "Smith 2020",
        rubricQuestion: "Does the cited paper support the claim?",
        evidenceSpans: [],
        evidenceRetrievalStatus: "no_matches",
      },
    ],
    samplingStrategy: {
      targetByMode: { fidelity_specific_claim: 1 },
      oversampled: [],
    },
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

describe("fidelity vector scorer wiring", () => {
  it("samples fidelity vectors after normal adjudication", async () => {
    const generateObjectCalls: Array<{
      purpose: string;
      exactCache: unknown;
      temperature: unknown;
      model: string | undefined;
    }> = [];
    const client: LLMClient = {
      generateText(): Promise<GenerateTextResult> {
        return Promise.reject(new Error("generateText should not be called"));
      },
      generateObject<T extends z.ZodType>(
        params: GenerateObjectParams<T>,
      ): Promise<GenerateObjectResult<z.infer<T>>> {
        generateObjectCalls.push({
          purpose: params.purpose,
          exactCache: params.exactCache,
          temperature: params.temperature,
          model: params.model,
        });

        if (params.purpose === "adjudication") {
          return Promise.resolve({
            object: {
              comparison:
                "The citing paper attributes X. The cited paper shows X.",
              verdict: "supported",
              rationale: "Supported.",
              retrievalQuality: "high",
              judgeConfidence: "high",
            } as z.infer<T>,
            record: makeRecord("adjudication", params.model ?? "adjudicator"),
          });
        }

        return Promise.resolve({
          object: vectorResponse() as z.infer<T>,
          record: makeRecord("fidelity-vector", params.model ?? "vector"),
        });
      },
      getLedger: emptyLedger,
    };

    const result = await adjudicateAuditSample(makeAuditSample(), {
      apiKey: "test",
      model: "claude-opus-4-6",
      useExtendedThinking: false,
      llmClient: client,
      enableExactCache: true,
      fidelityVectorTrace: {
        enabled: true,
        sampleCount: 3,
        model: "claude-sonnet-4-6",
        temperature: 0.7,
        concurrency: 1,
      },
    });

    const vectorCalls = generateObjectCalls.filter(
      (call) => call.purpose === "fidelity-vector",
    );
    expect(vectorCalls).toHaveLength(3);
    expect(vectorCalls.every((call) => call.exactCache == null)).toBe(true);
    expect(vectorCalls.every((call) => call.temperature === 0.7)).toBe(true);
    expect(
      vectorCalls.every((call) => call.model === "claude-sonnet-4-6"),
    ).toBe(true);
    expect(
      result.records[0]!.fidelityVectorTrace?.canonicalVerdictAgreement,
    ).toBe(true);
    expect(result.records[0]!.fidelityVectorTrace?.sampleCount).toBe(3);
  });

  it("samples vectors only after advisor escalation has produced final records", async () => {
    const vectorCalls: GenerateObjectParams<z.ZodType>[] = [];
    const client: LLMClient = {
      generateText(params: GenerateTextParams): Promise<GenerateTextResult> {
        return Promise.resolve({
          text: JSON.stringify({
            comparison:
              "The citing paper attributes X. The cited paper evidence is missing.",
            verdict: "cannot_determine",
            rationale: "Escalate.",
            retrievalQuality: "low",
            judgeConfidence: "low",
          }),
          record: makeRecord("adjudication", params.model ?? "first-pass"),
        });
      },
      generateObject<T extends z.ZodType>(
        params: GenerateObjectParams<T>,
      ): Promise<GenerateObjectResult<z.infer<T>>> {
        if (params.purpose === "fidelity-vector") {
          vectorCalls.push(params);
          return Promise.resolve({
            object: vectorResponse() as z.infer<T>,
            record: makeRecord("fidelity-vector", params.model ?? "vector"),
          });
        }

        return Promise.resolve({
          object: {
            comparison:
              "The citing paper attributes X. The cited paper shows X.",
            verdict: "supported",
            rationale: "Supported after escalation.",
            retrievalQuality: "high",
            judgeConfidence: "high",
          } as z.infer<T>,
          record: makeRecord("adjudication", params.model ?? "main"),
        });
      },
      getLedger: emptyLedger,
    };

    const result = await adjudicateAuditSample(makeAuditSample(), {
      apiKey: "test",
      model: "claude-opus-4-6",
      useExtendedThinking: false,
      llmClient: client,
      advisor: { firstPassModel: "claude-sonnet-4-6" },
      fidelityVectorTrace: {
        enabled: true,
        sampleCount: 1,
        model: "claude-sonnet-4-6",
        temperature: 0.7,
        concurrency: 1,
      },
    });

    expect(vectorCalls).toHaveLength(1);
    expect(result.records[0]!.verdict).toBe("supported");
    expect(
      result.records[0]!.fidelityVectorTrace?.canonicalVerdictAgreement,
    ).toBe(true);
  });
});
