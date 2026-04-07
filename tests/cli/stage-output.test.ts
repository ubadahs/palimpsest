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
      "/tmp/palimpsest-run/06-adjudicate",
    );
  });

  it("builds family-specific canonical artifact names", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-output-"));

    try {
      const extractPaths = resolveStageArtifactPaths(
        dir,
        "extract",
        "2026-04-07_003",
        1,
      );

      expect(buildStageArtifactStem("2026-04-07_003")).toBe("2026-04-07_003");
      expect(buildStageArtifactStem("2026-04-07_003", 1)).toBe(
        "2026-04-07_003_family-2",
      );
      expect(extractPaths.primaryPath).toBe(
        `${dir}/02-extract/2026-04-07_003_family-2_m2-extraction-results.json`,
      );
      expect(extractPaths.reportPath).toBe(
        `${dir}/02-extract/2026-04-07_003_family-2_m2-extraction-report.md`,
      );
      expect(
        resolveStageExtraArtifactPath(
          dir,
          "extract",
          "2026-04-07_003",
          "_m2-inspection.md",
          1,
        ),
      ).toBe(`${dir}/02-extract/2026-04-07_003_family-2_m2-inspection.md`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
