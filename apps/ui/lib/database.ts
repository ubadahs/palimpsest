import { loadEnvironmentLenient } from "palimpsest/config";
import {
  openDatabase,
  runMigrations,
  type DatabaseConnection,
} from "palimpsest/storage";
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
    resolve(repoRoot, environment.PALIMPSEST_DB_PATH),
  );
  runMigrations(database);
  globalThis.__citationFidelityUiDatabase = database;
  return database;
}
