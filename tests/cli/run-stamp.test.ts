import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  nextRunStamp,
  nextRunStampFromDirectories,
} from "../../src/cli/run-stamp.js";

describe("run-stamp", () => {
  it("increments within a single directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-stamp-"));
    const today = new Date().toISOString().slice(0, 10);

    try {
      writeFileSync(join(dir, `${today}_002_example.json`), "{}", "utf8");

      expect(nextRunStamp(dir)).toBe(`${today}_003`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("increments across multiple stage directories", () => {
    const root = mkdtempSync(join(tmpdir(), "run-stamp-multi-"));
    const today = new Date().toISOString().slice(0, 10);
    const discoverDir = join(root, "00-discover");
    const classifyDir = join(root, "03-classify");

    try {
      mkdirSync(discoverDir, { recursive: true });
      mkdirSync(classifyDir, { recursive: true });
      writeFileSync(
        join(discoverDir, `${today}_001_discovery-results.json`),
        "{}",
        "utf8",
      );
      writeFileSync(
        join(classifyDir, `${today}_004_classification-results.json`),
        "{}",
        "utf8",
      );

      expect(nextRunStampFromDirectories([discoverDir, classifyDir])).toBe(
        `${today}_005`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
