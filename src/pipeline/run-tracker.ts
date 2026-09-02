import type Database from "better-sqlite3";

import {
  getRunStage,
  markRunInterrupted,
  setRunStatus,
  updateStageStatus,
} from "../storage/analysis-runs.js";
import { stageKeyValues, type StageKey } from "../contract/lean-stages.js";

/**
 * Tracks canonical pipeline stage lifecycle in the database.
 *
 * Canonical runs use exactly one row per stage. This tracker never closes the
 * injected database — signal/process ownership stays with the caller.
 */
export class RunTracker {
  readonly runId: string;
  private readonly db: Database.Database;
  private readonly activeStages = new Set<StageKey>();

  constructor(db: Database.Database, runId: string) {
    this.db = db;
    this.runId = runId;
  }

  stageStart(stageKey: StageKey): void {
    this.activeStages.add(stageKey);
    updateStageStatus(this.db, this.runId, stageKey, "running", {
      startedAt: new Date().toISOString(),
      processId: process.pid,
    });
    setRunStatus(this.db, this.runId, "running", stageKey);
  }

  /**
   * Mark an in-memory active stage as finished. Callers must already persist
   * succeeded status + artifact pointers via updateStageStatus.
   */
  stageSuccess(stageKey: StageKey): void {
    this.activeStages.delete(stageKey);
  }

  stageBlocked(stageKey: StageKey, message: string): void {
    updateStageStatus(this.db, this.runId, stageKey, "blocked", {
      errorMessage: message,
      finishedAt: new Date().toISOString(),
      exitCode: 1,
    });
  }

  runFailed(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    for (const stageKey of this.activeStages) {
      updateStageStatus(this.db, this.runId, stageKey, "failed", {
        errorMessage: msg,
        finishedAt: new Date().toISOString(),
        exitCode: 1,
      });
    }
    setRunStatus(this.db, this.runId, "failed");
  }

  blockPendingStages(message: string): void {
    for (const stageKey of stageKeyValues) {
      const stage = getRunStage(this.db, this.runId, stageKey);
      if (stage?.status === "not_started") {
        this.stageBlocked(stageKey, message);
      }
    }
  }

  /**
   * Mark active stages interrupted. Does not close the database or exit the
   * process — callers that own the DB/process must do that themselves.
   */
  interruptForSignal(message = "Interrupted by signal."): void {
    for (const stageKey of [...this.activeStages]) {
      markRunInterrupted(this.db, this.runId, stageKey, message);
      this.activeStages.delete(stageKey);
    }
  }

  succeededArtifact(
    stageKey: StageKey,
    hasExistingRun: boolean,
  ): string | undefined {
    if (!hasExistingRun) return undefined;
    const stage = getRunStage(this.db, this.runId, stageKey);
    return stage?.status === "succeeded"
      ? stage.primaryArtifactPath
      : undefined;
  }
}
