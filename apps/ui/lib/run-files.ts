import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  getStageDefinition,
  stageDefinitions,
  type StageKey,
} from "palimpsest/contract";

import { getRepoRoot } from "./root-path";

export function getRunsRoot(): string {
  return resolve(getRepoRoot(), "data", "runs");
}

export function getRunRoot(runId: string): string {
  return resolve(getRunsRoot(), runId);
}

export function ensureRunDirectories(runId: string): string {
  const runRoot = getRunRoot(runId);
  mkdirSync(resolve(runRoot, "inputs"), { recursive: true });
  mkdirSync(resolve(runRoot, "logs"), { recursive: true });

  for (const stage of stageDefinitions) {
    mkdirSync(resolve(runRoot, stage.directoryName), { recursive: true });
  }

  return runRoot;
}

export function getShortlistPath(runId: string): string {
  return resolve(getRunRoot(runId), "inputs", "shortlist.json");
}

export function getDoisInputPath(runId: string): string {
  return resolve(getRunRoot(runId), "inputs", "dois.json");
}

export function getStageDirectory(runId: string, stageKey: StageKey): string {
  return resolve(getRunRoot(runId), getStageDefinition(stageKey).directoryName);
}

export function getSeedPdfPath(runId: string): string {
  return resolve(getRunRoot(runId), "inputs", "seed.pdf");
}

export function getStageLogPath(runId: string, stageKey: StageKey): string {
  return resolve(
    getRunRoot(runId),
    "logs",
    `${getStageDefinition(stageKey).slug}.log`,
  );
}
