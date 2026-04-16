import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import {
  claimFamilyBlocksDownstream,
  preScreenResultsSchema,
  shortlistInputSchema,
} from "../domain/pre-screen.js";
import {
  analysisRunConfigSchema,
  analysisRunSchema,
  analysisRunStageSchema,
  analysisRunStageStatusSchema,
  analysisRunStatusSchema,
  type AnalysisRun,
  type AnalysisRunConfig,
  type AnalysisRunStage,
  type AnalysisRunStageStatus,
  type AnalysisRunStatus,
  type AnalysisStageSummary,
  type StageKey,
} from "../contract/run-types.js";
import { getStageDefinition, stageDefinitions } from "../contract/stages.js";

type RunRow = {
  id: string;
  seed_doi: string;
  tracked_claim: string | null;
  target_stage: string;
  status: string;
  current_stage: string | null;
  run_root: string;
  config_json: string;
  created_at: string;
  updated_at: string;
};

type StageRow = {
  run_id: string;
  stage_key: string;
  stage_order: number;
  family_index: number;
  status: string;
  input_artifact_path: string | null;
  primary_artifact_path: string | null;
  report_artifact_path: string | null;
  manifest_path: string | null;
  log_path: string | null;
  summary_json: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  process_id: number | null;
};

export type CreateAnalysisRunInput = {
  id: string;
  seedDoi: string;
  /** If provided, discover is skipped and this claim is used directly. If absent, discover runs first. */
  trackedClaim?: string;
  targetStage: StageKey;
  runRoot: string;
  config: AnalysisRunConfig;
};

