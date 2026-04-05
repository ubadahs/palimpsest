import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "citation-fidelity/storage";
import {
  setRunStatus,
  updateStageStatus,
} from "citation-fidelity/storage";
import { serializeProgressEvent } from "citation-fidelity/ui-contract";

import { createRun, getRunDetailOrThrow, getStageDetailOrThrow } from "../lib/run-queries";
import { getDatabase } from "../lib/database";
import { getStageLogPath } from "../lib/run-files";

type UiGlobals = typeof globalThis & {
  __citationFidelityUiDatabase?: DatabaseConnection;
};

describe("run queries workflow integration", () => {
  let tempRoot = "";
  let previousRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "citation-fidelity-ui-"));
    mkdirSync(join(tempRoot, "data"), { recursive: true });
    previousRoot = process.env["CITATION_FIDELITY_ROOT"];
    process.env["CITATION_FIDELITY_ROOT"] = tempRoot;
  });

  afterEach(() => {
    const globals = globalThis as UiGlobals;
    globals.__citationFidelityUiDatabase?.close();
    delete globals.__citationFidelityUiDatabase;

    if (previousRoot) {
      process.env["CITATION_FIDELITY_ROOT"] = previousRoot;
    } else {
      delete process.env["CITATION_FIDELITY_ROOT"];
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("attaches active workflow snapshots and workflow-based summary fallbacks", () => {
    const run = createRun({
      id: "run-workflow",
      seedDoi: "10.1234/seed",
      trackedClaim: "Tracked claim",
      targetStage: "m6-llm-judge",
      config: {
        stopAfterStage: "m6-llm-judge",
        forceRefresh: false,
        m5TargetSize: 40,
        m6Model: "claude-opus-4-6",
        m6Thinking: false,
      },
    });
    const database = getDatabase();
    const logPath = getStageLogPath(run.id, "m6-llm-judge");

    updateStageStatus(database, run.id, "m6-llm-judge", "running", {
      startedAt: new Date().toISOString(),
    });
    setRunStatus(database, run.id, "running", "m6-llm-judge");
    writeFileSync(
      logPath,
      [
        serializeProgressEvent({
          stage: "m6-llm-judge",
          step: "load_active_records",
          status: "completed",
          detail: "31 active records ready",
        }),
        serializeProgressEvent({
          stage: "m6-llm-judge",
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
    const stageDetail = getStageDetailOrThrow(run.id, "m6-llm-judge");

    expect(detail.activeWorkflow?.source).toBe("telemetry");
    expect(detail.activeWorkflow?.counts).toEqual({
      current: 6,
      total: 31,
      label: "records",
    });
    expect(
      detail.stages.find((stage) => stage.stageKey === "m6-llm-judge")?.summary
        ?.headline,
    ).toBe(detail.activeWorkflow?.summary);
    expect(stageDetail.workflow.steps[1]?.status).toBe("running");
    expect(stageDetail.workflow.steps[1]?.detail).toContain("6 of 31");
  });
});
