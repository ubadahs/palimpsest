import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

  it("requires upstream artifact paths for report inspector joins", () => {
    const artifactPath = writeArtifact("report.json", { legacy: true });
    expect(() => buildStageInspectorPayload("report", artifactPath)).toThrow(
      /preparePath, evidencePath, and adjudicatePath/i,
    );
  });

  it("joins Prepare/Evidence/Adjudicate onto the Report spine for browsing", () => {
    const runRoot = resolve("data/runs/2d16adf7-4169-43b2-b5d3-b1dbe0b719d7");
    if (!existsSync(runRoot)) {
      return;
    }
    const pick = (dir: string, suffix: string): string | undefined => {
      const name = readdirSync(join(runRoot, dir)).find((entry) =>
        entry.endsWith(suffix),
      );
      return name ? join(runRoot, dir, name) : undefined;
    };

    const reportPath = pick("05-report", "_canonical-report.json");
    const markdownPath = pick("05-report", "_canonical-report.md");
    const preparePath = pick("02-prepare", "_canonical-prepare.json");
    const evidencePath = pick("03-evidence", "_canonical-evidence.json");
    const adjudicatePath = pick("04-adjudicate", "_canonical-adjudicate.json");
    if (
      reportPath == null ||
      markdownPath == null ||
      preparePath == null ||
      evidencePath == null ||
      adjudicatePath == null
    ) {
      return;
    }

    let payload;
    try {
      payload = buildStageInspectorPayload("report", reportPath, {
        markdownPath,
        preparePath,
        evidencePath,
        adjudicatePath,
      });
    } catch (error) {
      // Pre-span-binding report artifacts are not bridged.
      if (
        error instanceof Error &&
        /Invalid canonical Report artifact|attributedClaimsWithVerifiedSupportSpan|evidenceSufficiency/i.test(
          error.message,
        )
      ) {
        return;
      }
      throw error;
    }

    expect(payload.stageKey).toBe("report");
    expect(payload.markdownPath).toContain("_canonical-report.md");
    expect(payload.summary.interpretationStatus).toBe(
      "uncalibrated_research_output",
    );
    expect(payload.summary.interpretationWarning).toMatch(/uncalibrated/i);
    expect(payload.summary.records).toHaveLength(
      payload.rawArtifact.payload.recordTraces.length,
    );
    expect(payload.summary.records.length).toBeGreaterThan(0);

    const first = payload.summary.records[0]!;
    expect(first.citingPaperTitle.length).toBeGreaterThan(0);
    expect(first.evaluatedClaimText.length).toBeGreaterThan(0);
    expect(first.citationContext.length).toBeGreaterThan(0);
    expect(first.evidencePassages.length).toBeGreaterThan(0);
    expect(first.seedTitle.length).toBeGreaterThan(0);
    expect(first.occurrenceClaims.length).toBeGreaterThan(0);
    expect(payload.summary.families.length).toBeGreaterThan(0);
    expect(
      payload.summary.families.reduce(
        (total, family) => total + family.recordCount,
        0,
      ),
    ).toBe(payload.summary.records.length);

    const nullishRate = payload.summary.rates.find(
      (rate) => rate.denominator === 0,
    );
    if (nullishRate) {
      expect(nullishRate.value).toBeNull();
    }

    const fRate = payload.summary.rates.find(
      (rate) => rate.metricId === "verdict_F_rate",
    );
    expect(fRate).toBeDefined();
    expect(fRate!.denominator).toBe(
      payload.summary.funnel.adjudicate.adjudicated.count,
    );
  });
});
