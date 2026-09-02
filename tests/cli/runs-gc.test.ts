import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectRunArtifacts } from "../../src/cli/commands/runs-gc.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import {
  createAnalysisRun,
  setRunStatus,
  updateStageStatus,
} from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("runs:gc command", () => {
  it("reports without deleting under --dry-run, then deletes without it", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-gc-cli-"));
    tempRoots.push(root);
    const database = openDatabase(join(root, "gc.sqlite"));
    runMigrations(database);
    const runRoot = join(root, "data", "runs", "run-1");

    try {
      createAnalysisRun(database, {
        id: "run-1",
        seedDoi: "10.1234/seed",
        seedDois: ["10.1234/seed"],
        targetStage: "report",
        runRoot,
        config: analysisRunConfigSchema.parse({}),
      });
      setRunStatus(database, "run-1", "succeeded");
      const discoverDir = join(runRoot, "00-discover");
      mkdirSync(discoverDir, { recursive: true });
      const superseded = join(
        discoverDir,
        "20260902T100000Z_first_canonical-discover.json",
      );
      const current = join(
        discoverDir,
        "20260902T110000Z_second_canonical-discover.json",
      );
      writeFileSync(superseded, "{}", "utf8");
      writeFileSync(current, "{}", "utf8");
      updateStageStatus(database, "run-1", "discover", "succeeded", {
        primaryArtifactPath: current,
      });

      const lines: string[] = [];
      const dryRun = collectRunArtifacts(
        database,
        { runId: undefined, dryRun: true },
        (line) => lines.push(line),
      );
      expect(dryRun.fileCount).toBe(1);
      expect(lines.at(-1)).toMatch(/dry-run: would delete 1 file/);
      expect(existsSync(superseded)).toBe(true);

      collectRunArtifacts(
        database,
        { runId: "run-1", dryRun: false },
        () => {},
      );
      expect(existsSync(superseded)).toBe(false);
      expect(existsSync(current)).toBe(true);

      const nothingLeft = collectRunArtifacts(
        database,
        { runId: undefined, dryRun: false },
        (line) => lines.push(line),
      );
      expect(nothingLeft.fileCount).toBe(0);
      expect(lines.at(-1)).toMatch(/no orphaned artifact files/);
    } finally {
      database.close();
    }
  });
});
