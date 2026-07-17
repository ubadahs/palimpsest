import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildStageArtifactStem,
  resolveStageArtifactPaths,
  resolveStageExtraArtifactPath,
  resolveStageOutputDir,
} from "../../src/cli/stage-output.js";

describe("stage-output helpers", () => {
  it("resolves canonical stage directories", () => {
    const root = "/tmp/palimpsest-run";

    expect(resolveStageOutputDir(root, "discover")).toBe(
      "/tmp/palimpsest-run/00-discover",
    );
    expect(resolveStageOutputDir(root, "adjudicate")).toBe(
      "/tmp/palimpsest-run/04-adjudicate",
    );
    expect(resolveStageOutputDir(root, "report")).toBe(
      "/tmp/palimpsest-run/05-report",
    );
  });

  it("builds one artifact stem per stage", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-output-"));

    try {
      const preparePaths = resolveStageArtifactPaths(
        dir,
        "prepare",
        "2026-04-07_003",
      );

      expect(buildStageArtifactStem("2026-04-07_003")).toBe("2026-04-07_003");
      expect(preparePaths.primaryPath).toBe(
        `${dir}/02-prepare/2026-04-07_003_canonical-prepare.json`,
      );
      expect(
        resolveStageExtraArtifactPath(
          dir,
          "prepare",
          "2026-04-07_003",
          "_inspection.md",
        ),
      ).toBe(`${dir}/02-prepare/2026-04-07_003_inspection.md`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