function toRun(row: RunRow): AnalysisRun {
  return analysisRunSchema.parse({
    id: row.id,
    seedDoi: row.seed_doi,
    trackedClaim: row.tracked_claim ?? undefined,
    targetStage: row.target_stage,
    status: row.status,
    currentStage: row.current_stage ?? undefined,
    runRoot: row.run_root,
    config: JSON.parse(row.config_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toStage(row: StageRow): AnalysisRunStage {
  return analysisRunStageSchema.parse({
    runId: row.run_id,
    stageKey: row.stage_key,
    stageOrder: row.stage_order,
    familyIndex: row.family_index,
    status: row.status,
    inputArtifactPath: row.input_artifact_path ?? undefined,
    primaryArtifactPath: row.primary_artifact_path ?? undefined,
    reportArtifactPath: row.report_artifact_path ?? undefined,
    manifestPath: row.manifest_path ?? undefined,
    logPath: row.log_path ?? undefined,
    summary: row.summary_json
      ? (JSON.parse(row.summary_json) as unknown)
      : undefined,
    errorMessage: row.error_message ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    processId: row.process_id ?? undefined,
  });
}

function updateRunTimestamp(database: Database.Database, runId: string): void {
  database
    .prepare(
      "UPDATE analysis_runs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run(runId);
}

export function createAnalysisRun(
  database: Database.Database,
  input: CreateAnalysisRunInput,
): AnalysisRun {
  const config = analysisRunConfigSchema.parse(input.config);
  const runRoot = resolve(input.runRoot);
  const inputDirectory = resolve(runRoot, "inputs");
  mkdirSync(inputDirectory, { recursive: true });

  const isManualClaim = Boolean(input.trackedClaim?.trim());

  if (isManualClaim) {
    // Manual claim: write shortlist directly, discover will be pre-marked succeeded.
    const shortlist = shortlistInputSchema.parse({
      seeds: [{ doi: input.seedDoi, trackedClaim: input.trackedClaim }],
    });
    writeFileSync(
      resolve(inputDirectory, "shortlist.json"),
      JSON.stringify(shortlist, null, 2),
      "utf8",
    );
  } else {
    // Auto-discover: write dois.json; shortlist will be written by discover stage.
    writeFileSync(
      resolve(inputDirectory, "dois.json"),
      JSON.stringify({ dois: [input.seedDoi] }, null, 2),
      "utf8",
    );
  }

  const insertRun = database.prepare(`
    INSERT INTO analysis_runs (
      id, seed_doi, tracked_claim, target_stage, status, current_stage, run_root, config_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertStage = database.prepare(`
    INSERT INTO analysis_run_stages (
      run_id, stage_key, stage_order, family_index, status, log_path
    ) VALUES (?, ?, ?, 0, ?, ?)
  `);

  const skippedDiscoverSummary: AnalysisStageSummary = {
    headline: "Skipped — manual claim provided",
    metrics: [],
    artifacts: [],
  };

  database.transaction(() => {
    insertRun.run(
      input.id,
      input.seedDoi,
      input.trackedClaim ?? null,
      input.targetStage,
      "queued",
      null,
      runRoot,
      JSON.stringify(config),
    );

    for (const stage of stageDefinitions) {
      // If a manual claim was given, pre-mark discover as succeeded so
      // resolveStartStage skips it and canRunFromStage permits screen.
      const stageStatus =
        isManualClaim && stage.key === "discover" ? "succeeded" : "not_started";
      const summaryJson =
        isManualClaim && stage.key === "discover"
          ? JSON.stringify(skippedDiscoverSummary)
          : null;

      insertStage.run(
        input.id,
        stage.key,
        stage.order,
        stageStatus,
        resolve(runRoot, "logs", `${stage.slug}.log`),
      );

      if (summaryJson) {
        database
          .prepare(
            "UPDATE analysis_run_stages SET summary_json = ? WHERE run_id = ? AND stage_key = ? AND family_index = 0",
          )
          .run(summaryJson, input.id, stage.key);
      }
    }
  })();

  return getAnalysisRun(database, input.id)!;
}

export function listAnalysisRuns(database: Database.Database): AnalysisRun[] {
  const rows = database
    .prepare(
      "SELECT * FROM analysis_runs ORDER BY updated_at DESC, created_at DESC",
    )
    .all() as RunRow[];

  return rows.map(toRun);
}

export function getAnalysisRun(
  database: Database.Database,
  runId: string,
): AnalysisRun | undefined {
  const row = database
    .prepare("SELECT * FROM analysis_runs WHERE id = ?")
    .get(runId) as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function listRunStages(
  database: Database.Database,
  runId: string,
): AnalysisRunStage[] {
  const rows = database
    .prepare(
      "SELECT * FROM analysis_run_stages WHERE run_id = ? ORDER BY stage_order ASC, family_index ASC",
    )
    .all(runId) as StageRow[];

  return rows.map(toStage);
}

export function getRunStage(
  database: Database.Database,
  runId: string,
  stageKey: StageKey,
  familyIndex = 0,
): AnalysisRunStage | undefined {
  const row = database
    .prepare(
      "SELECT * FROM analysis_run_stages WHERE run_id = ? AND stage_key = ? AND family_index = ?",
    )
    .get(runId, stageKey, familyIndex) as StageRow | undefined;

  return row ? toStage(row) : undefined;
}

export function setRunStatus(
  database: Database.Database,
  runId: string,
  status: AnalysisRunStatus,
  currentStage?: StageKey,
): void {
  analysisRunStatusSchema.parse(status);
  database
    .prepare(
      `
      UPDATE analysis_runs
      SET status = ?, current_stage = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .run(status, currentStage ?? null, runId);
}

export function updateStageStatus(
  database: Database.Database,
  runId: string,
  stageKey: StageKey,
  status: AnalysisRunStageStatus,
  options: {
    familyIndex?: number;
    inputArtifactPath?: string;
    primaryArtifactPath?: string;
    reportArtifactPath?: string;
    manifestPath?: string;
    summary?: AnalysisStageSummary;
    errorMessage?: string;
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
    processId?: number;
  } = {},
): void {
  analysisRunStageStatusSchema.parse(status);
  const familyIndex = options.familyIndex ?? 0;

  database
    .prepare(
      `
      UPDATE analysis_run_stages
      SET
        status = ?,
        input_artifact_path = COALESCE(?, input_artifact_path),
        primary_artifact_path = ?,
        report_artifact_path = ?,
        manifest_path = ?,
        summary_json = ?,
        error_message = ?,
        exit_code = ?,
        started_at = COALESCE(?, started_at),
        finished_at = ?,
        process_id = ?
      WHERE run_id = ? AND stage_key = ? AND family_index = ?
    `,
    )
    .run(
      status,
      options.inputArtifactPath ?? null,
      options.primaryArtifactPath ?? null,
      options.reportArtifactPath ?? null,
      options.manifestPath ?? null,
      options.summary ? JSON.stringify(options.summary) : null,
      options.errorMessage ?? null,
      options.exitCode ?? null,
      options.startedAt ?? null,
      options.finishedAt ?? null,
      options.processId ?? null,
      runId,
      stageKey,
      familyIndex,
    );

  updateRunTimestamp(database, runId);
}

export function ensureFamilyStageRow(
  database: Database.Database,
  runId: string,
  stageKey: StageKey,
  familyIndex: number,
  logPath?: string,
): void {
  const definition = getStageDefinition(stageKey);
  database
    .prepare(
      `
      INSERT OR IGNORE INTO analysis_run_stages (
        run_id, stage_key, stage_order, family_index, status, log_path
      ) VALUES (?, ?, ?, ?, 'not_started', ?)
    `,
    )
    .run(runId, stageKey, definition.order, familyIndex, logPath ?? null);
}

export function setStageInputArtifact(
  database: Database.Database,
  runId: string,
  stageKey: StageKey,
  inputArtifactPath: string,
): void {
  database
    .prepare(
      `
      UPDATE analysis_run_stages
      SET input_artifact_path = ?
      WHERE run_id = ? AND stage_key = ?
    `,
    )
    .run(inputArtifactPath, runId, stageKey);
  updateRunTimestamp(database, runId);
}

export function markDownstreamStagesStale(
  database: Database.Database,
  runId: string,
  stageKey: StageKey,
): void {
  const order = getStageDefinition(stageKey).order;
  database
    .prepare(
      `
      UPDATE analysis_run_stages
      SET
        status = CASE WHEN status = 'succeeded' THEN 'stale' ELSE status END,
        input_artifact_path = CASE WHEN stage_order > ? THEN NULL ELSE input_artifact_path END,
        primary_artifact_path = CASE WHEN stage_order > ? AND status = 'succeeded' THEN NULL ELSE primary_artifact_path END,
        report_artifact_path = CASE WHEN stage_order > ? AND status = 'succeeded' THEN NULL ELSE report_artifact_path END,
        manifest_path = CASE WHEN stage_order > ? AND status = 'succeeded' THEN NULL ELSE manifest_path END,
        summary_json = CASE WHEN stage_order > ? AND status = 'succeeded' THEN NULL ELSE summary_json END,
        error_message = CASE WHEN stage_order > ? THEN NULL ELSE error_message END,
        finished_at = CASE WHEN stage_order > ? AND status = 'succeeded' THEN NULL ELSE finished_at END,
        exit_code = CASE WHEN stage_order > ? AND status = 'succeeded' THEN NULL ELSE exit_code END,
        process_id = CASE WHEN stage_order > ? THEN NULL ELSE process_id END
      WHERE run_id = ? AND stage_order > ?
    `,
    )
    .run(
      order,
      order,
      order,
      order,
      order,
      order,
      order,
      order,
      order,
      runId,
      order,
    );
  updateRunTimestamp(database, runId);
}

export function findActiveRun(
  database: Database.Database,
): AnalysisRun | undefined {
  const row = database
    .prepare(
      `
      SELECT *
      FROM analysis_runs
      WHERE status = 'running'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get() as RunRow | undefined;

  return row ? toRun(row) : undefined;
}

export function listRunningStages(
  database: Database.Database,
): AnalysisRunStage[] {
  const rows = database
    .prepare(
      `
      SELECT *
      FROM analysis_run_stages
      WHERE status = 'running'
      ORDER BY started_at ASC
    `,
    )
    .all() as StageRow[];

  return rows.map(toStage);
}

export function markRunInterrupted(
  database: Database.Database,
  runId: string,
  stageKey: StageKey,
  message: string,
): void {
  database.transaction(() => {
    updateStageStatus(database, runId, stageKey, "interrupted", {
      errorMessage: message,
      finishedAt: new Date().toISOString(),
    });
    setRunStatus(database, runId, "interrupted", stageKey);
  })();
}

export function canRunFromStage(
  stages: AnalysisRunStage[],
  stageKey: StageKey,
): { ok: true } | { ok: false; reason: string } {
  const targetOrder = getStageDefinition(stageKey).order;

  for (const stage of stages) {
    if (stage.stageOrder >= targetOrder) {
      break;
    }

    if (stage.status !== "succeeded") {
      return {
        ok: false,
        reason: `Cannot start at ${stageKey} before ${stage.stageKey} succeeds.`,
      };
    }
  }

  return { ok: true };
}

/**
 * When pre-screen succeeded but claim grounding blocks M2+, return a human-readable reason.
 * Legacy artifacts without `claimGrounding` do not block.
 */
export function getClaimGateBlockReasonForRun(
  preScreenPrimaryArtifactPath: string | undefined,
  seedDoi: string,
): string | undefined {
  if (
    !preScreenPrimaryArtifactPath ||
    !existsSync(preScreenPrimaryArtifactPath)
  ) {
    return undefined;
  }

  try {
    const raw: unknown = JSON.parse(
      readFileSync(preScreenPrimaryArtifactPath, "utf8"),
    );
    const families = preScreenResultsSchema.parse(raw);
    const family = families.find(
      (f) => f.seed.doi.toLowerCase() === seedDoi.trim().toLowerCase(),
    );
    if (!family || !claimFamilyBlocksDownstream(family)) {
      return undefined;
    }
    const cg = family.claimGrounding;
    return `Claim grounding blocks downstream stages (${cg?.status ?? "unknown"}): ${cg?.detailReason ?? "see pre-screen report"}`;
  } catch {
    return undefined;
  }
}

export function parseStoredConfig(raw: string): AnalysisRunConfig {
  return analysisRunConfigSchema.parse(JSON.parse(raw) as unknown);
}

/**
 * Delete completed/failed/interrupted runs older than `daysOld` days.
 * Cascade deletes associated stage rows. Returns the number of deleted runs.
 */
export function purgeOldRuns(
  database: Database.Database,
  daysOld: number = 90,
): number {
  const result = database
    .prepare(
      `DELETE FROM analysis_runs
       WHERE status IN ('succeeded', 'failed', 'interrupted')
         AND updated_at < datetime('now', ? || ' days')`,
    )
    .run(`-${String(daysOld)}`);
  return result.changes;
}
