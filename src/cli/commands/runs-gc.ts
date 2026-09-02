import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import {
  deleteOrphanedRunArtifacts,
  findOrphanedRunArtifacts,
} from "../../pipeline/run-artifact-gc.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";

function fail(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

type RunsGcOptions = {
  runId: string | undefined;
  dryRun: boolean;
};

function parseRunsGcArgs(argv: string[]): RunsGcOptions {
  let runId: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    switch (flag) {
      case "--run-id": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          fail("Missing value for --run-id.");
        }
        runId = value;
        index++;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        printRunsGcHelp();
        process.exit(0);
        break;
      default:
        fail(
          `Unknown runs:gc flag: ${flag}. Run "runs:gc --help" for options.`,
        );
    }
  }

  return { runId, dryRun };
}

function printRunsGcHelp(): void {
  console.info(`Usage: runs:gc [--run-id <uuid>] [--dry-run]

Delete the artifact files a resumed or re-run pipeline left behind: superseded
stage attempts the run registry no longer points at, and the provenance blobs
only those attempts referenced. The current attempt of every stage, the run
inputs, logs, cost summary, and human review sidecar are never touched.

Options:
  --run-id <uuid>  Limit collection to one run (default: every registered run).
  --dry-run        Report what would be deleted without deleting it.`);
}

export function runRunsGcCommand(argv: string[]): void {
  const options = parseRunsGcArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const database = openDatabase(config.databasePath);

  try {
    runMigrations(database);
    const result = findOrphanedRunArtifacts(database, {
      ...(options.runId != null ? { runId: options.runId } : {}),
    });
    const megabytes = (result.byteCount / 1_000_000).toFixed(1);

    if (result.fileCount === 0) {
      console.info("runs:gc: no orphaned artifact files found.");
      return;
    }

    for (const run of result.runs) {
      console.info(
        `runs:gc ${run.runId}: ${String(run.stageFiles.length)} superseded stage file(s), ${String(run.provenanceFiles.length)} unreferenced provenance blob(s)`,
      );
    }
    if (options.dryRun) {
      console.info(
        `runs:gc dry-run: would delete ${String(result.fileCount)} file(s) (${megabytes} MB).`,
      );
      return;
    }
    deleteOrphanedRunArtifacts(result);
    console.info(
      `runs:gc: deleted ${String(result.fileCount)} file(s) (${megabytes} MB).`,
    );
  } finally {
    database.close();
  }
}
