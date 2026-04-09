import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  findActiveRun,
  getAnalysisRun,
  listRunningStages,
  listRunStages,
  markDownstreamStagesStale,
  markRunInterrupted,
  setRunStatus,
  updateStageStatus,
} from "palimpsest/storage";
import {
  getPreviousStageKey,
  type AnalysisRun,
  type StageKey,
} from "palimpsest/ui-contract";

import { getDatabase } from "./database";
import { getRepoRoot } from "./root-path";
import { getRunRoot } from "./run-files";

// ---------------------------------------------------------------------------
// Supervisor state (global singleton across Next.js API requests)
// ---------------------------------------------------------------------------

type ActiveChild = {
  runId: string;
  child: ChildProcessWithoutNullStreams;
  cancelRequested: boolean;
};

type RunSupervisorState = {
  activeChildren: Map<string, ActiveChild>;
  ready: boolean;
};

declare global {
  var __citationFidelityRunSupervisor: RunSupervisorState | undefined;
}

function getState(): RunSupervisorState {
  if (!globalThis.__citationFidelityRunSupervisor) {
    globalThis.__citationFidelityRunSupervisor = {
      activeChildren: new Map<string, ActiveChild>(),
      ready: false,
    };
  }

  return globalThis.__citationFidelityRunSupervisor;
}

function isProcessAlive(processId: number | undefined): boolean {
  if (!processId) {
    return false;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core: spawn a single pipeline process for a run
// ---------------------------------------------------------------------------

function writeLog(logPath: string, chunk: string): void {
  mkdirSync(logPath.replace(/\/[^/]+$/, ""), { recursive: true });
  appendFileSync(logPath, chunk, "utf8");
}

function spawnPipeline(run: AnalysisRun): void {
  const logPath = resolve(getRunRoot(run.id), "logs", "pipeline.log");
  const startedAt = new Date().toISOString();
  writeLog(logPath, `\n=== ${startedAt} :: pipeline --run-id ${run.id} ===\n`);

  const child = spawn(
    "npm",
    ["run", "cli", "--", "pipeline", "--run-id", run.id],
    { cwd: getRepoRoot(), env: process.env, stdio: "pipe" },
  );

  const activeChild: ActiveChild = {
    runId: run.id,
    child,
    cancelRequested: false,
  };
  getState().activeChildren.set(run.id, activeChild);

  child.stdout.on("data", (chunk: Buffer) => {
    writeLog(logPath, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    writeLog(logPath, chunk.toString("utf8"));
  });

  child.on("close", (exitCode) => {
    getState().activeChildren.delete(run.id);
    const database = getDatabase();

    if (activeChild.cancelRequested) {
      // The pipeline's SIGTERM handler marks the run interrupted in DB,
      // but if it didn't get a chance, do it here.
      const currentRun = getAnalysisRun(database, run.id);
      if (
        currentRun &&
        currentRun.status === "running" &&
        currentRun.currentStage
      ) {
        markRunInterrupted(
          database,
          run.id,
          currentRun.currentStage,
          "Cancelled by user.",
        );
      }
    } else if (exitCode !== 0 && exitCode !== null) {
      // Pipeline crashed without handling its own error.
      // Check if it already marked the run as failed.
      const currentRun = getAnalysisRun(database, run.id);
      if (
        currentRun &&
        currentRun.status === "running" &&
        currentRun.currentStage
      ) {
        updateStageStatus(database, run.id, currentRun.currentStage, "failed", {
          errorMessage: `Pipeline process exited with code ${String(exitCode)}.`,
          finishedAt: new Date().toISOString(),
          exitCode,
        });
        setRunStatus(database, run.id, "failed", currentRun.currentStage);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Exported API (same signatures as before)
// ---------------------------------------------------------------------------

export function ensureRunSupervisorReady(): void {
  const state = getState();
  if (state.ready) {
    return;
  }

  const database = getDatabase();

  for (const stage of listRunningStages(database)) {
    if (!isProcessAlive(stage.processId)) {
      markRunInterrupted(
        database,
        stage.runId,
        stage.stageKey,
        "Marked interrupted during UI startup reconciliation.",
      );
    }
  }

  state.ready = true;
}

export async function startRun(runId: string): Promise<void> {
  ensureRunSupervisorReady();

  if (getState().activeChildren.has(runId)) {
    throw new Error("This run already has an active pipeline process.");
  }

  const database = getDatabase();
  const run = getAnalysisRun(database, runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const active = findActiveRun(database);
  if (active) {
    if (active.id === runId) {
      throw new Error("This run is already running.");
    }
    throw new Error(`Run ${active.id} is already active.`);
  }

  spawnPipeline(run);
}

export async function rerunStage(
  runId: string,
  stageKey: StageKey,
): Promise<void> {
  ensureRunSupervisorReady();
  const database = getDatabase();
  const run = getAnalysisRun(database, runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const active = findActiveRun(database);
  if (active) {
    throw new Error(`Run ${active.id} is already active.`);
  }

  const stages = listRunStages(database, runId);
  const previousKey = getPreviousStageKey(stageKey);
  if (previousKey) {
    const previousMembers = stages.filter((s) => s.stageKey === previousKey);
    if (
      previousMembers.length === 0 ||
      previousMembers.some((s) => s.status !== "succeeded")
    ) {
      throw new Error(
        `Cannot rerun ${stageKey} before ${previousKey} succeeds.`,
      );
    }
  }

  // Mark this stage and everything downstream as stale so the pipeline re-runs them
  markDownstreamStagesStale(database, runId, stageKey);
  // Reset every row for this stage key (including per-family downstream stages)
  for (const row of stages.filter((s) => s.stageKey === stageKey)) {
    updateStageStatus(database, runId, stageKey, "not_started", {
      familyIndex: row.familyIndex,
    });
  }

  spawnPipeline(run);
}

export function cancelRun(runId: string): void {
  const database = getDatabase();
  const activeChild = getState().activeChildren.get(runId);

  if (activeChild) {
    activeChild.cancelRequested = true;
    activeChild.child.kill("SIGTERM");
    return;
  }

  // No active child process — check if there's a running stage from a
  // pipeline process we didn't spawn (e.g. CLI-started).
  const run = getAnalysisRun(database, runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const runningStage = listRunStages(database, runId).find(
    (stage) => stage.status === "running",
  );
  if (!runningStage) {
    throw new Error("Run is not active.");
  }

  if (runningStage.processId && isProcessAlive(runningStage.processId)) {
    process.kill(runningStage.processId, "SIGTERM");
  }
  markRunInterrupted(
    database,
    runId,
    runningStage.stageKey,
    "Cancelled by user.",
  );
}
