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
    tempDirectory = mkdtempSync(join(tmpdir(), "palimpsest-runs-"));
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
        targetStage: "adjudicate",
        runRoot: join(tempDirectory, "data", "runs", "run-1"),
        config: {
          stopAfterStage: "adjudicate",
          forceRefresh: false,
          curateTargetSize: 40,
          adjudicateModel: "claude-opus-4-6",
          adjudicateThinking: false,
          evidenceLlmRerank: true,
          discoverStrategy: "legacy",
          discoverTopN: 5,
          discoverRank: true,
          discoverModel: "claude-opus-4-6",
          discoverProbeBudget: 20,
          discoverShortlistCap: 10,
          screenGroundingModel: "claude-opus-4-6",
          screenFilterModel: "claude-haiku-4-5",
          screenFilterConcurrency: 10,
          evidenceRerankModel: "claude-haiku-4-5",
          evidenceRerankTopN: 5,
        },
      });

      const stages = listRunStages(database, run.id);
      expect(run.seedDoi).toBe("10.1234/seed");
      expect(stages).toHaveLength(7);
      expect(stages[0]?.stageKey).toBe("discover");
      expect(stages[0]?.status).toBe("succeeded"); // manual claim skips discover
      expect(stages[1]?.stageKey).toBe("screen");
      expect(stages[6]?.stageKey).toBe("adjudicate");
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
        targetStage: "adjudicate",
        runRoot: join(tempDirectory, "data", "runs", "run-2"),
        config: {
          stopAfterStage: "adjudicate",
          forceRefresh: false,
          curateTargetSize: 40,
          adjudicateModel: "claude-opus-4-6",
          adjudicateThinking: false,
          evidenceLlmRerank: true,
          discoverStrategy: "legacy",
          discoverTopN: 5,
          discoverRank: true,
          discoverModel: "claude-opus-4-6",
          discoverProbeBudget: 20,
          discoverShortlistCap: 10,
          screenGroundingModel: "claude-opus-4-6",
          screenFilterModel: "claude-haiku-4-5",
          screenFilterConcurrency: 10,
          evidenceRerankModel: "claude-haiku-4-5",
          evidenceRerankTopN: 5,
        },
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
        WHERE run_id = 'run-2' AND stage_key IN ('classify', 'evidence')
      `,
        )
        .run();

      markDownstreamStagesStale(database, "run-2", "extract");

      const stages = listRunStages(database, "run-2");
      expect(
        stages.find((stage) => stage.stageKey === "classify")?.status,
      ).toBe("stale");
      expect(
        stages.find((stage) => stage.stageKey === "classify")
          ?.primaryArtifactPath,
      ).toBeUndefined();
      expect(
        stages.find((stage) => stage.stageKey === "evidence")?.status,
      ).toBe("stale");
    } finally {
      database.close();
    }
  });
});
