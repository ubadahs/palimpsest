import { describe, expect, it } from "vitest";
import type { AnalysisRun, AnalysisRunStage } from "palimpsest/ui-contract";

import { buildStageCommand } from "../lib/run-command-builder";

const run: AnalysisRun = {
  id: "run-1",
  seedDoi: "10.1234/seed",
  trackedClaim: "Tracked claim",
  targetStage: "adjudicate",
  status: "queued",
  currentStage: undefined,
  runRoot: "/tmp/runs/run-1",
  config: {
    stopAfterStage: "adjudicate",
    forceRefresh: true,
    curateTargetSize: 40,
    adjudicateModel: "claude-opus-4-6",
    adjudicateThinking: true,
    discoverStrategy: "legacy",
    discoverTopN: 5,
    discoverRank: true,
    discoverModel: "claude-opus-4-6",
    discoverProbeBudget: 20,
    discoverShortlistCap: 10,
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const discoverStage: AnalysisRunStage = {
  runId: run.id,
  stageKey: "discover",
  stageOrder: 0,
  status: "succeeded",
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

const stages: AnalysisRunStage[] = [
  {
    runId: run.id,
    stageKey: "screen",
    stageOrder: 1,
    status: "succeeded",
    inputArtifactPath: undefined,
    primaryArtifactPath:
      "/tmp/runs/run-1/01-screen/2026-04-04_001_pre-screen-results.json",
    reportArtifactPath: undefined,
    manifestPath: undefined,
    logPath: undefined,
    summary: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    exitCode: undefined,
    processId: undefined,
  },
  {
    runId: run.id,
    stageKey: "extract",
    stageOrder: 2,
    status: "succeeded",
    inputArtifactPath: undefined,
    primaryArtifactPath:
      "/tmp/runs/run-1/02-extract/2026-04-04_001_m2-extraction-results.json",
    reportArtifactPath: undefined,
    manifestPath: undefined,
    logPath: undefined,
    summary: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    exitCode: undefined,
    processId: undefined,
  },
  {
    runId: run.id,
    stageKey: "classify",
    stageOrder: 3,
    status: "succeeded",
    inputArtifactPath: undefined,
    primaryArtifactPath:
      "/tmp/runs/run-1/03-classify/2026-04-04_001_classification-results.json",
    reportArtifactPath: undefined,
    manifestPath: undefined,
    logPath: undefined,
    summary: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    exitCode: undefined,
    processId: undefined,
  },
  {
    runId: run.id,
    stageKey: "evidence",
    stageOrder: 4,
    status: "succeeded",
    inputArtifactPath: undefined,
    primaryArtifactPath:
      "/tmp/runs/run-1/04-evidence/2026-04-04_001_evidence-results.json",
    reportArtifactPath: undefined,
    manifestPath: undefined,
    logPath: undefined,
    summary: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    exitCode: undefined,
    processId: undefined,
  },
  {
    runId: run.id,
    stageKey: "curate",
    stageOrder: 5,
    status: "succeeded",
    inputArtifactPath: undefined,
    primaryArtifactPath:
      "/tmp/runs/run-1/05-curate/2026-04-04_001_calibration-set.json",
    reportArtifactPath: undefined,
    manifestPath: undefined,
    logPath: undefined,
    summary: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    exitCode: undefined,
    processId: undefined,
  },
  {
    runId: run.id,
    stageKey: "adjudicate",
    stageOrder: 6,
    status: "not_started",
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
  },
];

const stagesWithDiscover: AnalysisRunStage[] = [discoverStage, ...stages];

describe("buildStageCommand", () => {
  it("builds the discover command shape", () => {
    const autoRun: AnalysisRun = { ...run, trackedClaim: undefined };
    const command = buildStageCommand(autoRun, stagesWithDiscover, "discover");

    expect(command.args).toEqual([
      "discover",
      "--input",
      expect.stringContaining("inputs/dois.json"),
      "--output",
      expect.stringContaining("/00-discover"),
      "--strategy",
      "legacy",
      "--top",
      "5",
    ]);
  });

  it("includes --no-rank when discoverRank is false", () => {
    const noRankRun: AnalysisRun = {
      ...run,
      trackedClaim: undefined,
      config: { ...run.config, discoverRank: false },
    };
    const command = buildStageCommand(
      noRankRun,
      stagesWithDiscover,
      "discover",
    );
    expect(command.args).toContain("--no-rank");
  });

  it("builds the adjudicate command shape", () => {
    const command = buildStageCommand(run, stagesWithDiscover, "adjudicate");

    expect(command.args).toEqual([
      "adjudicate",
      "--calibration",
      "/tmp/runs/run-1/05-curate/2026-04-04_001_calibration-set.json",
      "--model",
      "claude-opus-4-6",
      "--thinking",
      "--output",
      expect.stringContaining("/06-adjudicate"),
    ]);
  });
});
