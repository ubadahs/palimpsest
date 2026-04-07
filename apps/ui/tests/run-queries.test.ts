import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "palimpsest/storage";
import { setRunStatus, updateStageStatus } from "palimpsest/storage";
import { serializeProgressEvent } from "palimpsest/ui-contract";

import {
  createRun,
  getRunDetailOrThrow,
  getStageDetailOrThrow,
} from "../lib/run-queries";
import { getDatabase } from "../lib/database";
import { getStageLogPath } from "../lib/run-files";

type UiGlobals = typeof globalThis & {
  __citationFidelityUiDatabase?: DatabaseConnection;
};

describe("run queries workflow integration", () => {
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

    if (previousRoot) {
      process.env["PALIMPSEST_ROOT"] = previousRoot;
    } else {
      delete process.env["PALIMPSEST_ROOT"];
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("attaches active workflow snapshots and workflow-based summary fallbacks", () => {
    const run = createRun({
      id: "run-workflow",
      seedDoi: "10.1234/seed",
      trackedClaim: "Tracked claim",
      targetStage: "adjudicate",
      config: {
        stopAfterStage: "adjudicate",
        forceRefresh: false,
        curateTargetSize: 40,
        adjudicateModel: "claude-opus-4-6",
        adjudicateThinking: false,
      },
    });
    const database = getDatabase();
    const logPath = getStageLogPath(run.id, "adjudicate");

    updateStageStatus(database, run.id, "adjudicate", "running", {
      startedAt: new Date().toISOString(),
    });
    setRunStatus(database, run.id, "running", "adjudicate");
    writeFileSync(
      logPath,
      [
        serializeProgressEvent({
          stage: "adjudicate",
          step: "load_active_records",
          status: "completed",
          detail: "31 active records ready",
        }),
        serializeProgressEvent({
          stage: "adjudicate",
          step: "adjudicate_records",
          status: "running",
          detail: "Adjudicating record 6 of 31",
          current: 6,
          total: 31,
        }),
      ].join("\n"),
      "utf8",
    );

    const detail = getRunDetailOrThrow(run.id);
    const stageDetail = getStageDetailOrThrow(run.id, "adjudicate");

    expect(detail.activeWorkflow?.source).toBe("telemetry");
    expect(detail.activeWorkflow?.counts).toEqual({
      current: 6,
      total: 31,
      label: "records",
    });
    expect(
      detail.stages.find((stage) => stage.stageKey === "adjudicate")?.summary
        ?.headline,
    ).toBe(detail.activeWorkflow?.summary);
    expect(stageDetail.workflow.steps[1]?.status).toBe("running");
    expect(stageDetail.workflow.steps[1]?.detail).toContain("6 of 31");
  });
});
