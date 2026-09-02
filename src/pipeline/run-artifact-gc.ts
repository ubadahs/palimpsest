import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import {
  stageDefinitions,
  type StageDefinition,
} from "../contract/lean-stages.js";
import { listAnalysisRuns, listRunStages } from "../storage/analysis-runs.js";
import { artifactStemFromPrimaryPath } from "../contract/selectors.js";

export type OrphanedRunArtifacts = {
  runId: string;
  runRoot: string;
  /** Stage files from superseded attempts, keyed by the stage they belong to. */
  stageFiles: string[];
  /** Provenance blobs no surviving artifact refers to. */
  provenanceFiles: string[];
};

export type RunArtifactGcResult = {
  runs: OrphanedRunArtifacts[];
  fileCount: number;
  byteCount: number;
};

/**
 * Finds the files a `--rerun-from` left behind.
 *
 * A rerun writes a fresh attempt into the stage directory and repoints the run
 * registry at it. The superseded attempt's JSON, manifest, and Markdown stay on
 * disk unreferenced, along with every provenance blob only that attempt named.
 * Nothing reads them, and they are the bulk of a re-run's disk.
 *
 * The reference scan is deliberately textual and over-approximate: any
 * provenance id that appears anywhere in a surviving artifact keeps its blob.
 * A false keep costs a file; a false delete would break a chain.
 */
export function findOrphanedRunArtifacts(
  database: Database.Database,
  options: { runId?: string | undefined } = {},
): RunArtifactGcResult {
  // A live run is still writing provenance the current attempt has not yet
  // referenced from any artifact, so collecting it would delete the run's own
  // inputs out from under it.
  const runs = listAnalysisRuns(database).filter(
    (run) =>
      run.status !== "running" &&
      run.status !== "queued" &&
      (options.runId == null || run.id === options.runId),
  );
  const orphaned: OrphanedRunArtifacts[] = [];
  let fileCount = 0;
  let byteCount = 0;

  for (const run of runs) {
    if (!existsSync(run.runRoot)) continue;
    const stages = listRunStages(database, run.id);
    const liveStems = new Set(
      stages.flatMap((stage) =>
        stage.primaryArtifactPath
          ? [
              artifactStemFromPrimaryPath(
                stage.primaryArtifactPath,
                stage.stageKey,
              ),
            ]
          : [],
      ),
    );

    const stageFiles: string[] = [];
    const liveArtifactPaths: string[] = [];
    for (const definition of stageDefinitions) {
      const directory = resolve(run.runRoot, definition.directoryName);
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory)) {
        const path = resolve(directory, entry);
        const stem = attemptStemOf(entry, definition);
        if (stem == null) continue;
        if (liveStems.has(stem)) {
          if (entry.endsWith(definition.artifactGlobs.primarySuffix)) {
            liveArtifactPaths.push(path);
          }
          continue;
        }
        stageFiles.push(path);
      }
    }

    const provenanceFiles = findUnreferencedProvenance(
      run.runRoot,
      liveArtifactPaths,
    );

    if (stageFiles.length === 0 && provenanceFiles.length === 0) continue;
    orphaned.push({
      runId: run.id,
      runRoot: run.runRoot,
      stageFiles,
      provenanceFiles,
    });
    for (const path of [...stageFiles, ...provenanceFiles]) {
      fileCount += 1;
      byteCount += statSync(path).size;
    }
  }

  return { runs: orphaned, fileCount, byteCount };
}

export function deleteOrphanedRunArtifacts(result: RunArtifactGcResult): void {
  for (const run of result.runs) {
    for (const path of [...run.stageFiles, ...run.provenanceFiles]) {
      rmSync(path, { force: true });
    }
  }
}

/**
 * Attempt stems are `<timestamp>_<nonce>_<artifactId>` followed by one of the
 * stage's known suffixes. A file matching no suffix is not ours to delete.
 */
function attemptStemOf(
  fileName: string,
  definition: StageDefinition,
): string | undefined {
  const { primarySuffix, reportSuffix } = definition.artifactGlobs;
  const suffixes = [
    primarySuffix,
    primarySuffix.replace(/\.json$/, "_manifest.json"),
    ...(reportSuffix ? [reportSuffix] : []),
  ];
  for (const suffix of suffixes) {
    if (fileName.endsWith(suffix)) {
      return fileName.slice(0, fileName.length - suffix.length);
    }
  }
  return undefined;
}

function findUnreferencedProvenance(
  runRoot: string,
  liveArtifactPaths: readonly string[],
): string[] {
  const provenanceRoot = resolve(runRoot, "provenance");
  if (!existsSync(provenanceRoot)) return [];

  const referenced = new Set<string>();
  for (const path of liveArtifactPaths) {
    for (const match of readFileSync(path, "utf8").matchAll(
      /prov_[0-9a-f]{64}/g,
    )) {
      referenced.add(match[0]);
    }
  }

  return readdirSync(provenanceRoot)
    .filter((entry) => {
      const id = entry.replace(/\.json$/, "");
      return /^prov_[0-9a-f]{64}$/.test(id) && !referenced.has(id);
    })
    .map((entry) => resolve(provenanceRoot, entry));
}
