import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseDatabaseGcArgs } from "../../src/cli/commands/db-gc.js";
import { purgeOldRuns } from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import {
  countExpiredBatchRequests,
  pruneExpiredBatchRequests,
} from "../../src/storage/llm-batch-requests.js";
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
  it("prunes batch request rows past the 29-day results retention", () => {
    const database = openDatabase(join(tempDirectory, "gc-batch.sqlite"));
    try {
      runMigrations(database);
      const insert = database.prepare(
        "INSERT INTO llm_batch_requests (custom_id, batch_id, submitted_at) VALUES (?, 'msgbatch_x', ?)",
      );
      const daysAgo = (days: number) =>
        new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
      insert.run("expired", daysAgo(30));
      insert.run("recent", daysAgo(28));

      expect(countExpiredBatchRequests(database)).toBe(1);
      expect(pruneExpiredBatchRequests(database)).toBe(1);
      expect(
        database.prepare("SELECT custom_id FROM llm_batch_requests").all(),
      ).toEqual([{ custom_id: "recent" }]);
    } finally {
      database.close();
    }
  });
});
