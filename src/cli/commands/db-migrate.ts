import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";

export function runDatabaseMigrateCommand(): void {
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const database = openDatabase(config.databasePath);

  try {
    const result = runMigrations(database);

    if (result.appliedMigrations.length === 0) {
      console.info(`Database is up to date: ${config.databasePath}`);
      return;
    }

    console.info(
      `Applied ${result.appliedMigrations.length} migration(s) to ${config.databasePath}`,
    );

    for (const migration of result.appliedMigrations) {
      console.info(`- ${migration.name}`);
    }
  } finally {
    database.close();
  }
}
