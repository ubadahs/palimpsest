import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createLLMTelemetryCollector } from "../integrations/llm-client.js";
import type {
  LLMRunLedger,
  LLMTelemetryCollector,
} from "../integrations/llm-client.js";

export type RunCostTracker = {
  /** Pass to the LLM client: each call it records rewrites the summary. */
  collector: LLMTelemetryCollector;
  /** Estimated spend so far, earlier attempts included. */
  spentUsd: () => number;
  /**
   * Writes the summary for `ledger` and returns it for the whole run and for
   * this attempt alone. Unlike the per-call write, a failure here throws.
   */
  write: (ledger: LLMRunLedger) => {
    run: RunCostSummary;
    attempt: RunCostSummary;
  };
};

/**
 * Keeps `cost-summary.json` current while a run is going, so spend can be
 * watched as it happens rather than read once at the end. A resume opens a
 * fresh client whose ledger covers only what it re-runs, so the earlier
 * attempts' summary is read once, here, and every write is that baseline plus
 * this attempt. Merging into the file on each write would count calls twice.
 */
export function createRunCostTracker(runRoot: string): RunCostTracker {
  const path = resolve(runRoot, "cost-summary.json");
  const baseline = readCostSummary(path);
  const telemetry = createLLMTelemetryCollector();
  let attemptUsd = 0;

  function write(ledger: LLMRunLedger) {
    const attempt = summarizeLedgerByStage(ledger);
    const run = baseline ? mergeCostSummaries(baseline, attempt) : attempt;
    // Written beside the file and renamed over it, so a reader polling the
    // summary never sees half a file.
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return { run, attempt };
  }

  return {
    collector: {
      recordCall(record) {
        telemetry.recordCall(record);
        attemptUsd += record.estimatedCostUsd;
        try {
          write(telemetry.getLedger());
        } catch {
          // The client records a call inside its own error handling, so a
          // throw here would be reported as the provider failing. The write
          // at the end of the stage still surfaces a real disk problem.
        }
      },
      getLedger: telemetry.getLedger,
    },
    spentUsd: () => (baseline?.totalEstimatedCostUsd ?? 0) + attemptUsd,
    write,
  };
}

function readCostSummary(path: string): RunCostSummary | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunCostSummary;
  } catch {
    // An unreadable summary from an earlier attempt must not fail the run;
    // this attempt's numbers are still worth writing.
    return undefined;
  }
}

type RunCostStageSummary = {
  stage: string;
  estimatedCostUsd: number;
  calls: number;
  attemptedCalls: number;
  successfulCalls: number;
  failedCalls: number;
  billableCalls: number;
  exactCacheHits: number;
  /**
   * Calls answered through the Message Batches API, billed at half price.
   * Optional because summaries written before `--batch` existed lack it.
   */
  batchCalls?: number;
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
    if (call.transport === "batch") {
      existing.batchCalls = (existing.batchCalls ?? 0) + 1;
    }
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
      ...(existing.batchCalls != null || stage.batchCalls != null
        ? { batchCalls: (existing.batchCalls ?? 0) + (stage.batchCalls ?? 0) }
        : {}),
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
