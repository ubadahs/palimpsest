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
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type RunCostSummary = {
  totalEstimatedCostUsd: number;
  totalCalls: number;
  totalAttemptedCalls: number;
  totalSuccessfulCalls: number;
  totalFailedCalls: number;
  totalBillableCalls: number;
  totalExactCacheHits: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  byStage: RunCostStageSummary[];
  byPurpose: LLMRunLedger["byPurpose"];
  generatedAt: string;
};

export function summarizeLedgerByStage(ledger: LLMRunLedger): RunCostSummary {
  const stageMap = new Map<string, RunCostStageSummary>();

  for (const call of ledger.calls) {
    const stage = call.stageKey ?? "unknown";
    const existing = stageMap.get(stage) ?? emptyStageSummary(stage);
    existing.estimatedCostUsd += call.estimatedCostUsd;
    existing.calls += 1;
    existing.attemptedCalls += 1;
    existing.successfulCalls += call.successful ? 1 : 0;
    existing.failedCalls += call.failed ? 1 : 0;
    existing.billableCalls += call.billable ? 1 : 0;
    existing.exactCacheHits += call.exactCacheHit ? 1 : 0;
    existing.cacheReadTokens += call.cacheReadTokens ?? 0;
    existing.cacheWriteTokens += call.cacheWriteTokens ?? 0;
    stageMap.set(stage, existing);
  }

  return {
    totalEstimatedCostUsd: ledger.totalEstimatedCostUsd,
    totalCalls: ledger.totalCalls,
    totalAttemptedCalls: ledger.totalAttemptedCalls,
    totalSuccessfulCalls: ledger.totalSuccessfulCalls,
    totalFailedCalls: ledger.totalFailedCalls,
    totalBillableCalls: ledger.totalBillableCalls,
    totalExactCacheHits: ledger.totalExactCacheHits,
    totalCacheReadTokens: ledger.totalCacheReadTokens,
    totalCacheWriteTokens: ledger.totalCacheWriteTokens,
    byStage: [...stageMap.values()].sort((a, b) =>
      a.stage.localeCompare(b.stage),
    ),
    byPurpose: ledger.byPurpose,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * A resume opens a fresh client, so its ledger covers only the stages it
 * re-ran. Overwriting would silently erase what the earlier attempt spent, and
 * the run's total cost is the sum of both attempts.
 */
export function mergeCostSummaries(
  previous: RunCostSummary,
  next: RunCostSummary,
): RunCostSummary {
  const byStage = new Map<string, RunCostStageSummary>();
  for (const stage of [...previous.byStage, ...next.byStage]) {
    const existing = byStage.get(stage.stage) ?? emptyStageSummary(stage.stage);
    byStage.set(stage.stage, {
      stage: stage.stage,
      estimatedCostUsd: existing.estimatedCostUsd + stage.estimatedCostUsd,
      calls: existing.calls + stage.calls,
      attemptedCalls: existing.attemptedCalls + stage.attemptedCalls,
      successfulCalls: existing.successfulCalls + stage.successfulCalls,
      failedCalls: existing.failedCalls + stage.failedCalls,
      billableCalls: existing.billableCalls + stage.billableCalls,
      exactCacheHits: existing.exactCacheHits + stage.exactCacheHits,
      cacheReadTokens: existing.cacheReadTokens + stage.cacheReadTokens,
      cacheWriteTokens: existing.cacheWriteTokens + stage.cacheWriteTokens,
    });
  }

  const byPurpose: LLMRunLedger["byPurpose"] = {};
  for (const source of [previous.byPurpose, next.byPurpose]) {
    for (const [purpose, summary] of Object.entries(source) as [
      keyof LLMRunLedger["byPurpose"],
      NonNullable<LLMRunLedger["byPurpose"][keyof LLMRunLedger["byPurpose"]]>,
    ][]) {
      const existing = byPurpose[purpose];
      byPurpose[purpose] = existing
        ? {
            attempted: existing.attempted + summary.attempted,
            successful: existing.successful + summary.successful,
            failed: existing.failed + summary.failed,
            billable: existing.billable + summary.billable,
            exactCacheHits: existing.exactCacheHits + summary.exactCacheHits,
            inputTokens: existing.inputTokens + summary.inputTokens,
            outputTokens: existing.outputTokens + summary.outputTokens,
            reasoningTokens: existing.reasoningTokens + summary.reasoningTokens,
            cacheReadTokens: existing.cacheReadTokens + summary.cacheReadTokens,
            cacheWriteTokens:
              existing.cacheWriteTokens + summary.cacheWriteTokens,
            estimatedCostUsd:
              existing.estimatedCostUsd + summary.estimatedCostUsd,
          }
        : { ...summary };
    }
  }

  return {
    totalEstimatedCostUsd:
      previous.totalEstimatedCostUsd + next.totalEstimatedCostUsd,
    totalCalls: previous.totalCalls + next.totalCalls,
    totalAttemptedCalls:
      previous.totalAttemptedCalls + next.totalAttemptedCalls,
    totalSuccessfulCalls:
      previous.totalSuccessfulCalls + next.totalSuccessfulCalls,
    totalFailedCalls: previous.totalFailedCalls + next.totalFailedCalls,
    totalBillableCalls: previous.totalBillableCalls + next.totalBillableCalls,
    totalExactCacheHits:
      previous.totalExactCacheHits + next.totalExactCacheHits,
    totalCacheReadTokens:
      previous.totalCacheReadTokens + next.totalCacheReadTokens,
    totalCacheWriteTokens:
      previous.totalCacheWriteTokens + next.totalCacheWriteTokens,
    byStage: [...byStage.values()].sort((a, b) =>
      a.stage.localeCompare(b.stage),
    ),
    byPurpose,
    generatedAt: next.generatedAt,
  };
}

function emptyStageSummary(stage: string): RunCostStageSummary {
  return {
    stage,
    estimatedCostUsd: 0,
    calls: 0,
    attemptedCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    billableCalls: 0,
    exactCacheHits: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}
