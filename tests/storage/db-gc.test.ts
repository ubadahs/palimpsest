import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseDatabaseGcArgs } from "../../src/cli/commands/db-gc.js";
import { purgeOldRuns } from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { evictStaleLLMCache } from "../../src/storage/llm-result-cache.js";
import { runMigrations } from "../../src/storage/migration-service.js";

describe("db:gc", () => {
  let tempDirectory = "";

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "palimpsest-gc-"));
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("parses retention flags", () => {
    expect(parseDatabaseGcArgs([])).toEqual({ days: 90, dryRun: false });
    expect(parseDatabaseGcArgs(["--days", "30", "--dry-run"])).toEqual({
      days: 30,
      dryRun: true,
    });
  });

  it("purges aged analysis runs and LLM cache rows only", () => {
    const database = openDatabase(join(tempDirectory, "gc.sqlite"));
    try {
      runMigrations(database);
      database.exec(`
        INSERT INTO analysis_runs (
          id, seed_doi, target_stage, status, current_stage,
          run_root, config_json, created_at, updated_at
        ) VALUES (
          'old-run',
          '10.1234/seed',
          'report',
          'succeeded',
          NULL,
          '${tempDirectory}/old',
          '{}',
          datetime('now', '-120 days'),
          datetime('now', '-120 days')
        );
        INSERT INTO analysis_runs (
          id, seed_doi, target_stage, status, current_stage,
          run_root, config_json, created_at, updated_at
        ) VALUES (
          'fresh-run',
          '10.1234/seed-2',
          'report',
          'succeeded',
          NULL,
          '${tempDirectory}/fresh',
          '{}',
          datetime('now', '-1 days'),
          datetime('now', '-1 days')
        );
      `);
      database
        .prepare(
          `INSERT INTO llm_result_cache
             (cache_key, response_text, created_at, last_hit_at)
           VALUES
             ('stale-key', '{}',
              datetime('now', '-120 days'), datetime('now', '-120 days')),
             ('fresh-key', '{}', datetime('now'), datetime('now'))`,
        )
        .run();

      expect(purgeOldRuns(database, 90)).toBe(1);
      expect(evictStaleLLMCache(database, 90)).toBe(1);
      expect(
        database
          .prepare("SELECT id FROM analysis_runs ORDER BY id")
          .all() as Array<{ id: string }>,
      ).toEqual([{ id: "fresh-run" }]);
      expect(
        database
          .prepare("SELECT cache_key FROM llm_result_cache ORDER BY cache_key")
          .all() as Array<{ cache_key: string }>,
      ).toEqual([{ cache_key: "fresh-key" }]);
    } finally {
      database.close();
    }
  });
});
