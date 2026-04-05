import { loadEnvironmentLenient } from "citation-fidelity/config";
import { openDatabase, runMigrations, type DatabaseConnection } from "citation-fidelity/storage";
import { resolve } from "node:path";

import { getRepoRoot } from "./root-path";

declare global {
  var __citationFidelityUiDatabase: DatabaseConnection | undefined;
}

export function getDatabase(): DatabaseConnection {
  if (globalThis.__citationFidelityUiDatabase) {
    return globalThis.__citationFidelityUiDatabase;
  }

  const repoRoot = getRepoRoot();
  const environment = loadEnvironmentLenient(process.env, { cwd: repoRoot });
  const database = openDatabase(
    resolve(repoRoot, environment.CITATION_FIDELITY_DB_PATH),
  );
  runMigrations(database);
  globalThis.__citationFidelityUiDatabase = database;
  return database;
}
