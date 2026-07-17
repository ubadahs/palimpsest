import type { LLMRunLedger } from "../integrations/llm-client.js";

type RunCostStageSummary = {
  stage: string;
  estimatedCostUsd: number;
  calls: number;
  attemptedCalls: number;
  successfulCalls: number;
  failedCalls: number;
  billableCalls: number;
  exactCacheHits: number;
};

export type RunCostSummary = {
  totalEstimatedCostUsd: number;
  totalCalls: number;
  totalAttemptedCalls: number;
  totalSuccessfulCalls: number;
  totalFailedCalls: number;
  totalBillableCalls: number;
  totalExactCacheHits: number;
  byStage: RunCostStageSummary[];
  byPurpose: LLMRunLedger["byPurpose"];
  generatedAt: string;
};

export function summarizeLedgerByStage(ledger: LLMRunLedger): RunCostSummary {
  const stageMap = new Map<string, RunCostStageSummary>();

  for (const call of ledger.calls) {
    const stage = call.stageKey ?? "unknown";
    const existing = stageMap.get(stage);
    if (existing) {
      existing.estimatedCostUsd += call.estimatedCostUsd;
      existing.calls += 1;
      existing.attemptedCalls += 1;
      existing.successfulCalls += call.successful ? 1 : 0;
      existing.failedCalls += call.failed ? 1 : 0;
      existing.billableCalls += call.billable ? 1 : 0;
      existing.exactCacheHits += call.exactCacheHit ? 1 : 0;
    } else {
      stageMap.set(stage, {
        stage,
        estimatedCostUsd: call.estimatedCostUsd,
        calls: 1,
        attemptedCalls: 1,
        successfulCalls: call.successful ? 1 : 0,
        failedCalls: call.failed ? 1 : 0,
        billableCalls: call.billable ? 1 : 0,
        exactCacheHits: call.exactCacheHit ? 1 : 0,
      });
    }
  }

  return {
    totalEstimatedCostUsd: ledger.totalEstimatedCostUsd,
    totalCalls: ledger.totalCalls,
    totalAttemptedCalls: ledger.totalAttemptedCalls,
    totalSuccessfulCalls: ledger.totalSuccessfulCalls,
    totalFailedCalls: ledger.totalFailedCalls,
    totalBillableCalls: ledger.totalBillableCalls,
    totalExactCacheHits: ledger.totalExactCacheHits,
    byStage: [...stageMap.values()].sort((a, b) =>
      a.stage.localeCompare(b.stage),
    ),
    byPurpose: ledger.byPurpose,
    generatedAt: new Date().toISOString(),
  };
}
