import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

const migrationsDirectoryPath = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

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

  return {
    appliedMigrations: pendingMigrations.map(({ name }) => ({ name })),
  };
}
