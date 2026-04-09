import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "palimpsest/storage";
import { setRunStatus, updateStageStatus } from "palimpsest/storage";
import {
  analysisRunConfigSchema,
  serializeProgressEvent,
} from "palimpsest/ui-contract";

import {
  createRun,
  getRunDetailOrThrow,
  getStageDetailOrThrow,
} from "../lib/run-queries";
import { getDatabase } from "../lib/database";
import {
  getDoisInputPath,
  getShortlistPath,
  getStageDirectory,
  getStageLogPath,
} from "../lib/run-files";

type UiGlobals = typeof globalThis & {
  __citationFidelityUiDatabase?: DatabaseConnection;
};

describe("run creation", () => {
  let tempRoot = "";
  let previousRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "palimpsest-ui-creation-"));
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

  it("auto-discover run: writes dois.json, discover is not_started, shortlist absent", () => {
    const run = createRun({
      id: "run-auto",
      seedDoi: "10.1234/seed",
      targetStage: "adjudicate",
      config: analysisRunConfigSchema.parse({
        stopAfterStage: "adjudicate",
        forceRefresh: false,
        curateTargetSize: 40,
        adjudicateModel: "claude-opus-4-6",
        adjudicateThinking: true,
        discoverTopN: 5,
        discoverRank: true,
        discoverModel: "claude-opus-4-6",
      }),
    });

    expect(run.trackedClaim).toBeUndefined();
    expect(existsSync(getDoisInputPath(run.id))).toBe(true);
    expect(existsSync(getShortlistPath(run.id))).toBe(false);

    const detail = getRunDetailOrThrow(run.id);
    const discover = detail.stages.find((s) => s.stageKey === "discover");
    expect(discover?.aggregateStatus).toBe("not_started");
    expect(detail.stages).toHaveLength(7);
  });

  it("manual-claim run: writes shortlist.json, discover is succeeded", () => {
    const run = createRun({
      id: "run-manual",
      seedDoi: "10.1234/seed",
      trackedClaim: "Neurons form sublaminae.",
      targetStage: "adjudicate",
      config: analysisRunConfigSchema.parse({
        stopAfterStage: "adjudicate",
        forceRefresh: false,
        curateTargetSize: 40,
        adjudicateModel: "claude-opus-4-6",
        adjudicateThinking: true,
        discoverTopN: 5,
        discoverRank: true,
        discoverModel: "claude-opus-4-6",
      }),
    });

    expect(run.trackedClaim).toBe("Neurons form sublaminae.");
    expect(existsSync(getShortlistPath(run.id))).toBe(true);

    const detail = getRunDetailOrThrow(run.id);
    const discover = detail.stages.find((s) => s.stageKey === "discover");
    expect(discover?.aggregateStatus).toBe("succeeded");
    expect(discover?.summary?.headline).toContain("Skipped");
  });
});

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
      config: analysisRunConfigSchema.parse({
        stopAfterStage: "adjudicate",
        forceRefresh: false,
        curateTargetSize: 40,
        adjudicateModel: "claude-opus-4-6",
        adjudicateThinking: false,
      }),
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

  it("enriches failed discover runs with specific log-backed error detail", () => {
    const run = createRun({
      id: "run-discover-failure",
      seedDoi: "10.1234/seed",
      targetStage: "adjudicate",
      config: analysisRunConfigSchema.parse({
        stopAfterStage: "adjudicate",
        forceRefresh: false,
        curateTargetSize: 40,
        adjudicateModel: "claude-opus-4-6",
        adjudicateThinking: true,
        discoverTopN: 5,
        discoverRank: true,
        discoverModel: "claude-opus-4-6",
      }),
    });
    const database = getDatabase();
    const logPath = getStageLogPath(run.id, "discover");
    const artifactPath = join(
      getStageDirectory(run.id, "discover"),
      "2026-04-07_001_discovery-results.json",
    );
    const failureDetail =
      "No seeds produced.\n  10.1234/seed: Full text unavailable: GROBID HTTP 500 from http://localhost:8070";

    updateStageStatus(database, run.id, "discover", "failed", {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      errorMessage: "Command exited with code 1.",
    });
    setRunStatus(database, run.id, "failed", "discover");
    writeFileSync(
      logPath,
      serializeProgressEvent({
        stage: "discover",
        step: "emit_shortlist",
        status: "failed",
        detail: failureDetail,
      }),
      "utf8",
    );
    writeFileSync(
      artifactPath,
      JSON.stringify(
        [
          {
            doi: "10.1234/seed",
            status: "no_fulltext",
            statusDetail:
              "Full text unavailable: GROBID HTTP 500 from http://localhost:8070",
            claims: [],
            findingCount: 0,
            totalClaimCount: 0,
            generatedAt: "2026-04-07T00:00:00.000Z",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const detail = getRunDetailOrThrow(run.id);
    const discover = detail.stages.find(
      (stage) => stage.stageKey === "discover",
    );
    const stageDetail = getStageDetailOrThrow(run.id, "discover");

    expect(discover?.members[0]?.errorMessage).toContain(
      "Full text unavailable",
    );
    expect(discover?.summary?.headline).toContain("Full text unavailable");
    expect(detail.activeWorkflow?.summary).toContain("Full text unavailable");
    expect(stageDetail.errorMessage).toContain("Full text unavailable");
    expect(stageDetail.workflow.summary).toContain("Full text unavailable");
  });
});
