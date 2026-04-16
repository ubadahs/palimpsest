import type Database from "better-sqlite3";

import {
  ensureFamilyStageRow,
  getRunStage,
  markRunInterrupted,
  setRunStatus,
  updateStageStatus,
} from "../storage/analysis-runs.js";
import { deriveStageSummary } from "../contract/selectors.js";
import type { StageKey } from "../contract/run-types.js";

/**
 * Tracks pipeline stage lifecycle in the database.
 *
 * Wraps the low-level storage helpers with run-scoped state (active stages,
 * family count) so the orchestrator doesn't have to thread those through
 * every call.
 */
export class RunTracker {
  readonly runId: string;
  private readonly db: Database.Database;
  private readonly activeStages = new Set<string>();
  private totalProcessableFamilies = 0;

  constructor(db: Database.Database, runId: string) {
    this.db = db;
    this.runId = runId;
  }

  setTotalFamilies(n: number): void {
    this.totalProcessableFamilies = n;
  }

  stageStart(stageKey: StageKey, familyIndex = 0, logPath?: string): void {
    if (familyIndex > 0) {
      ensureFamilyStageRow(this.db, this.runId, stageKey, familyIndex, logPath);
    }
    const key = `${stageKey}:${String(familyIndex)}`;
    this.activeStages.add(key);
    updateStageStatus(this.db, this.runId, stageKey, "running", {
      familyIndex,
      startedAt: new Date().toISOString(),
      processId: process.pid,
    });
    if (familyIndex === 0) {
      setRunStatus(this.db, this.runId, "running", stageKey);
    }
  }

  stageSuccess(
    stageKey: StageKey,
    familyIndex: number,
    artifacts: {
      primaryArtifactPath?: string;
      reportArtifactPath?: string;
      manifestPath?: string;
      inputArtifactPath?: string;
    },
  ): void {
    const key = `${stageKey}:${String(familyIndex)}`;
    this.activeStages.delete(key);
    const summary = deriveStageSummary(stageKey, artifacts.primaryArtifactPath);
    updateStageStatus(this.db, this.runId, stageKey, "succeeded", {
      familyIndex,
      ...artifacts,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      ...(summary ? { summary } : {}),
    });
  }

  stageBlocked(
    stageKey: StageKey,
    familyIndex: number,
    message: string,
  ): void {
    updateStageStatus(this.db, this.runId, stageKey, "blocked", {
      familyIndex,
      errorMessage: message,
      finishedAt: new Date().toISOString(),
      exitCode: 1,
    });
  }

  runFailed(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    for (const key of this.activeStages) {
      const [stageKey, fi] = key.split(":") as [StageKey, string];
      updateStageStatus(this.db, this.runId, stageKey, "failed", {
        familyIndex: parseInt(fi, 10),
        errorMessage: msg,
        finishedAt: new Date().toISOString(),
        exitCode: 1,
      });
    }
    setRunStatus(this.db, this.runId, "failed");
  }

  blockPendingFamilyStages(message: string): void {
    const stageKeys: StageKey[] = [
      "extract",
      "classify",
      "evidence",
      "curate",
      "adjudicate",
    ];
    for (const stageKey of stageKeys) {
      for (
        let familyIndex = 0;
        familyIndex < this.totalProcessableFamilies;
        familyIndex++
      ) {
        const stage = getRunStage(this.db, this.runId, stageKey, familyIndex);
        if (stage?.status === "not_started") {
          this.stageBlocked(stageKey, familyIndex, message);
        }
      }
    }
  }

  /** Handle SIGINT/SIGTERM: mark active stages interrupted, close DB. */
  handleSignal(): void {
    for (const key of this.activeStages) {
      const [stageKey, fi] = key.split(":") as [StageKey, string];
      markRunInterrupted(
        this.db,
        this.runId,
        stageKey,
        "Interrupted by signal.",
      );
      if (fi !== "0") {
        updateStageStatus(this.db, this.runId, stageKey, "interrupted", {
          familyIndex: parseInt(fi, 10),
          errorMessage: "Interrupted by signal.",
          finishedAt: new Date().toISOString(),
        });
      }
    }
    this.db.close();
    process.exit(130);
  }

  succeededArtifact(
    stageKey: StageKey,
    hasExistingRun: boolean,
  ): string | undefined {
    if (!hasExistingRun) return undefined;
    const stage = getRunStage(this.db, this.runId, stageKey);
    return stage?.status === "succeeded" ? stage.primaryArtifactPath : undefined;
  }
}
