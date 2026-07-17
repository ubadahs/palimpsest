import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/storage/database.js";
import {
  purgeUnsupportedAnalysisRuns,
  runMigrations,
} from "../../src/storage/migration-service.js";

describe("runMigrations", () => {
  let tempDirectory = "";

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "palimpsest-"));
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("applies the initial schema and stays idempotent", () => {
    const databasePath = join(tempDirectory, "test.sqlite");
    const database = openDatabase(databasePath);

    try {
      const firstRun = runMigrations(database);
      const secondRun = runMigrations(database);
      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      const tableRows = tables.all() as Array<{ name: string }>;
      const tableNames = tableRows.map(({ name }) => name);

      expect(firstRun.appliedMigrations.map(({ name }) => name)).toContain(
        "0001_init.sql",
      );
      expect(firstRun.appliedMigrations.map(({ name }) => name)).toContain(
        "0011_purge_pre_canonical_runs.sql",
      );
      expect(secondRun.appliedMigrations).toHaveLength(0);
      expect(tableNames).toEqual(
        expect.arrayContaining(["citations", "papers", "schema_migrations"]),
      );
    } finally {
      database.close();
    }
  });

  it("purges unsupported pre-canonical analysis runs while keeping caches", () => {
    const databasePath = join(tempDirectory, "purge.sqlite");
    const database = openDatabase(databasePath);
    try {
      runMigrations(database);
      database.exec(`
        INSERT INTO analysis_runs (
          id, seed_doi, tracked_claim, target_stage, status, current_stage,
          run_root, config_json
        ) VALUES (
          'legacy-run',
          '10.1234/seed',
          NULL,
          'screen',
          'succeeded',
          NULL,
          '${tempDirectory}/legacy',
          '{"stopAfterStage":"screen","adjudicateAdvisor":true}'
        );
        INSERT INTO analysis_run_stages (
          run_id, stage_key, stage_order, family_index, status
        ) VALUES (
          'legacy-run', 'screen', 2, 0, 'succeeded'
        );
        INSERT INTO paper_cache (
          paper_id, doi, title, access_status, fetch_status, fetched_at
        ) VALUES (
          'paper-1', '10.1234/seed', 'Seed', 'open', 'ok', '2026-07-17T00:00:00Z'
        );
      `);

      const purged = purgeUnsupportedAnalysisRuns(database);
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(
        database
          .prepare("SELECT COUNT(*) AS n FROM analysis_runs WHERE id = ?")
          .get("legacy-run") as { n: number },
      ).toEqual({ n: 0 });
      expect(
        database.prepare("SELECT COUNT(*) AS n FROM paper_cache").get() as {
          n: number;
        },
      ).toEqual({ n: 1 });
    } finally {
      database.close();
    }
  });
});
