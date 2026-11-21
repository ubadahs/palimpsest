import { randomUUID } from "node:crypto";
import {
  createTraceSession,
  readTraceEvents,
  inspectTrace,
  TracePersistenceError,
  type TraceSession,
} from "../telemetry/trace.js";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  createLLMTelemetryCollector,
  buildLedger,
  llmCallRecordSchema,
} from "../integrations/llm-client.js";
import type {
  LLMRunLedger,
  LLMCallRecord,
  LLMTelemetryCollector,
} from "../integrations/llm-client.js";

export type RunCostTracker = {
  trace: TraceSession;
  collector: LLMTelemetryCollector;
  /** Known subtotal, or the caller's conservative charge if any usage is unknown. */
  spentUsd: (whenUnknown?: number) => number;
  write: (ledger: LLMRunLedger) => {
    run: RunCostSummary;
    attempt: RunCostSummary;
  };
};

/** The journal is authoritative; cost-summary.json is a replaceable projection. */
export function createRunCostTracker(runRoot: string): RunCostTracker {
  const path = resolve(runRoot, "cost-summary.json");
  const trace = createTraceSession(runRoot, { runId: basename(runRoot) });
  const saved = readPersistedCalls(runRoot);
  if (existsSync(path) && !existsSync(resolve(runRoot, "traces", "sessions"))) {
    throw new Error(
      "This run has summary-only telemetry. Start a new run; its historical cost summary is left untouched.",
    );
  }
  const calls = new Map(saved.map((c) => [c.callId!, c]));
  const telemetry = createLLMTelemetryCollector();
  function write(ledger: LLMRunLedger) {
    for (const call of ledger.calls) {
      call.callId ??= randomUUID();
      trace.recordCall(call.callId, call);
      calls.set(call.callId, call);
    }
    const run = summarizeLedgerByStage(buildLedger([...calls.values()]));
    const attempt = summarizeLedgerByStage(ledger);
    const temporary = `${path}.${trace.sessionId}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, {
      flush: true,
    });
    renameSync(temporary, path);
    return { run, attempt };
  }
  return {
    trace,
    collector: {
      trace,
      recordCall(record) {
        record.callId ??= randomUUID();
        trace.recordCall(record.callId, record);
        telemetry.recordCall(record);
        calls.set(record.callId, record);
        // The durable record already exists. A summary failure stops the run
        // rather than allowing unmetered spend; rebuilding reads the journal.
        try {
          write(telemetry.getLedger());
        } catch (cause) {
          throw new TracePersistenceError(
            "Cannot update the run cost projection",
            { cause },
          );
        }
      },
      getLedger: telemetry.getLedger,
    },
    spentUsd(whenUnknown) {
      let total = 0;
      for (const call of calls.values()) {
        if (whenUnknown !== undefined && call.billingStatus === "unknown")
          return whenUnknown;
        total += call.estimatedCostUsd;
      }
      return total;
    },
    write,
  };
}

export function readPersistedCalls(runRoot: string): LLMCallRecord[] {
  const calls = new Map<string, LLMCallRecord>();
  for (const event of readTraceEvents(runRoot).events) {
    if (event.kind !== "llm" || event.name !== "usage") continue;
    const call = llmCallRecordSchema.parse(event.data);
    if (!call.callId)
      throw new Error("Persisted model call is missing its call id");
    calls.set(call.callId, call);
  }
  return [...calls.values()];
}

export function rebuildRunCostSummary(runRoot: string): RunCostSummary {
  const audit = inspectTrace(runRoot);
  const summary = summarizeLedgerByStage(
    buildLedger(readPersistedCalls(runRoot)),
  );
  return {
    ...summary,
    incompleteOperations: audit.incomplete.length,
    incompleteJournals: audit.incompleteJournals.length,
    unresolvedModelAttempts: audit.unresolvedModelAttempts,
    unpricedExternalCalls: audit.unpricedExternalCalls,
  };
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
  unknownCostCalls: number;
  incompleteOperations?: number;
  incompleteJournals?: number;
  unresolvedModelAttempts?: number;
  unpricedExternalCalls?: number;
  byModel: Record<
    string,
    {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      unknownCostCalls: number;
    }
  >;
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
    existing.cacheReadTokens += call.sharedResponse
      ? 0
      : (call.cacheReadTokens ?? 0);
    existing.cacheWriteTokens += call.sharedResponse
      ? 0
      : (call.cacheWriteTokens ?? 0);
    stageMap.set(stage, existing);
  }

  const byModel: RunCostSummary["byModel"] = {};
  for (const call of ledger.calls) {
    const model = call.servedModel ?? call.model;
    const row = (byModel[model] ??= {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      unknownCostCalls: 0,
    });
    row.calls++;
    row.inputTokens += call.sharedResponse ? 0 : call.inputTokens;
    row.outputTokens += call.sharedResponse ? 0 : call.outputTokens;
    row.estimatedCostUsd += call.estimatedCostUsd;
    if (call.billingStatus === "unknown") row.unknownCostCalls++;
  }
  return {
    unknownCostCalls: ledger.calls.filter((c) => c.billingStatus === "unknown")
      .length,
    byModel,
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
