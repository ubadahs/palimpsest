import {
  getStageDefinition,
  getPreviousStageKey,
  stageDefinitions,
  type AnalysisRun,
  type AnalysisRunStage,
  type StageKey,
} from "palimpsest/ui-contract";

import {
  getDoisInputPath,
  getRunRoot,
  getShortlistPath,
  getStageDirectory,
} from "./run-files";

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
  const runRoot = getRunRoot(run.id);

  if (stageKey === "discover") {
    const isAttribution = config.discoverStrategy === "attribution_first";
    return {
      command: "discover",
      args: [
        "discover",
        "--input",
        getDoisInputPath(run.id),
        "--output",
        runRoot,
        "--strategy",
        config.discoverStrategy,
        ...(isAttribution
          ? [
              "--probe-budget",
              String(config.discoverProbeBudget),
              "--shortlist-cap",
              String(config.discoverShortlistCap),
            ]
          : [
              "--top",
              String(config.discoverTopN),
              ...(config.discoverRank === false ? ["--no-rank"] : []),
            ]),
        ...(config.discoverModel !== "claude-opus-4-6"
          ? ["--model", config.discoverModel]
          : []),
      ],
      outputDirectory,
      inputArtifactPath: getDoisInputPath(run.id),
    };
  }

  if (stageKey === "screen") {
    return {
      command: getStageDefinition(stageKey).command,
      args: [
        "screen",
        "--input",
        getShortlistPath(run.id),
        "--output",
        runRoot,
        ...(config.screenGroundingModel !== "claude-opus-4-6"
          ? ["--llm-grounding-model", config.screenGroundingModel]
          : []),
        ...(config.screenFilterModel !== "claude-haiku-4-5"
          ? ["--filter-model", config.screenFilterModel]
          : []),
        ...(config.screenFilterConcurrency !== 10
          ? ["--filter-concurrency", String(config.screenFilterConcurrency)]
          : []),
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
        runRoot,
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
        runRoot,
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
        runRoot,
        ...(config.forceRefresh ? ["--force-refresh"] : []),
        ...(config.evidenceLlmRerank === false ? ["--no-llm-rerank"] : []),
        ...(config.evidenceRerankModel !== "claude-haiku-4-5"
          ? ["--rerank-model", config.evidenceRerankModel]
          : []),
        ...(config.evidenceRerankTopN !== 5
          ? ["--rerank-top-n", String(config.evidenceRerankTopN)]
          : []),
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
        runRoot,
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
      runRoot,
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
