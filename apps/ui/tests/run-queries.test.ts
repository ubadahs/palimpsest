import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setRunStatus,
  updateStageStatus,
  type DatabaseConnection,
} from "palimpsest/storage";
import { analysisRunConfigSchema, stageDefinitions } from "palimpsest/contract";

import { createRun, getRunDetailOrThrow } from "../lib/run-queries";
import { getDoisInputPath, getStageLogPath } from "../lib/run-files";
import { getDatabase } from "../lib/database";

type UiGlobals = typeof globalThis & {
  __citationFidelityUiDatabase?: DatabaseConnection;
};

describe("canonical run creation", () => {
  let tempRoot = "";
  let previousRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "palimpsest-ui-"));
    mkdirSync(join(tempRoot, "data"), { recursive: true });
    previousRoot = process.env["PALIMPSEST_ROOT"];
    process.env["PALIMPSEST_ROOT"] = tempRoot;
  });

  afterEach(() => {
    const globals = globalThis as UiGlobals;
    globals.__citationFidelityUiDatabase?.close();
    delete globals.__citationFidelityUiDatabase;
    if (previousRoot) process.env["PALIMPSEST_ROOT"] = previousRoot;
    else delete process.env["PALIMPSEST_ROOT"];
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates a DOI-first six-stage report run", () => {
    const run = createRun({
      id: "run-canonical",
      seedDoi: "10.1234/seed",
      seedDois: ["10.1234/seed"],
      targetStage: "report",
      config: analysisRunConfigSchema.parse({}),
    });

    expect(run.trackedClaim).toBeUndefined();
    expect(run.config.stopAfterStage).toBe("report");
    expect(run.config.evidence.rerankEnabled).toBe(true);
    expect(getDoisInputPath(run.id)).toContain("dois.json");

    const detail = getRunDetailOrThrow(run.id);
    expect(detail.stages.map((stage) => stage.stageKey)).toEqual(
      stageDefinitions.map((stage) => stage.key),
    );
    expect(detail.stages).toHaveLength(6);
    expect(getDatabase()).toBeTruthy();
  });

  it("uses canonical progress logs for failure detail", () => {
    createRun({
      id: "run-failed",
      seedDoi: "10.1234/seed",
      seedDois: ["10.1234/seed"],
      targetStage: "report",
      config: analysisRunConfigSchema.parse({}),
    });
    const database = getDatabase();
    updateStageStatus(database, "run-failed", "scope", "failed", {
      errorMessage: "Command exited with code 1.",
      startedAt: "2026-07-17T12:00:00.000Z",
      finishedAt: "2026-07-17T12:01:00.000Z",
    });
    setRunStatus(database, "run-failed", "failed", "scope");
    writeFileSync(
      getStageLogPath("run-failed", "scope"),
      `CF_PROGRESS ${JSON.stringify({
        stage: "scope",
        step: "materialize_seed_text",
        status: "failed",
        detail: "Seed acquisition returned no inspectable text.",
      })}\n`,
      "utf8",
    );

    const detail = getRunDetailOrThrow("run-failed");
    expect(detail.activeWorkflow?.source).toBe("telemetry");
    expect(detail.activeWorkflow?.summary).toBe(
      "Seed acquisition returned no inspectable text.",
    );
  });

  it("does not surface superseded artifacts while a stage awaits rerun", () => {
    createRun({
      id: "run-stale-artifacts",
      seedDoi: "10.1234/seed",
      seedDois: ["10.1234/seed"],
      targetStage: "report",
      config: analysisRunConfigSchema.parse({}),
    });
    const database = getDatabase();
    const stageDir = join(
      tempRoot,
      "data",
      "runs",
      "run-stale-artifacts",
      "stages",
      "discover",
    );
    mkdirSync(stageDir, { recursive: true });
    const supersededPath = join(
      stageDir,
      "2026-07-17T12-00-00Z_old_discover.json",
    );
    writeFileSync(supersededPath, '{"stageKey":"discover"}\n', "utf8");

    updateStageStatus(
      database,
      "run-stale-artifacts",
      "discover",
      "succeeded",
      {
        primaryArtifactPath: supersededPath,
        finishedAt: "2026-07-17T12:00:00.000Z",
      },
    );
    updateStageStatus(database, "run-stale-artifacts", "discover", "stale", {
      finishedAt: "2026-07-17T12:05:00.000Z",
    });

    // Clear pointers the way markDownstreamStagesStale does.
    database
      .prepare(
        `
        UPDATE analysis_run_stages
        SET primary_artifact_path = NULL,
            report_artifact_path = NULL,
            manifest_path = NULL,
            summary_json = NULL,
            status = 'not_started'
        WHERE run_id = 'run-stale-artifacts' AND stage_key = 'discover'
      `,
      )
      .run();

    const detail = getRunDetailOrThrow("run-stale-artifacts");
    const discover = detail.stages.find((s) => s.stageKey === "discover");
    expect(discover?.aggregateStatus).toBe("not_started");
    expect(discover?.members[0]?.primaryArtifactPath).toBeUndefined();
    expect(discover?.summary).toBeUndefined();
  });
});
