import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildStageInspectorPayload,
  deriveCanonicalStageSummary,
  deriveCanonicalStageSummaryFromPath,
  listStageArtifacts,
} from "../../src/contract/selectors.js";

describe("canonical selectors", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "palimpsest-selectors-"));
  });

  it("discovers only canonical artifact suffixes", () => {
    writeArtifact("2026-04-07_003_extraction-results.json", {});
    writeArtifact("2026-04-07_003_canonical-prepare.json", {});
    writeFileSync(
      join(tempRoot, "2026-04-07_003_canonical-prepare.md"),
      "# Not a canonical report\n",
      "utf8",
    );

    const artifacts = listStageArtifacts("prepare", tempRoot);

    expect(artifacts.primaryArtifactPath).toBe(
      join(tempRoot, "2026-04-07_003_canonical-prepare.json"),
    );
    expect(artifacts.reportArtifactPath).toBeUndefined();
    expect(artifacts.extraArtifacts).toEqual([]);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeArtifact(name: string, payload: unknown): string {
    const path = join(tempRoot, name);
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
    return path;
  }

  it("accepts only validated canonical artifacts for summaries and inspection", () => {
    const artifactPath = writeArtifact("invalid.json", { legacy: true });

    expect(() => buildStageInspectorPayload("discover", artifactPath)).toThrow(
      /Invalid canonical Discover/i,
    );
    expect(() =>
      deriveCanonicalStageSummaryFromPath("discover", artifactPath),
    ).toThrow(/Invalid canonical Discover/i);

    // The overload remains constrained to the six canonical stage artifacts.
    expect(deriveCanonicalStageSummary).toBeTypeOf("function");
  });
});
