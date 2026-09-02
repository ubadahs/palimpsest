import { describe, expect, it } from "vitest";

import {
  mergeCostSummaries,
  summarizeLedgerByStage,
} from "../../src/pipeline/cost-summary.js";
import type { LLMRunLedger } from "../../src/integrations/llm-client.js";

type Call = LLMRunLedger["calls"][number];

function call(overrides: Partial<Call>): Call {
  return {
    purpose: "seed-grounding",
    model: "claude-sonnet-4-6",
    attempted: true,
    successful: true,
    failed: false,
    billable: true,
    thinkingEnabled: false,
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    latencyMs: 5,
    finishReason: "stop",
    timestamp: "2026-09-02T12:00:00.000Z",
    estimatedCostUsd: 0.01,
    ...overrides,
  };
}

function ledgerOf(calls: Call[]): LLMRunLedger {
  return {
    totalCalls: calls.length,
    totalAttemptedCalls: calls.length,
    totalSuccessfulCalls: calls.filter((c) => c.successful).length,
    totalFailedCalls: calls.filter((c) => c.failed).length,
    totalBillableCalls: calls.filter((c) => c.billable).length,
    totalExactCacheHits: calls.filter((c) => c.exactCacheHit).length,
    totalCacheReadTokens: calls.reduce(
      (sum, c) => sum + (c.cacheReadTokens ?? 0),
      0,
    ),
    totalCacheWriteTokens: calls.reduce(
      (sum, c) => sum + (c.cacheWriteTokens ?? 0),
      0,
    ),
    totalEstimatedCostUsd: calls.reduce(
      (sum, c) => sum + c.estimatedCostUsd,
      0,
    ),
    byPurpose: {},
    calls,
  };
}

describe("run cost summary", () => {
  it("attributes cache reads and writes to the stage that made the call", () => {
    const summary = summarizeLedgerByStage(
      ledgerOf([
        call({
          stageKey: "scope",
          cacheWriteTokens: 4_000,
        }),
        call({
          stageKey: "scope",
          cacheReadTokens: 4_000,
        }),
        call({
          purpose: "adjudication",
          stageKey: "adjudicate",
        }),
      ]),
    );

    expect(summary.byStage.map((stage) => stage.stage)).toEqual([
      "adjudicate",
      "scope",
    ]);
    expect(summary.byStage.find((s) => s.stage === "scope")).toMatchObject({
      calls: 2,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 4_000,
    });
    expect(summary.byStage.find((s) => s.stage === "adjudicate")).toMatchObject(
      {
        calls: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    );
  });

  it("adds a resume attempt to what an earlier attempt already spent", () => {
    const first = summarizeLedgerByStage(
      ledgerOf([call({ stageKey: "discover", estimatedCostUsd: 0.5 })]),
    );
    first.byPurpose = {
      "attributed-claim-extraction": {
        attempted: 1,
        successful: 1,
        failed: 0,
        billable: 1,
        exactCacheHits: 0,
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.5,
      },
    };
    const resume = summarizeLedgerByStage(
      ledgerOf([
        call({
          stageKey: "discover",
          estimatedCostUsd: 0.25,
          exactCacheHit: true,
          cacheReadTokens: 900,
        }),
        call({ stageKey: "adjudicate", estimatedCostUsd: 2 }),
      ]),
    );
    resume.byPurpose = {
      "attributed-claim-extraction": {
        attempted: 1,
        successful: 1,
        failed: 0,
        billable: 1,
        exactCacheHits: 1,
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.25,
      },
      adjudication: {
        attempted: 1,
        successful: 1,
        failed: 0,
        billable: 1,
        exactCacheHits: 0,
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 2,
      },
    };

    const merged = mergeCostSummaries(first, resume);

    expect(merged.totalEstimatedCostUsd).toBeCloseTo(2.75);
    expect(merged.totalCalls).toBe(3);
    expect(merged.totalExactCacheHits).toBe(1);
    expect(merged.totalCacheReadTokens).toBe(900);
    expect(merged.byStage.find((s) => s.stage === "discover")).toMatchObject({
      calls: 2,
      estimatedCostUsd: 0.75,
      exactCacheHits: 1,
      cacheReadTokens: 900,
    });
    expect(merged.byPurpose["attributed-claim-extraction"]).toMatchObject({
      attempted: 2,
      estimatedCostUsd: 0.75,
      cacheReadTokens: 900,
    });
    expect(merged.byPurpose.adjudication).toMatchObject({
      attempted: 1,
      estimatedCostUsd: 2,
    });
  });
});
