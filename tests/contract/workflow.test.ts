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
      `${progressLogPrefix}{"stage":"extract","step":"fetch_and_parse_full_text","status":"running","current":2,"total":6}`,
    );

    expect(event).toMatchObject({
      stage: "extract",
      step: "fetch_and_parse_full_text",
      status: "running",
      current: 2,
      total: 6,
    });
  });

  it("ignores malformed telemetry lines safely", () => {
    expect(
      parseProgressEventLine(
        `${progressLogPrefix}{"stage":"extract","step":true}`,
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
        `${progressLogPrefix}{"stage":"adjudicate","step":"load_active_records","status":"completed","detail":"31 active records ready"}`,
        `${progressLogPrefix}{"stage":"adjudicate","step":"adjudicate_records","status":"running","detail":"Adjudicating record 6 of 31","current":6,"total":31}`,
      ].join("\n"),
    });

    expect(snapshot.source).toBe("telemetry");
    expect(snapshot.counts).toEqual({
      current: 6,
      total: 31,
      label: "records",
    });
    expect(snapshot.steps[0]?.status).toBe("completed");
    expect(snapshot.steps[1]?.status).toBe("running");
    expect(snapshot.steps[1]?.detail).toContain("6 of 31");
  });

  it("marks a step failed when telemetry reports failure", () => {
    const snapshot = buildStageWorkflowSnapshot({
      stageKey: "evidence",
      stageStatus: "failed",
      errorMessage: "Command exited with code 1.",
      logContent: [
        `${progressLogPrefix}{"stage":"evidence","step":"resolve_cited_paper","status":"completed","detail":"Resolved cited paper"}`,
        `${progressLogPrefix}{"stage":"evidence","step":"fetch_and_parse_cited_full_text","status":"failed","detail":"Parsing failed"}`,
      ].join("\n"),
    });

    expect(snapshot.source).toBe("telemetry");
    expect(
      snapshot.steps.find(
        (step) => step.id === "fetch_and_parse_cited_full_text",
      )?.status,
    ).toBe("failed");
    expect(snapshot.summary).toBe("Parsing failed");
  });

  it("summarizes multiline discover failures using the specific reason", () => {
    const snapshot = buildStageWorkflowSnapshot({
      stageKey: "discover",
      stageStatus: "failed",
      errorMessage: "Command exited with code 1.",
      logContent: [
        `${progressLogPrefix}{"stage":"discover","step":"emit_shortlist","status":"failed","detail":"No seeds produced.\\n  10.1234/seed: Full text unavailable: GROBID HTTP 500 from http://localhost:8070"}`,
      ].join("\n"),
    });

    expect(snapshot.summary).toBe(
      "10.1234/seed: Full text unavailable: GROBID HTTP 500 from http://localhost:8070",
    );
  });
});

describe("buildFallbackStageWorkflowSnapshot", () => {
  it("infers honest fallback states for old runs without telemetry", () => {
    const pending = buildFallbackStageWorkflowSnapshot({
      stageKey: "screen",
      stageStatus: "not_started",
    });
    const running = buildFallbackStageWorkflowSnapshot({
      stageKey: "screen",
      stageStatus: "running",
    });
    const succeeded = buildFallbackStageWorkflowSnapshot({
      stageKey: "screen",
      stageStatus: "succeeded",
    });
    const failed = buildFallbackStageWorkflowSnapshot({
      stageKey: "screen",
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
