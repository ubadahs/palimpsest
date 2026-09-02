import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import {
  deleteOrphanedRunArtifacts,
  findOrphanedRunArtifacts,
} from "../../src/pipeline/run-artifact-gc.js";
import {
  createAnalysisRun,
  setRunStatus,
  updateStageStatus,
} from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function provenanceId(seed: string): string {
  return `prov_${seed.repeat(64).slice(0, 64)}`;
}

describe("run artifact garbage collection", () => {
  it("deletes superseded attempts and the provenance only they referenced", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-gc-"));
    tempRoots.push(root);
    const database = openDatabase(join(root, "gc.sqlite"));
    runMigrations(database);
    const runRoot = join(root, "data", "runs", "run-1");

    try {
      createAnalysisRun(database, {
        id: "run-1",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "report",
        runRoot,
        config: analysisRunConfigSchema.parse({}),
      });

      // Collection only considers finished runs: a live one is still writing.
      setRunStatus(database, "run-1", "succeeded");

      const discoverDir = join(runRoot, "00-discover");
      const provenanceDir = join(runRoot, "provenance");
      mkdirSync(discoverDir, { recursive: true });
      mkdirSync(provenanceDir, { recursive: true });

      const keptProvenance = provenanceId("a");
      const orphanProvenance = provenanceId("b");
      writeFileSync(
        join(provenanceDir, `${keptProvenance}.json`),
        '{"role":"kept"}',
        "utf8",
      );
      writeFileSync(
        join(provenanceDir, `${orphanProvenance}.json`),
        '{"role":"orphaned"}',
        "utf8",
      );

      const supersededStem = "20260902T100000Z_first";
      const currentStem = "20260902T110000Z_second";
      for (const [stem, referenced] of [
        [supersededStem, orphanProvenance],
        [currentStem, keptProvenance],
      ] as const) {
        writeFileSync(
          join(discoverDir, `${stem}_canonical-discover.json`),
          JSON.stringify({ provenance: referenced }),
          "utf8",
        );
        writeFileSync(
          join(discoverDir, `${stem}_canonical-discover_manifest.json`),
          "{}",
          "utf8",
        );
      }
      // The run registry points only at the second attempt.
      updateStageStatus(database, "run-1", "discover", "succeeded", {
        primaryArtifactPath: join(
          discoverDir,
          `${currentStem}_canonical-discover.json`,
        ),
      });

      const result = findOrphanedRunArtifacts(database);
      expect(result.fileCount).toBe(3);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]!.stageFiles).toHaveLength(2);
      expect(result.runs[0]!.provenanceFiles).toEqual([
        join(provenanceDir, `${orphanProvenance}.json`),
      ]);

      deleteOrphanedRunArtifacts(result);

      expect(
        existsSync(join(discoverDir, `${currentStem}_canonical-discover.json`)),
      ).toBe(true);
      expect(
        existsSync(
          join(discoverDir, `${supersededStem}_canonical-discover.json`),
        ),
      ).toBe(false);
      expect(existsSync(join(provenanceDir, `${keptProvenance}.json`))).toBe(
        true,
      );
      expect(existsSync(join(provenanceDir, `${orphanProvenance}.json`))).toBe(
        false,
      );
    } finally {
      database.close();
    }
  });

  it("leaves a live run alone even when it has unreferenced files", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-gc-live-"));
    tempRoots.push(root);
    const database = openDatabase(join(root, "gc.sqlite"));
    runMigrations(database);
    const runRoot = join(root, "data", "runs", "run-live");

    try {
      createAnalysisRun(database, {
        id: "run-live",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "report",
        runRoot,
        config: analysisRunConfigSchema.parse({}),
      });
      setRunStatus(database, "run-live", "running", "scope");
      const provenanceDir = join(runRoot, "provenance");
      mkdirSync(provenanceDir, { recursive: true });
      writeFileSync(
        join(provenanceDir, `${provenanceId("c")}.json`),
        '{"role":"in flight"}',
        "utf8",
      );

      // The blob is unreferenced only because Scope has not written its
      // artifact yet; collecting it would delete the run's own input.
      expect(findOrphanedRunArtifacts(database).fileCount).toBe(0);
      expect(existsSync(join(provenanceDir, `${provenanceId("c")}.json`))).toBe(
        true,
      );
    } finally {
      database.close();
    }
  });

  it("keeps a superseded report a human review was written against", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-gc-review-"));
    tempRoots.push(root);
    const database = openDatabase(join(root, "gc.sqlite"));
    runMigrations(database);
    const runRoot = join(root, "data", "runs", "run-review");

    try {
      createAnalysisRun(database, {
        id: "run-review",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "report",
        runRoot,
        config: analysisRunConfigSchema.parse({}),
      });
      setRunStatus(database, "run-review", "succeeded");
      const reportDir = join(runRoot, "05-report");
      mkdirSync(reportDir, { recursive: true });

      const reviewedArtifactId = `artifact_${"a".repeat(64)}`;
      const reviewedStem = `20260902T100000Z_${reviewedArtifactId}`;
      const unreviewedStem = `20260902T103000Z_${"b".repeat(8)}`;
      const currentStem = "20260902T110000Z_current";
      for (const stem of [reviewedStem, unreviewedStem, currentStem]) {
        writeFileSync(
          join(reportDir, `${stem}_canonical-report.json`),
          "{}",
          "utf8",
        );
      }
      // The review sidecar is keyed by the report artifact it judged.
      mkdirSync(join(runRoot, "review", reviewedArtifactId), {
        recursive: true,
      });
      updateStageStatus(database, "run-review", "report", "succeeded", {
        primaryArtifactPath: join(
          reportDir,
          `${currentStem}_canonical-report.json`,
        ),
      });

      const result = findOrphanedRunArtifacts(database);
      expect(result.runs[0]!.stageFiles).toEqual([
        join(reportDir, `${unreviewedStem}_canonical-report.json`),
      ]);
    } finally {
      database.close();
    }
  });

  it("skips a queued run that has not started writing", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-gc-queued-"));
    tempRoots.push(root);
    const database = openDatabase(join(root, "gc.sqlite"));
    runMigrations(database);
    const runRoot = join(root, "data", "runs", "run-queued");

    try {
      createAnalysisRun(database, {
        id: "run-queued",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "report",
        runRoot,
        config: analysisRunConfigSchema.parse({}),
      });
      const provenanceDir = join(runRoot, "provenance");
      mkdirSync(provenanceDir, { recursive: true });
      writeFileSync(
        join(provenanceDir, `${provenanceId("d")}.json`),
        "{}",
        "utf8",
      );

      expect(findOrphanedRunArtifacts(database).runs).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("leaves a run whose every attempt is still referenced alone", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-gc-clean-"));
    tempRoots.push(root);
    const database = openDatabase(join(root, "gc.sqlite"));
    runMigrations(database);
    const runRoot = join(root, "data", "runs", "run-2");

    try {
      createAnalysisRun(database, {
        id: "run-2",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "report",
        runRoot,
        config: analysisRunConfigSchema.parse({}),
      });
      setRunStatus(database, "run-2", "succeeded");
      const discoverDir = join(runRoot, "00-discover");
      mkdirSync(discoverDir, { recursive: true });
      const stem = "20260902T100000Z_only";
      writeFileSync(
        join(discoverDir, `${stem}_canonical-discover.json`),
        "{}",
        "utf8",
      );
      updateStageStatus(database, "run-2", "discover", "succeeded", {
        primaryArtifactPath: join(
          discoverDir,
          `${stem}_canonical-discover.json`,
        ),
      });

      expect(findOrphanedRunArtifacts(database).fileCount).toBe(0);
    } finally {
      database.close();
    }
  });
});
