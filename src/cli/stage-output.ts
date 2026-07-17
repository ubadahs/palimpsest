import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { stageKeyValues } from "../contract/stages.js";
import { getStageDefinition } from "../contract/stages.js";

type StageKey = (typeof stageKeyValues)[number];

export type StageArtifactPaths = {
  stageDir: string;
  artifactStem: string;
  primaryPath: string;
  reportPath: string;
};

export function resolveStageOutputDir(
  outputRoot: string,
  stageKey: StageKey,
): string {
  return resolve(outputRoot, getStageDefinition(stageKey).directoryName);
}

function ensureStageOutputDir(outputRoot: string, stageKey: StageKey): string {
  const stageDir = resolveStageOutputDir(outputRoot, stageKey);
  mkdirSync(stageDir, { recursive: true });
  return stageDir;
}

export function buildStageArtifactStem(stamp: string): string {
  return stamp;
}

export function resolveStageArtifactPaths(
  outputRoot: string,
  stageKey: StageKey,
  stamp: string,
): StageArtifactPaths {
  const stageDir = ensureStageOutputDir(outputRoot, stageKey);
  const artifactStem = buildStageArtifactStem(stamp);
  const definition = getStageDefinition(stageKey);

  return {
    stageDir,
    artifactStem,
    primaryPath: resolve(
      stageDir,
      `${artifactStem}${definition.artifactGlobs.primarySuffix}`,
    ),
    reportPath: resolve(
      stageDir,
      `${artifactStem}${definition.artifactGlobs.reportSuffix}`,
    ),
  };
}

export function resolveStageExtraArtifactPath(
  outputRoot: string,
  stageKey: StageKey,
  stamp: string,
  suffix: string,
): string {
  const { stageDir, artifactStem } = resolveStageArtifactPaths(
    outputRoot,
    stageKey,
    stamp,
  );
  return resolve(stageDir, `${artifactStem}${suffix}`);
}
