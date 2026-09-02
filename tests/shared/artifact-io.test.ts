import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  loadJsonArtifact,
  manifestPathForArtifact,
} from "../../src/shared/artifact-io.js";

const sampleSchema = z
  .object({
    seeds: z.array(
      z.object({
        doi: z.string().min(1),
        trackedClaim: z.string().min(1),
      }),
    ),
  })
  .strict();

describe("artifact-io", () => {
  it("loads validated JSON artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-io-"));
    const path = join(dir, "sample.json");
    writeFileSync(
      path,
      JSON.stringify({
        seeds: [{ doi: "10.1234/test", trackedClaim: "Claim" }],
      }),
      "utf8",
    );

    const result = loadJsonArtifact(path, sampleSchema, "sample input");
    expect(result.seeds).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("reports schema paths for invalid artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-io-"));
    const path = join(dir, "bad-sample.json");
    writeFileSync(
      path,
      JSON.stringify({ seeds: [{ doi: "10.1234/test" }] }),
      "utf8",
    );

    expect(() => loadJsonArtifact(path, sampleSchema, "sample input")).toThrow(
      /trackedClaim/,
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it("names a manifest beside its artifact", () => {
    expect(manifestPathForArtifact("/runs/a/00-discover/x_stage.json")).toBe(
      "/runs/a/00-discover/x_stage_manifest.json",
    );
  });
});
