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
    discoverStrategy: "legacy",
    discoverTopN: 5,
    discoverRank: true,
    discoverModel: "claude-opus-4-6",
    discoverProbeBudget: 20,
    discoverShortlistCap: 10,
    screenGroundingModel: "claude-opus-4-6",
    screenFilterModel: "claude-haiku-4-5",
    screenFilterConcurrency: 10,
    evidenceLlmRerank: true,
    evidenceRerankModel: "claude-haiku-4-5",
    evidenceRerankTopN: 5,
    curateTargetSize: 40,
    adjudicateModel: "claude-opus-4-6",
    adjudicateThinking: true,
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
      expect.stringContaining("runs/run-1"),
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
      expect.stringContaining("runs/run-1"),
    ]);
  });

  it("emits no extra screen flags when all screen params are default", () => {
    const command = buildStageCommand(run, stagesWithDiscover, "screen");
    expect(command.args).not.toContain("--llm-grounding-model");
    expect(command.args).not.toContain("--filter-model");
    expect(command.args).not.toContain("--filter-concurrency");
  });

  it("emits --filter-model when screenFilterModel is non-default", () => {
    const customRun: AnalysisRun = {
      ...run,
      config: { ...run.config, screenFilterModel: "claude-sonnet-4-6" },
    };
    const command = buildStageCommand(customRun, stagesWithDiscover, "screen");
    expect(command.args).toContain("--filter-model");
    expect(command.args).toContain("claude-sonnet-4-6");
  });

  it("emits --filter-concurrency when screenFilterConcurrency is non-default", () => {
    const customRun: AnalysisRun = {
      ...run,
      config: { ...run.config, screenFilterConcurrency: 5 },
    };
    const command = buildStageCommand(customRun, stagesWithDiscover, "screen");
    expect(command.args).toContain("--filter-concurrency");
    expect(command.args).toContain("5");
  });

  it("emits no extra evidence flags when all evidence params are default", () => {
    const command = buildStageCommand(run, stagesWithDiscover, "evidence");
    expect(command.args).not.toContain("--rerank-model");
    expect(command.args).not.toContain("--rerank-top-n");
  });

  it("emits --rerank-top-n when evidenceRerankTopN is non-default", () => {
    const customRun: AnalysisRun = {
      ...run,
      config: { ...run.config, evidenceRerankTopN: 3 },
    };
    const command = buildStageCommand(customRun, stagesWithDiscover, "evidence");
    expect(command.args).toContain("--rerank-top-n");
    expect(command.args).toContain("3");
  });

  it("emits --rerank-model when evidenceRerankModel is non-default", () => {
    const customRun: AnalysisRun = {
      ...run,
      config: { ...run.config, evidenceRerankModel: "claude-sonnet-4-6" },
    };
    const command = buildStageCommand(customRun, stagesWithDiscover, "evidence");
    expect(command.args).toContain("--rerank-model");
    expect(command.args).toContain("claude-sonnet-4-6");
  });
});
