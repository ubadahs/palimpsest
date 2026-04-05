import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAnalysisRun,
  listRunStages,
  markDownstreamStagesStale,
} from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";

describe("analysis runs repository", () => {
  let tempDirectory = "";

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "citation-fidelity-runs-"));
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("creates a run row, stage rows, and shortlist input file", () => {
    const database = openDatabase(join(tempDirectory, "runs.sqlite"));
    runMigrations(database);

    try {
      const run = createAnalysisRun(database, {
        id: "run-1",
        seedDoi: "10.1234/seed",
        trackedClaim: "Rab35 claim",
        targetStage: "m6-llm-judge",
        runRoot: join(tempDirectory, "data", "runs", "run-1"),
        config: {
          stopAfterStage: "m6-llm-judge",
          forceRefresh: false,
          m5TargetSize: 40,
          m6Model: "claude-opus-4-6",
          m6Thinking: false,
        },
      });

      const stages = listRunStages(database, run.id);
      expect(run.seedDoi).toBe("10.1234/seed");
      expect(stages).toHaveLength(6);
      expect(stages[0]?.stageKey).toBe("pre-screen");
      expect(stages[5]?.stageKey).toBe("m6-llm-judge");
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
        trackedClaim: "Rab35 claim",
        targetStage: "m6-llm-judge",
        runRoot: join(tempDirectory, "data", "runs", "run-2"),
        config: {
          stopAfterStage: "m6-llm-judge",
          forceRefresh: false,
          m5TargetSize: 40,
          m6Model: "claude-opus-4-6",
          m6Thinking: false,
        },
      });

      database.prepare(
        `
        UPDATE analysis_run_stages
        SET status = 'succeeded',
            primary_artifact_path = '/tmp/fake.json',
            report_artifact_path = '/tmp/fake.md',
            manifest_path = '/tmp/fake_manifest.json',
            summary_json = '{"headline":"done","metrics":[],"artifacts":[]}'
        WHERE run_id = 'run-2' AND stage_key IN ('m3-classify', 'm4-evidence')
      `,
      ).run();

      markDownstreamStagesStale(database, "run-2", "m2-extract");

      const stages = listRunStages(database, "run-2");
      expect(stages.find((stage) => stage.stageKey === "m3-classify")?.status).toBe(
        "stale",
      );
      expect(
        stages.find((stage) => stage.stageKey === "m3-classify")
          ?.primaryArtifactPath,
      ).toBeUndefined();
      expect(stages.find((stage) => stage.stageKey === "m4-evidence")?.status).toBe(
        "stale",
      );
    } finally {
      database.close();
    }
  });
});
