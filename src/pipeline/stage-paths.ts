import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getStageDefinition } from "../contract/stages.js";
import type { StageKey } from "../contract/stages.js";
import type { StageArtifact } from "../contract/artifacts/index.js";
import { manifestPathForArtifact } from "../shared/artifact-io.js";

export function resolveStageDirectory(
  runRoot: string,
  stageKey: StageKey,
): string {
  const directory = resolve(
    runRoot,
    getStageDefinition(stageKey).directoryName,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function resolvePrimaryArtifactPath(
  runRoot: string,
  stageKey: StageKey,
  attemptStem: string,
): string {
  const directory = resolveStageDirectory(runRoot, stageKey);
  return resolve(
    directory,
    `${attemptStem}${getStageDefinition(stageKey).artifactGlobs.primarySuffix}`,
  );
}

export function resolveReportMarkdownPath(
  runRoot: string,
  attemptStem: string,
): string {
  const directory = resolveStageDirectory(runRoot, "report");
  return resolve(
    directory,
    `${attemptStem}${getStageDefinition("report").artifactGlobs.reportSuffix!}`,
  );
}

export function createAttemptStem(
  recordedAt: string,
  artifactId: string,
  nonce?: string,
): string {
  const timestamp = new Date(recordedAt).toISOString().replace(/[-:.]/g, "");
  const collisionSafeSuffix =
    nonce ??
    `${process.hrtime.bigint().toString().padStart(20, "0")}_${randomUUID()}`;
  const safeNonce = collisionSafeSuffix.replace(/[^a-zA-Z0-9_]/g, "");
  return `${timestamp}_${safeNonce}_${artifactId}`;
}

export function writeStageManifest(
  primaryArtifactPath: string,
  artifact: StageArtifact,
  relatedArtifacts: string[] = [],
): string {
  const manifestPath = manifestPathForArtifact(primaryArtifactPath);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        stage: artifact.stage,
        runId: artifact.runId,
        artifactId: artifact.artifactId,
        contentHash: artifact.contentHash,
        primaryArtifactPath,
        relatedArtifacts,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return manifestPath;
}

function resolveInputsDirectory(runRoot: string): string {
  const directory = resolve(runRoot, "inputs");
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function resolveDoiInputPath(runRoot: string): string {
  return resolve(resolveInputsDirectory(runRoot), "dois.json");
}

export function resolveRunConfigPath(runRoot: string): string {
  return resolve(resolveInputsDirectory(runRoot), "run-config.json");
}
