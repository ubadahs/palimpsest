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

  if (stageKey === "screen") {
    return {
      command: getStageDefinition(stageKey).command,
      args: [
        "screen",
        "--input",
        getShortlistPath(run.id),
        "--output",
        outputDirectory,
      ],
      outputDirectory,
      inputArtifactPath: getShortlistPath(run.id),
    };
  }

  if (stageKey === "extract") {
    return {
      command: "extract",
      args: [
        "extract",
        "--pre-screen",
        getStageArtifactPath(stages, "screen"),
        "--seed-doi",
        run.seedDoi,
        "--output",
        outputDirectory,
        ...(config.forceRefresh ? ["--force-refresh"] : []),
      ],
      outputDirectory,
      inputArtifactPath: getStageArtifactPath(stages, "screen"),
    };
  }

  if (stageKey === "classify") {
    return {
      command: "classify",
      args: [
        "classify",
        "--extraction",
        getStageArtifactPath(stages, "extract"),
        "--pre-screen",
        getStageArtifactPath(stages, "screen"),
        "--output",
        outputDirectory,
      ],
      outputDirectory,
      inputArtifactPath: getStageArtifactPath(stages, "extract"),
    };
  }

  if (stageKey === "evidence") {
    return {
      command: "evidence",
      args: [
        "evidence",
        "--classification",
        getStageArtifactPath(stages, "classify"),
        "--output",
        outputDirectory,
        ...(config.forceRefresh ? ["--force-refresh"] : []),
        ...(config.evidenceLlmRerank === false ? ["--no-llm-rerank"] : []),
      ],
      outputDirectory,
      inputArtifactPath: getStageArtifactPath(stages, "classify"),
    };
  }

  if (stageKey === "curate") {
    return {
      command: "curate",
      args: [
        "curate",
        "--evidence",
        getStageArtifactPath(stages, "evidence"),
        "--target-size",
        String(config.curateTargetSize),
        "--output",
        outputDirectory,
      ],
      outputDirectory,
      inputArtifactPath: getStageArtifactPath(stages, "evidence"),
    };
  }

  return {
    command: "adjudicate",
    args: [
      "adjudicate",
      "--calibration",
      getStageArtifactPath(stages, "curate"),
      "--model",
      config.adjudicateModel,
      ...(config.adjudicateThinking ? ["--thinking"] : []),
      "--output",
      outputDirectory,
    ],
    outputDirectory,
    inputArtifactPath: getStageArtifactPath(stages, "curate"),
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
