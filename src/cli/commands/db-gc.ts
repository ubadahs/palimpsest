import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { purgeOldRuns } from "../../storage/analysis-runs.js";
import {
  openDatabase,
  type DatabaseConnection,
} from "../../storage/database.js";
import {
  BATCH_RESULTS_RETENTION_DAYS,
  countExpiredBatchRequests,
  pruneExpiredBatchRequests,
} from "../../storage/llm-batch-requests.js";
import { evictStaleLLMCache } from "../../storage/llm-result-cache.js";
import { runMigrations } from "../../storage/migration-service.js";

function fail(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${flag}.`);
  }
  return value;
}

function readPositiveInteger(
  argv: string[],
  index: number,
  flag: string,
): number {
  const value = readValue(argv, index, flag);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${flag} must be a positive integer; received "${value}".`);
  }
  return parsed;
}

export type DatabaseGcOptions = {
  days: number;
  dryRun: boolean;
};

export function parseDatabaseGcArgs(argv: string[]): DatabaseGcOptions {
  let days = 90;
  let dryRun = false;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    switch (flag) {
      case "--days":
        days = readPositiveInteger(argv, index, flag);
        index++;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        printDatabaseGcHelp();
        process.exit(0);
        break;
      default:
        fail(`Unknown db:gc flag: ${flag}. Run "db:gc --help" for options.`);
    }
  }

  return { days, dryRun };
}

function printDatabaseGcHelp(): void {
  console.info(`Usage: db:gc [--days <n>] [--dry-run]

Delete aged analysis-run registry rows, stale LLM exact-result cache rows, and
Message Batches request rows past the API's ${String(BATCH_RESULTS_RETENTION_DAYS)}-day results retention
from the local SQLite database. Does not delete on-disk run artifact directories
under data/runs/, and never deletes stored seed codebooks.

Options:
  --days <n>   Retention window in days (default 90). Deletes succeeded,
               failed, and interrupted runs whose updated_at is older than
               this window, plus llm_result_cache rows older than the window
               (by last_hit_at, or created_at if never hit). Batch request
               rows always use the ${String(BATCH_RESULTS_RETENTION_DAYS)}-day results retention instead.
  --dry-run    Report how many rows would be deleted without deleting.`);
}

/**
 * Deletes aged run registry rows, stale exact-result cache rows, and expired
 * batch request rows. Stored seed codebooks are not garbage: they keep
 * codebook entries fixed across runs, so `db:gc` never touches them.
 */
export function collectDatabaseGarbage(
  database: DatabaseConnection,
  days: number,
): { deletedRuns: number; evictedCache: number; prunedBatch: number } {
  return {
    deletedRuns: purgeOldRuns(database, days),
    evictedCache: evictStaleLLMCache(database, days),
    prunedBatch: pruneExpiredBatchRequests(database),
  };
}

export function runDatabaseGcCommand(argv: string[]): void {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    printDatabaseGcHelp();
    return;
  }

  const options = parseDatabaseGcArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const database = openDatabase(config.databasePath);

  try {
    runMigrations(database);

    if (options.dryRun) {
      const runCount = (
        database
          .prepare(
            `SELECT COUNT(*) AS n FROM analysis_runs
             WHERE status IN ('succeeded', 'failed', 'interrupted')
               AND updated_at < datetime('now', ? || ' days')`,
          )
          .get(`-${String(options.days)}`) as { n: number }
      ).n;
      const cacheCount = (
        database
          .prepare(
            `SELECT COUNT(*) AS n FROM llm_result_cache
             WHERE COALESCE(last_hit_at, created_at) < datetime('now', ? || ' days')`,
          )
          .get(`-${String(options.days)}`) as { n: number }
      ).n;
      const batchCount = countExpiredBatchRequests(database);
      console.info(
        `db:gc dry-run (${options.days} days): would delete ${runCount} analysis run(s), ${cacheCount} LLM cache row(s), and ${batchCount} expired batch request row(s) from ${config.databasePath}. Artifact directories under data/runs/ are not touched.`,
      );
      return;
    }

    const { deletedRuns, evictedCache, prunedBatch } = collectDatabaseGarbage(
      database,
      options.days,
    );
    console.info(
      `db:gc (${options.days} days): deleted ${deletedRuns} analysis run(s), ${evictedCache} LLM cache row(s), and ${prunedBatch} expired batch request row(s) from ${config.databasePath}. Artifact directories under data/runs/ were not touched.`,
    );
  } finally {
    database.close();
  }
}
