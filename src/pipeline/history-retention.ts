import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { artifactIdSchema } from "../contract/artifacts/primitives.js";
import { loadArtifact } from "../contract/selectors.js";
import { getStageDefinition } from "../contract/stages.js";
import { writeJsonArtifact } from "../shared/artifact-io.js";

type ReportIdentity = {
  runId: string;
  artifactId: string;
  contentHash: string;
};

/** Record the dependency at its source so collecting a single run can find it. */
export function retainHistorySource(
  sourceRoot: string,
  source: ReportIdentity,
  origin: ReportIdentity,
): void {
  const directory = resolve(
    sourceRoot,
    "history-references",
    artifactIdSchema.parse(source.artifactId),
  );
  mkdirSync(directory, { recursive: true });
  const path = resolve(
    directory,
    artifactIdSchema.parse(origin.artifactId) + ".json",
  );
  if (!existsSync(path)) {
    writeJsonArtifact(path, {
      source: {
        runId: source.runId,
        artifactId: source.artifactId,
        contentHash: source.contentHash,
      },
      origin: {
        runId: origin.runId,
        artifactId: origin.artifactId,
        contentHash: origin.contentHash,
      },
    });
  }
}

/** The Report envelope names all five input artifacts, including superseded attempts. */
export function historyBoundStageIds(runRoot: string): Set<string> {
  const reportIds = new Set<string>();
  for (const folder of ["history", "history-references"]) {
    const path = resolve(runRoot, folder);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && artifactIdSchema.safeParse(entry.name).success)
        reportIds.add(entry.name);
    }
  }
  const protectedIds = new Set(reportIds);
  if (!reportIds.size) return protectedIds;
  const definition = getStageDefinition("report");
  const directory = resolve(runRoot, definition.directoryName);
  for (const name of readdirSync(directory)) {
    const suffix = definition.artifactGlobs.primarySuffix;
    if (!name.endsWith(suffix)) continue;
    const id = name
      .slice(0, -suffix.length)
      .match(/artifact_[a-f0-9]{64}$/)?.[0];
    if (!id || !reportIds.has(id)) continue;
    const report = loadArtifact("report", resolve(directory, name));
    if (report.artifactId !== id)
      throw new Error("History source Report identity mismatch");
    for (const reference of report.inputArtifacts)
      protectedIds.add(reference.artifactId);
    reportIds.delete(id);
  }
  if (reportIds.size)
    throw new Error(
      "Cannot collect a run with a missing history source Report",
    );
  return protectedIds;
}
