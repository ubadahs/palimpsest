import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRunCostTracker,
  rebuildRunCostSummary,
  readPersistedCalls,
  summarizeLedgerByStage,
} from "../../src/pipeline/cost-summary.js";
import type { LLMRunLedger } from "../../src/integrations/llm-client.js";
import {
  budgetAfterOtherHistories,
  remainingBudget,
} from "../../src/history/budget.js";

type Call = LLMRunLedger["calls"][number];

function call(overrides: Partial<Call>): Call {
  return {
    purpose: "seed-grounding",
    model: "claude-sonnet-5-5",
    attempted: true,
    successful: true,
    failed: false,
    billable: true,
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
  it("counts batch-priced calls per stage and keeps the count across resumes", () => {
    const first = summarizeLedgerByStage(
      ledgerOf([
        call({ stageKey: "adjudicate", transport: "batch" }),
        call({ stageKey: "adjudicate", transport: "direct" }),
        call({ stageKey: "scope" }),
      ]),
    );
    const byStage = Object.fromEntries(
      first.byStage.map((stage) => [stage.stage, stage.batchCalls]),
    );
    expect(byStage).toEqual({ adjudicate: 1, scope: undefined });
  });

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
});

describe("run cost tracker", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("charges previous history attempts once when a pipeline resumes or replaces its Report", () => {
    const root = mkdtempSync(join(tmpdir(), "history-budget-"));
    roots.push(root);
    const oldReport = "artifact_" + "a".repeat(64);
    const current = "artifact_" + "b".repeat(64);
    const record = (owner: string, usd: number) =>
      createRunCostTracker(owner).collector.recordCall(
        call({ estimatedCostUsd: usd }),
      );
    record(root, 1);
    record(join(root, "history", oldReport), 0.75);
    record(join(root, "history", current), 0.5);
    // Before running stages both history owners count. At handoff, the current
    // history enforces its own cumulative cap and subtracts its $0.50 itself.
    expect(budgetAfterOtherHistories(root, 3)).toBe(1.75);
    const remaining = remainingBudget(3, rebuildRunCostSummary(root));
    expect(budgetAfterOtherHistories(root, remaining, current)).toBe(1.25);
    createRunCostTracker(join(root, "history", oldReport)).collector.recordCall(
      call({ billingStatus: "unknown", estimatedCostUsd: 0 }),
    );
    expect(budgetAfterOtherHistories(root, remaining, current)).toBe(0);
  });

  function runRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "palimpsest-cost-"));
    roots.push(root);
    return root;
  }

  function onDisk(root: string) {
    return JSON.parse(
      readFileSync(join(root, "cost-summary.json"), "utf8"),
    ) as ReturnType<typeof summarizeLedgerByStage>;
  }

  it("rewrites the summary after every model call, not only at the end", () => {
    const root = runRoot();
    const tracker = createRunCostTracker(root);

    tracker.collector.recordCall(
      call({ stageKey: "discover", estimatedCostUsd: 0.25 }),
    );
    expect(onDisk(root).totalEstimatedCostUsd).toBeCloseTo(0.25);

    tracker.collector.recordCall(
      call({ stageKey: "adjudicate", estimatedCostUsd: 0.5 }),
    );
    expect(onDisk(root).totalEstimatedCostUsd).toBeCloseTo(0.75);
    expect(onDisk(root).byStage.map((s) => s.stage)).toEqual([
      "adjudicate",
      "discover",
    ]);
    expect(tracker.spentUsd()).toBeCloseTo(0.75);
  });

  it("counts an earlier attempt once however often a resume writes", () => {
    const root = runRoot();
    const first = createRunCostTracker(root);
    first.collector.recordCall(
      call({ stageKey: "discover", estimatedCostUsd: 1 }),
    );
    // The journal, not this stale projection, supplies the resume baseline.
    writeFileSync(join(root, "cost-summary.json"), "{}");

    const resume = createRunCostTracker(root);
    for (let index = 0; index < 3; index++) {
      resume.collector.recordCall(
        call({ stageKey: "adjudicate", estimatedCostUsd: 0.1 }),
      );
    }
    const { run, attempt } = resume.write(resume.collector.getLedger());

    expect(run.totalEstimatedCostUsd).toBeCloseTo(1.3);
    expect(attempt.totalEstimatedCostUsd).toBeCloseTo(0.3);
    expect(onDisk(root).totalEstimatedCostUsd).toBeCloseTo(1.3);
    expect(onDisk(root).totalCalls).toBe(4);
    expect(resume.spentUsd()).toBeCloseTo(1.3);
  });
  it("recovers costs after a missing summary and flags unknown usage", () => {
    const root = runRoot();
    const tracker = createRunCostTracker(root);
    tracker.collector.recordCall(
      call({
        billingStatus: "unknown",
        usageStatus: "missing",
        estimatedCostUsd: 0,
      }),
    );
    rmSync(join(root, "cost-summary.json"));
    const rebuilt = rebuildRunCostSummary(root);
    expect(rebuilt).toMatchObject({
      totalCalls: 1,
      totalEstimatedCostUsd: 0,
      unknownCostCalls: 1,
    });
    expect(readPersistedCalls(root)).toHaveLength(1);
    expect(createRunCostTracker(root).spentUsd()).toBe(0);
    expect(tracker.spentUsd(2)).toBe(2);
    expect(createRunCostTracker(root).spentUsd(2)).toBe(2);
  });

  it("does not silently mix summary-only historical costs with audited calls", () => {
    const root = runRoot();
    writeFileSync(join(root, "cost-summary.json"), "{}");
    expect(() => createRunCostTracker(root)).toThrow("summary-only telemetry");
    expect(readFileSync(join(root, "cost-summary.json"), "utf8")).toBe("{}");
  });
});
