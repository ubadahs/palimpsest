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

export function ensureStageOutputDir(
  outputRoot: string,
  stageKey: StageKey,
): string {
  const stageDir = resolveStageOutputDir(outputRoot, stageKey);
  mkdirSync(stageDir, { recursive: true });
  return stageDir;
}

export function buildStageArtifactStem(
  stamp: string,
  familyIndex?: number,
): string {
  return familyIndex == null
    ? stamp
    : `${stamp}_family-${String(familyIndex + 1)}`;
}

export function resolveStageArtifactPaths(
  outputRoot: string,
  stageKey: StageKey,
  stamp: string,
  familyIndex?: number,
): StageArtifactPaths {
  const stageDir = ensureStageOutputDir(outputRoot, stageKey);
  const artifactStem = buildStageArtifactStem(stamp, familyIndex);
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
  familyIndex?: number,
): string {
  const { stageDir, artifactStem } = resolveStageArtifactPaths(
    outputRoot,
    stageKey,
    stamp,
    familyIndex,
  );
  return resolve(stageDir, `${artifactStem}${suffix}`);
}
