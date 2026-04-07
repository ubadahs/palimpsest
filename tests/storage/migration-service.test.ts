import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";

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
      expect(secondRun.appliedMigrations).toHaveLength(0);
      expect(tableNames).toEqual(
        expect.arrayContaining(["citations", "papers", "schema_migrations"]),
      );
    } finally {
      database.close();
    }
  });
});
