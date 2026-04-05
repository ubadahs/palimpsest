import {
  getStageDefinition,
  getPreviousStageKey,
  stageDefinitions,
  type AnalysisRun,
  type AnalysisRunStage,
  type StageKey,
} from "citation-fidelity/ui-contract";

import { getShortlistPath, getStageDirectory } from "./run-files";

export type StageCommandSpec = {
  command: string;
  args: string[];
  outputDirectory: string;
  inputArtifactPath?: string;
};

function getStageArtifactPath(
  stages: AnalysisRunStage[],
  stageKey: StageKey,
): string {
  const stage = stages.find((entry) => entry.stageKey === stageKey);
  if (!stage?.primaryArtifactPath) {
    throw new Error(`Missing primary artifact for ${stageKey}.`);
  }

  return stage.primaryArtifactPath;
}

export function buildStageCommand(
  run: AnalysisRun,
  stages: AnalysisRunStage[],
  stageKey: StageKey,
): StageCommandSpec {
  const config = run.config;
  const outputDirectory = getStageDirectory(run.id, stageKey);

  if (stageKey === "pre-screen") {
    return {
      command: getStageDefinition(stageKey).command,
      args: ["pre-screen", "--input", getShortlistPath(run.id), "--output", outputDirectory],
      outputDirectory,
      inputArtifactPath: getShortlistPath(run.id),
    };
  }

  if (stageKey === "m2-extract") {
    return {
      command: "m2-extract",
      args: [
        "m2-extract",
        "--pre-screen",
        getStageArtifactPath(stages, "pre-screen"),
        "--seed-doi",
        run.seedDoi,
        "--output",
        outputDirectory,
        ...(config.forceRefresh ? ["--force-refresh"] : []),
      ],
      outputDirectory,
      inputArtifactPath: getStageArtifactPath(stages, "pre-screen"),
    };
  }

  if (stageKey === "m3-classify") {
    return {
      command: "m3-classify",
      args: [
        "m3-classify",
        "--extraction",
        getStageArtifactPath(stages, "m2-extract"),
        "--pre-screen",
        getStageArtifactPath(stages, "pre-screen"),
        "--output",
        outputDirectory,
      ],
      outputDirectory,
      inputArtifactPath: getStageArtifactPath(stages, "m2-extract"),
    };
  }

  if (stageKey === "m4-evidence") {
    return {
      command: "m4-evidence",
      args: [
        "m4-evidence",
        "--classification",
        getStageArtifactPath(stages, "m3-classify"),
        "--output",
        outputDirectory,
        ...(config.forceRefresh ? ["--force-refresh"] : []),
      ],
      outputDirectory,
      inputArtifactPath: getStageArtifactPath(stages, "m3-classify"),
    };
  }

  if (stageKey === "m5-adjudicate") {
    return {
      command: "m5-adjudicate",
      args: [
        "m5-adjudicate",
        "--evidence",
        getStageArtifactPath(stages, "m4-evidence"),
        "--target-size",
        String(config.m5TargetSize),
        "--output",
        outputDirectory,
      ],
      outputDirectory,
      inputArtifactPath: getStageArtifactPath(stages, "m4-evidence"),
    };
  }

  return {
    command: "m6-llm-judge",
    args: [
      "m6-llm-judge",
      "--calibration",
      getStageArtifactPath(stages, "m5-adjudicate"),
      "--model",
      config.m6Model,
      ...(config.m6Thinking ? ["--thinking"] : []),
      "--output",
      outputDirectory,
    ],
    outputDirectory,
    inputArtifactPath: getStageArtifactPath(stages, "m5-adjudicate"),
  };
}

export function resolveStartStage(
  run: AnalysisRun,
  stages: AnalysisRunStage[],
): StageKey {
  const targetOrder = getStageDefinition(run.targetStage).order;
  const candidate = stageDefinitions.find((stage) => {
    if (stage.order > targetOrder) {
      return false;
    }

    const current = stages.find((entry) => entry.stageKey === stage.key);
    return current?.status !== "succeeded";
  });

  return candidate?.key ?? run.targetStage;
}

export function canRerunStage(
  stages: AnalysisRunStage[],
  stageKey: StageKey,
): boolean {
  const previousKey = getPreviousStageKey(stageKey);
  if (!previousKey) {
    return true;
  }

  const previous = stages.find((stage) => stage.stageKey === previousKey);
  return previous?.status === "succeeded";
}
