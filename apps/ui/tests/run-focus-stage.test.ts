import { describe, expect, it } from "vitest";
import type { AnalysisRunStage } from "citation-fidelity/ui-contract";

import { resolveFocusStage } from "../lib/run-focus-stage";

function stage(
  key: AnalysisRunStage["stageKey"],
  order: number,
  status: AnalysisRunStage["status"],
): AnalysisRunStage {
  return {
    runId: "r1",
    stageKey: key,
    stageOrder: order,
    status,
    inputArtifactPath: undefined,
    primaryArtifactPath: undefined,
    reportArtifactPath: undefined,
    manifestPath: undefined,
    logPath: undefined,
    summary: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    exitCode: undefined,
    processId: undefined,
  };
}

describe("resolveFocusStage", () => {
  it("prefers the running stage", () => {
    const stages = [
      stage("pre-screen", 1, "succeeded"),
      stage("m2-extract", 2, "running"),
      stage("m3-classify", 3, "not_started"),
    ];
    expect(resolveFocusStage(stages)?.stageKey).toBe("m2-extract");
  });

  it("uses the earliest terminal failure in pipeline order", () => {
    const stages = [
      stage("pre-screen", 1, "succeeded"),
      stage("m2-extract", 2, "failed"),
      stage("m3-classify", 3, "not_started"),
    ];
    expect(resolveFocusStage(stages)?.stageKey).toBe("m2-extract");
  });

  it("uses the last succeeded stage when idle", () => {
    const stages = [
      stage("pre-screen", 1, "succeeded"),
      stage("m2-extract", 2, "succeeded"),
      stage("m3-classify", 3, "not_started"),
    ];
    expect(resolveFocusStage(stages)?.stageKey).toBe("m2-extract");
  });

  it("falls back to the first stage when nothing has started", () => {
    const stages = [
      stage("pre-screen", 1, "not_started"),
      stage("m2-extract", 2, "not_started"),
    ];
    expect(resolveFocusStage(stages)?.stageKey).toBe("pre-screen");
  });
});
