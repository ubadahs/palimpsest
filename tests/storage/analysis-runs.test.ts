import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAnalysisRun,
  getAnalysisRun,
  getRunStage,
  listRunStages,
  markDownstreamStagesStale,
  markRunInterrupted,
  updateAnalysisRunConfig,
  updateStageStatus,
} from "../../src/storage/analysis-runs.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";

describe("analysis runs repository", () => {
  let tempDirectory = "";

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "palimpsest-runs-"));
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("creates a DOI-first run with six canonical stage rows", () => {
    const database = openDatabase(join(tempDirectory, "runs.sqlite"));
    runMigrations(database);

    try {
      const run = createAnalysisRun(database, {
        id: "run-1",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed", "10.1234/second"],
        targetStage: "report",
        runRoot: join(tempDirectory, "data", "runs", "run-1"),
        config: analysisRunConfigSchema.parse({}),
      });

      const stages = listRunStages(database, run.id);
      expect(run.seedDoi).toBe("10.1234/seed");
      expect(run.trackedClaim).toBeUndefined();
      expect(run.config.stopAfterStage).toBe("report");
      expect(
        JSON.parse(
          readFileSync(join(run.runRoot, "inputs", "dois.json"), "utf8"),
        ),
      ).toEqual({
        dois: ["10.1234/seed", "10.1234/second"],
      });
      expect(stages).toHaveLength(6);
      expect(stages[0]?.stageKey).toBe("discover");
      expect(stages[0]?.status).toBe("not_started");
      expect(stages[1]?.stageKey).toBe("scope");
      expect(stages[5]?.stageKey).toBe("report");
    } finally {
      database.close();
    }
  });

  it("marks downstream succeeded stages as stale after an upstream rerun", () => {
    const database = openDatabase(join(tempDirectory, "stale.sqlite"));
    runMigrations(database);

    try {
      createAnalysisRun(database, {
        id: "run-2",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "report",
        runRoot: join(tempDirectory, "data", "runs", "run-2"),
        config: analysisRunConfigSchema.parse({}),
      });

      database
        .prepare(
          `
        UPDATE analysis_run_stages
        SET status = 'succeeded',
            primary_artifact_path = '/tmp/fake.json',
            report_artifact_path = '/tmp/fake.md',
            manifest_path = '/tmp/fake_manifest.json',
            summary_json = '{"headline":"done","metrics":[],"artifacts":[]}'
        WHERE run_id = 'run-2' AND stage_key IN ('scope', 'evidence', 'report')
      `,
        )
        .run();

      markDownstreamStagesStale(database, "run-2", "scope");

      const stages = listRunStages(database, "run-2");
      expect(stages.find((stage) => stage.stageKey === "scope")?.status).toBe(
        "not_started",
      );
      expect(
        stages.find((stage) => stage.stageKey === "scope")?.primaryArtifactPath,
      ).toBeUndefined();
      expect(
        stages.find((stage) => stage.stageKey === "evidence")?.status,
      ).toBe("stale");
      expect(stages.find((stage) => stage.stageKey === "report")?.status).toBe(
        "stale",
      );
    } finally {
      database.close();
    }
  });

  it("rejects duplicate normalized seed DOIs", () => {
    const database = openDatabase(join(tempDirectory, "dup-dois.sqlite"));
    runMigrations(database);
    try {
      expect(() =>
        createAnalysisRun(database, {
          id: "run-dup",
          seedDoi: "10.1234/seed",
          seedDois: ["10.1234/seed", "https://doi.org/10.1234/SEED"],
          targetStage: "discover",
          runRoot: join(tempDirectory, "data", "runs", "run-dup"),
          config: analysisRunConfigSchema.parse({}),
        }),
      ).toThrow(/duplicate/i);
    } finally {
      database.close();
    }
  });

  it("rejects manual tracked-claim ingestion", () => {
    const database = openDatabase(join(tempDirectory, "doi-first.sqlite"));
    runMigrations(database);
    try {
      expect(() =>
        createAnalysisRun(database, {
          id: "run-manual",
          seedDoi: "10.1234/seed",
          seedDois: ["10.1234/seed"],
          trackedClaim: "Manual claim",
          targetStage: "discover",
          runRoot: join(tempDirectory, "data", "runs", "run-manual"),
          config: analysisRunConfigSchema.parse({}),
        }),
      ).toThrow(/DOI/i);
    } finally {
      database.close();
    }
  });

  it("updates canonical resume config and target together", () => {
    const database = openDatabase(join(tempDirectory, "resume-config.sqlite"));
    runMigrations(database);
    try {
      createAnalysisRun(database, {
        id: "run-config",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "discover",
        runRoot: join(tempDirectory, "data", "runs", "run-config"),
        config: analysisRunConfigSchema.parse({
          stopAfterStage: "discover",
        }),
      });
      const config = analysisRunConfigSchema.parse({
        stopAfterStage: "evidence",
        evidence: { rerankEnabled: true },
      });
      updateAnalysisRunConfig(database, "run-config", {
        config,
        targetStage: "evidence",
      });
      const reloaded = getAnalysisRun(database, "run-config")!;
      expect(reloaded.targetStage).toBe("evidence");
      expect(reloaded.config.stopAfterStage).toBe("evidence");
      expect(reloaded.config.evidence.rerankEnabled).toBe(true);
    } finally {
      database.close();
    }
  });

  it("preserves artifact pointers on running/failed/interrupted updates", () => {
    const database = openDatabase(join(tempDirectory, "pointers.sqlite"));
    runMigrations(database);
    try {
      createAnalysisRun(database, {
        id: "run-pointers",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "report",
        runRoot: join(tempDirectory, "data", "runs", "run-pointers"),
        config: analysisRunConfigSchema.parse({}),
      });

      updateStageStatus(database, "run-pointers", "discover", "succeeded", {
        primaryArtifactPath: "/tmp/discover.json",
        reportArtifactPath: "/tmp/discover.md",
        manifestPath: "/tmp/discover_manifest.json",
        summary: {
          headline: "discover done",
          metrics: [],
          artifacts: [],
        },
        finishedAt: new Date().toISOString(),
        exitCode: 0,
      });

      updateStageStatus(database, "run-pointers", "discover", "running", {
        startedAt: new Date().toISOString(),
        processId: 42,
      });
      let stage = getRunStage(database, "run-pointers", "discover")!;
      expect(stage.status).toBe("running");
      expect(stage.primaryArtifactPath).toBe("/tmp/discover.json");
      expect(stage.reportArtifactPath).toBe("/tmp/discover.md");
      expect(stage.manifestPath).toBe("/tmp/discover_manifest.json");
      expect(stage.summary?.headline).toBe("discover done");

      updateStageStatus(database, "run-pointers", "discover", "failed", {
        errorMessage: "boom",
        finishedAt: new Date().toISOString(),
        exitCode: 1,
      });
      stage = getRunStage(database, "run-pointers", "discover")!;
      expect(stage.status).toBe("failed");
      expect(stage.primaryArtifactPath).toBe("/tmp/discover.json");
      expect(stage.summary?.headline).toBe("discover done");
      expect(stage.errorMessage).toBe("boom");

      markRunInterrupted(
        database,
        "run-pointers",
        "discover",
        "Interrupted by signal.",
      );
      stage = getRunStage(database, "run-pointers", "discover")!;
      expect(stage.status).toBe("interrupted");
      expect(stage.primaryArtifactPath).toBe("/tmp/discover.json");
      expect(stage.manifestPath).toBe("/tmp/discover_manifest.json");

      markDownstreamStagesStale(database, "run-pointers", "discover");
      stage = getRunStage(database, "run-pointers", "discover")!;
      expect(stage.status).toBe("not_started");
      expect(stage.primaryArtifactPath).toBeUndefined();
      expect(stage.summary).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
