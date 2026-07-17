import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

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
  /** Exact DOI input order persisted for canonical Discover and resume. */
  seedDois: [string, ...string[]];
  /** Manual claim ingestion is not supported by canonical DOI-first runs. */
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
  if (input.trackedClaim?.trim()) {
    throw new Error(
      "Manual shortlist/tracked-claim ingestion is not supported; canonical runs must start from a DOI.",
    );
  }
  const config = analysisRunConfigSchema.parse(input.config);
  if (input.seedDois[0] !== input.seedDoi) {
    throw new Error(
      "seedDois must be nonempty and its first DOI must equal seedDoi.",
    );
  }
  const normalizedDois = input.seedDois.map((doi) =>
    doi
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""),
  );
  if (normalizedDois.some((doi) => doi.length === 0)) {
    throw new Error("seedDois must not contain blank DOI values.");
  }
  if (new Set(normalizedDois).size !== normalizedDois.length) {
    throw new Error("seedDois must not contain duplicate normalized DOIs.");
  }
  const runRoot = resolve(input.runRoot);
  const inputDirectory = resolve(runRoot, "inputs");
  mkdirSync(inputDirectory, { recursive: true });

  writeFileSync(
    resolve(inputDirectory, "dois.json"),
    `${JSON.stringify({ dois: input.seedDois }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

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

  database.transaction(() => {
    insertRun.run(
      input.id,
      input.seedDoi,
      null,
      input.targetStage,
      "queued",
      null,
      runRoot,
      JSON.stringify(config),
    );

    for (const stage of stageDefinitions) {
      insertStage.run(
        input.id,
        stage.key,
        stage.order,
        "not_started",
        resolve(runRoot, "logs", `${stage.slug}.log`),
      );
    }
  })();

  return getAnalysisRun(database, input.id)!;
}

/**
 * Persist canonical resume overrides before execution so later resumes and the
 * local UI observe the same target and configuration.
 */
export function updateAnalysisRunConfig(
  database: Database.Database,
  runId: string,
  input: {
    config: AnalysisRunConfig;
    targetStage: StageKey;
  },
): AnalysisRun {
  const config = analysisRunConfigSchema.parse(input.config);
  if (config.stopAfterStage !== input.targetStage) {
    throw new Error(
      "Canonical run targetStage must equal config.stopAfterStage.",
    );
  }

  database.transaction(() => {
    const result = database
      .prepare(
        `
        UPDATE analysis_runs
        SET config_json = ?, target_stage = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      )
      .run(JSON.stringify(config), input.targetStage, runId);
    if (result.changes !== 1) {
      throw new Error(`Run not found: ${runId}`);
    }
  })();

  return getAnalysisRun(database, runId)!;
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

  // Artifact pointers and summaries are preserved unless explicitly provided.
  // Only markDownstreamStagesStale() intentionally clears them for reruns.
  database
    .prepare(
      `
      UPDATE analysis_run_stages
      SET
        status = ?,
        input_artifact_path = COALESCE(?, input_artifact_path),
        primary_artifact_path = COALESCE(?, primary_artifact_path),
        report_artifact_path = COALESCE(?, report_artifact_path),
        manifest_path = COALESCE(?, manifest_path),
        summary_json = COALESCE(?, summary_json),
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

/**
 * Invalidate `stageKey` and every later canonical stage for an explicit rerun.
 * Succeeded rows become stale; others reset to not_started. Artifact files on
 * disk are preserved (append-only); DB pointers are cleared.
 */
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
        status = CASE
          WHEN stage_order = ? THEN 'not_started'
          WHEN status = 'succeeded' THEN 'stale'
          ELSE 'not_started'
        END,
        input_artifact_path = NULL,
        primary_artifact_path = NULL,
        report_artifact_path = NULL,
        manifest_path = NULL,
        summary_json = NULL,
        error_message = NULL,
        started_at = NULL,
        finished_at = NULL,
        exit_code = NULL,
        process_id = NULL
      WHERE run_id = ? AND stage_order >= ?
    `,
    )
    .run(order, runId, order);
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
