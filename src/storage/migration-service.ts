import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

import { analysisRunConfigSchema } from "../contract/run-types.js";
import { stageKeyValues } from "../contract/lean-stages.js";

const migrationsDirectoryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const canonicalStageKeys = new Set<string>(stageKeyValues);

type MigrationFile = {
  name: string;
  sql: string;
};

type AppliedMigrationRow = {
  name: string;
};

export type AppliedMigration = {
  name: string;
};

export type MigrationRunResult = {
  appliedMigrations: AppliedMigration[];
};

function listMigrationFiles(): MigrationFile[] {
  return readdirSync(migrationsDirectoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(migrationsDirectoryPath, entry.name), "utf8"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function ensureSchemaMigrationsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function getAppliedMigrationNames(database: Database.Database): Set<string> {
  const rows = database
    .prepare("SELECT name FROM schema_migrations ORDER BY name")
    .all() as AppliedMigrationRow[];

  return new Set(rows.map((row) => row.name));
}

/**
 * Delete run-registry rows whose stored config or stage vocabulary cannot be
 * loaded by the canonical six-stage executor. Preserves paper/LLM caches.
 */
export function purgeUnsupportedAnalysisRuns(
  database: Database.Database,
): number {
  const rows = database
    .prepare("SELECT id, target_stage, config_json FROM analysis_runs")
    .all() as Array<{ id: string; target_stage: string; config_json: string }>;

  const obsoleteIds: string[] = [];
  for (const row of rows) {
    if (!canonicalStageKeys.has(row.target_stage)) {
      obsoleteIds.push(row.id);
      continue;
    }
    try {
      const config = analysisRunConfigSchema.parse(
        JSON.parse(row.config_json) as unknown,
      );
      if (config.stopAfterStage !== row.target_stage) {
        obsoleteIds.push(row.id);
      }
    } catch {
      obsoleteIds.push(row.id);
    }
  }

  if (obsoleteIds.length === 0) {
    return 0;
  }

  const deleteStages = database.prepare(
    "DELETE FROM analysis_run_stages WHERE run_id = ?",
  );
  const deleteRun = database.prepare("DELETE FROM analysis_runs WHERE id = ?");
  database.transaction(() => {
    for (const id of obsoleteIds) {
      deleteStages.run(id);
      deleteRun.run(id);
    }
  })();
  return obsoleteIds.length;
}

export function runMigrations(database: Database.Database): MigrationRunResult {
  ensureSchemaMigrationsTable(database);

  const appliedMigrationNames = getAppliedMigrationNames(database);
  const pendingMigrations = listMigrationFiles().filter(
    (migration) => !appliedMigrationNames.has(migration.name),
  );
  const insertAppliedMigration = database.prepare(
    "INSERT INTO schema_migrations (name) VALUES (?)",
  );

  for (const migration of pendingMigrations) {
    const applyMigration = database.transaction(() => {
      database.exec(migration.sql);
      insertAppliedMigration.run(migration.name);
    });

    applyMigration();
  }

  purgeUnsupportedAnalysisRuns(database);

  return {
    appliedMigrations: pendingMigrations.map(({ name }) => ({ name })),
  };
}
