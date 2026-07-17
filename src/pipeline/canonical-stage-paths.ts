import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getStageDefinition } from "../contract/stages.js";
import type { StageKey } from "../contract/run-types.js";
import type { LeanStageArtifact } from "../contract/lean-artifacts.js";
import { manifestPathForArtifact } from "../shared/artifact-io.js";

export function resolveCanonicalStageDirectory(
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

export function resolveCanonicalPrimaryArtifactPath(
  runRoot: string,
  stageKey: StageKey,
  attemptStem: string,
): string {
  const directory = resolveCanonicalStageDirectory(runRoot, stageKey);
  return resolve(
    directory,
    `${attemptStem}${getStageDefinition(stageKey).artifactGlobs.primarySuffix}`,
  );
}

export function resolveCanonicalReportMarkdownPath(
  runRoot: string,
  attemptStem: string,
): string {
  const directory = resolveCanonicalStageDirectory(runRoot, "report");
  return resolve(
    directory,
    `${attemptStem}${getStageDefinition("report").artifactGlobs.reportSuffix!}`,
  );
}

export function createCanonicalAttemptStem(
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

export function writeCanonicalStageManifest(
  primaryArtifactPath: string,
  artifact: LeanStageArtifact,
  relatedArtifacts: string[] = [],
): string {
  const manifestPath = manifestPathForArtifact(primaryArtifactPath);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        canonicalStage: artifact.canonicalStage,
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

export function resolveCanonicalInputsDirectory(runRoot: string): string {
  const directory = resolve(runRoot, "inputs");
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function resolveCanonicalDoiInputPath(runRoot: string): string {
  return resolve(resolveCanonicalInputsDirectory(runRoot), "dois.json");
}

export function resolveCanonicalRunConfigPath(runRoot: string): string {
  return resolve(resolveCanonicalInputsDirectory(runRoot), "run-config.json");
}
