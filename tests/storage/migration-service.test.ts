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
      expect(firstRun.appliedMigrations.map(({ name }) => name)).toContain(
        "0012_drop_orphan_papers_citations.sql",
      );
      expect(firstRun.appliedMigrations.map(({ name }) => name)).toContain(
        "0013_drop_write_only_columns.sql",
      );
      expect(secondRun.appliedMigrations).toHaveLength(0);
      expect(tableNames).toEqual(
        expect.arrayContaining([
          "paper_cache",
          "paper_parsed",
          "schema_migrations",
        ]),
      );
      expect(tableNames).not.toContain("papers");
      expect(tableNames).not.toContain("citations");
      expect(tableNames).not.toContain("derived_artifacts");

      // 0013 drops the write-only columns and keeps the keyed ones.
      const columnsOf = (table: string): string[] =>
        (
          database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map(({ name }) => name);
      expect(columnsOf("analysis_runs")).not.toContain("tracked_claim");
      const stageColumns = columnsOf("analysis_run_stages");
      expect(stageColumns).not.toContain("exit_code");
      expect(stageColumns).not.toContain("input_artifact_path");
      expect(stageColumns).toContain("family_index");
      const paperCacheColumns = columnsOf("paper_cache");
      expect(paperCacheColumns).not.toContain("metadata_json");
      expect(paperCacheColumns).toContain("content_hash");
      const llmCacheColumns = columnsOf("llm_result_cache");
      expect(llmCacheColumns).not.toContain("purpose");
      expect(llmCacheColumns).toContain("cache_key");
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
          id, seed_doi, target_stage, status, current_stage,
          run_root, config_json
        ) VALUES (
          'legacy-run',
          '10.1234/seed',
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
        INSERT INTO paper_cache (paper_id, raw_full_text)
        VALUES ('paper-1', '<article/>');
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
