import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { isRunKept, keepRun, releaseRun } from "../../pipeline/run-keep.js";
import { getAnalysisRun } from "../../storage/analysis-runs.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";

const USAGE = `Usage: runs:keep --run-id <uuid> [--reason <text>] [--release]

Keep a run from cleanup: runs:gc leaves its superseded attempts and their
provenance, and db:gc leaves its registry row.
--release makes the run ordinary again.`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exitCode = 1;
  throw new Error(message);
}

export function parseRunsKeepArgs(argv: readonly string[]): {
  runId: string;
  reason: string;
  release: boolean;
} {
  const values = new Map<string, string>();
  let release = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--release" && !release) {
      release = true;
      continue;
    }
    if (!["--run-id", "--reason"].includes(flag) || values.has(flag))
      throw new Error(USAGE);
    const value = argv[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(USAGE);
    values.set(flag, value);
  }
  const runId = values.get("--run-id");
  if (!runId || (release && values.has("--reason"))) throw new Error(USAGE);
  return { runId, reason: values.get("--reason") ?? "kept by hand", release };
}

export function runRunsKeepCommand(argv: readonly string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.info(USAGE);
    return;
  }
  const { runId, reason, release } = parseRunsKeepArgs(argv);
  const database = openDatabase(
    createAppConfig(loadEnvironment()).databasePath,
  );
  try {
    runMigrations(database);
    const run = getAnalysisRun(database, runId) ?? fail(`Unknown run ${runId}`);
    if (release) releaseRun(run.runRoot);
    else keepRun(run.runRoot, reason);
    console.info(
      `runs:keep ${runId}: ${isRunKept(run.runRoot) ? "kept" : "not kept"}`,
    );
  } finally {
    database.close();
  }
}
