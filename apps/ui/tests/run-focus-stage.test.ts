import { describe, expect, it } from "vitest";
import {
  computeAggregateStageStatus,
  type AnalysisRunStage,
  type LogicalStageGroup,
} from "palimpsest/ui-contract";

import { resolveFocusStage } from "../lib/run-focus-stage";

function stage(
  key: AnalysisRunStage["stageKey"],
  order: number,
  status: AnalysisRunStage["status"],
  familyIndex = 0,
): AnalysisRunStage {
  return {
    runId: "r1",
    stageKey: key,
    stageOrder: order,
    familyIndex,
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

function groupOf(members: AnalysisRunStage[]): LogicalStageGroup {
  const first = members[0]!;
  return {
    stageKey: first.stageKey,
    stageOrder: first.stageOrder,
    aggregateStatus: computeAggregateStageStatus(members),
    members,
  };
}

describe("resolveFocusStage", () => {
  it("prefers the running stage", () => {
    const stages: LogicalStageGroup[] = [
      groupOf([stage("screen", 1, "succeeded")]),
      groupOf([stage("extract", 2, "running")]),
      groupOf([stage("classify", 3, "not_started")]),
    ];
    expect(resolveFocusStage(stages)?.stageKey).toBe("extract");
  });

  it("uses the earliest terminal failure in pipeline order", () => {
    const stages: LogicalStageGroup[] = [
      groupOf([stage("screen", 1, "succeeded")]),
      groupOf([stage("extract", 2, "failed")]),
      groupOf([stage("classify", 3, "not_started")]),
    ];
    expect(resolveFocusStage(stages)?.stageKey).toBe("extract");
  });

  it("uses the last succeeded stage when idle", () => {
    const stages: LogicalStageGroup[] = [
      groupOf([stage("screen", 1, "succeeded")]),
      groupOf([stage("extract", 2, "succeeded")]),
      groupOf([stage("classify", 3, "not_started")]),
    ];
    expect(resolveFocusStage(stages)?.stageKey).toBe("extract");
  });

  it("falls back to the first stage when nothing has started", () => {
    const stages: LogicalStageGroup[] = [
      groupOf([stage("screen", 1, "not_started")]),
      groupOf([stage("extract", 2, "not_started")]),
    ];
    expect(resolveFocusStage(stages)?.stageKey).toBe("screen");
  });
});
