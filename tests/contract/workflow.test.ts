import { describe, expect, it } from "vitest";

import {
  buildFallbackStageWorkflowSnapshot,
  buildStageWorkflowSnapshot,
  getStageWorkflowDefinition,
  parseProgressEventLine,
  progressLogPrefix,
} from "../../src/contract/workflow.js";
import { stageKeyValues } from "../../src/contract/stages.js";

describe("stage workflow definitions", () => {
  it("defines ordered, non-empty workflows for every stage", () => {
    for (const stageKey of stageKeyValues) {
      const definition = getStageWorkflowDefinition(stageKey);
      expect(definition.steps.length).toBeGreaterThan(0);
      expect(new Set(definition.steps.map((step) => step.id)).size).toBe(
        definition.steps.length,
      );
      expect(definition.pendingSummary.length).toBeGreaterThan(0);
      expect(definition.completedSummary.length).toBeGreaterThan(0);
    }
  });
});

describe("parseProgressEventLine", () => {
  it("parses valid telemetry lines", () => {
    const event = parseProgressEventLine(
      `${progressLogPrefix}{"stage":"prepare","step":"build_records","status":"running","current":2,"total":6}`,
    );

    expect(event).toMatchObject({
      stage: "prepare",
      step: "build_records",
      status: "running",
      current: 2,
      total: 6,
    });
  });

  it("ignores malformed telemetry lines safely", () => {
    expect(
      parseProgressEventLine(
        `${progressLogPrefix}{"stage":"prepare","step":true}`,
      ),
    ).toBeUndefined();
    expect(parseProgressEventLine("plain log line")).toBeUndefined();
  });
});

describe("buildStageWorkflowSnapshot", () => {
  it("builds a telemetry-backed running snapshot with counters", () => {
    const snapshot = buildStageWorkflowSnapshot({
      stageKey: "adjudicate",
      stageStatus: "running",
      logContent: [
        `${progressLogPrefix}{"stage":"adjudicate","step":"apply_gates","status":"completed","detail":"31 records gated or eligible"}`,
        `${progressLogPrefix}{"stage":"adjudicate","step":"adjudicate_eligible","status":"running","detail":"Adjudicating record 6 of 31","current":6,"total":31}`,
      ].join("\n"),
    });

    expect(snapshot.source).toBe("telemetry");
    expect(snapshot.counts).toEqual({
      current: 6,
      total: 31,
      label: "records",
    });
    expect(snapshot.steps[0]?.status).toBe("completed");
    expect(snapshot.steps[2]?.status).toBe("running");
    expect(snapshot.steps[2]?.detail).toContain("6 of 31");
  });

  it("marks a step failed when telemetry reports failure", () => {
    const snapshot = buildStageWorkflowSnapshot({
      stageKey: "evidence",
      stageStatus: "failed",
      errorMessage: "Command exited with code 1.",
      logContent: [
        `${progressLogPrefix}{"stage":"evidence","step":"verify_lineage","status":"completed","detail":"Verified ancestors"}`,
        `${progressLogPrefix}{"stage":"evidence","step":"chunk_seed_text","status":"failed","detail":"Seed text parsing failed"}`,
      ].join("\n"),
    });

    expect(snapshot.source).toBe("telemetry");
    expect(
      snapshot.steps.find((step) => step.id === "chunk_seed_text")?.status,
    ).toBe("failed");
    expect(snapshot.summary).toBe(
      "Evidence retrieval stopped before outcomes were finalized.",
    );
  });

  it("summarizes multiline discover failures using the specific reason", () => {
    const snapshot = buildStageWorkflowSnapshot({
      stageKey: "discover",
      stageStatus: "failed",
      errorMessage: "Command exited with code 1.",
      logContent: [
        `${progressLogPrefix}{"stage":"discover","step":"select_candidates","status":"failed","detail":"No candidates selected.\\n  10.1234/seed: citation-index response was incomplete"}`,
      ].join("\n"),
    });

    expect(snapshot.summary).toBe(
      "Discover stopped before its ledger was finalized.",
    );
  });
});

describe("buildFallbackStageWorkflowSnapshot", () => {
  it("infers honest fallback states without telemetry", () => {
    const pending = buildFallbackStageWorkflowSnapshot({
      stageKey: "scope",
      stageStatus: "not_started",
    });
    const running = buildFallbackStageWorkflowSnapshot({
      stageKey: "scope",
      stageStatus: "running",
    });
    const succeeded = buildFallbackStageWorkflowSnapshot({
      stageKey: "scope",
      stageStatus: "succeeded",
    });
    const failed = buildFallbackStageWorkflowSnapshot({
      stageKey: "scope",
      stageStatus: "interrupted",
      errorMessage: "Interrupted during startup reconciliation.",
    });

    expect(pending.source).toBe("fallback");
    expect(pending.steps.every((step) => step.status === "pending")).toBe(true);
    expect(running.steps.some((step) => step.status === "running")).toBe(true);
    expect(succeeded.steps.every((step) => step.status === "completed")).toBe(
      true,
    );
    expect(failed.steps[0]?.status).toBe("failed");
    expect(failed.steps[0]?.detail).toContain("Interrupted");
  });
});
