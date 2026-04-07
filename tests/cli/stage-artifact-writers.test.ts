import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  CalibrationSet,
  ClaimDiscoveryResult,
} from "../../src/domain/types.js";
import { artifactManifestSchema } from "../../src/shared/artifact-io.js";
import {
  writeAdjudicationArtifacts,
  writeDiscoveryArtifacts,
} from "../../src/cli/stage-artifact-writers.js";

describe("stage artifact writers", () => {
  it("writes canonical discovery artifacts and manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-writers-discover-"));
    const sourcePath = join(dir, "inputs.json");

    try {
      writeFileSync(
        sourcePath,
        JSON.stringify({ dois: ["10.1234/example"] }),
        "utf8",
      );
      const result: ClaimDiscoveryResult = {
        doi: "10.1234/example",
        resolvedPaper: undefined,
        status: "completed",
        statusDetail: "Extracted 1 claims (1 findings).",
        claims: [
          {
            claimText: "Gene X increases protein Y",
            sourceSpans: ["Gene X increases protein Y in treated cells."],
            section: "Results",
            citedReferences: [],
            claimType: "finding",
            confidence: "high",
          },
        ],
        findingCount: 1,
        totalClaimCount: 1,
        llmModel: "mock-model",
        llmInputTokens: 10,
        llmOutputTokens: 5,
        llmEstimatedCostUsd: 0.01,
        ranking: undefined,
        fullTextAcquisition: {
          materializationSource: "network",
          attempts: [],
          selectedMethod: "pmc_xml",
          selectedLocatorKind: "doi_input",
          selectedUrl: "https://example.com/paper.xml",
          fullTextFormat: "jats_xml",
          failureReason: undefined,
        },
        generatedAt: "2026-04-07T00:00:00.000Z",
      };

      const artifacts = writeDiscoveryArtifacts({
        outputRoot: dir,
        stamp: "2026-04-07_001",
        results: [result],
        seeds: [{ doi: result.doi, trackedClaim: result.claims[0]!.claimText }],
        sourceArtifacts: [sourcePath],
      });

      expect(artifacts.jsonPath).toBe(
        `${dir}/00-discover/2026-04-07_001_discovery-results.json`,
      );
      expect(artifacts.mdPath).toBe(
        `${dir}/00-discover/2026-04-07_001_discovery-report.md`,
      );
      expect(artifacts.shortlistPath).toBe(
        `${dir}/00-discover/2026-04-07_001_discovery-shortlist.json`,
      );

      const manifest = artifactManifestSchema.parse(
        JSON.parse(readFileSync(artifacts.manifestPath, "utf8")) as unknown,
      );
      expect(manifest.relatedArtifacts).toContain(artifacts.mdPath);
      expect(manifest.relatedArtifacts).toContain(artifacts.shortlistPath);
      expect(manifest.sourceArtifacts[0]!.path).toBe(sourcePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes adjudication artifacts with optional agreement report", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-writers-adjudicate-"));
    const sourcePath = join(dir, "calibration.json");

    try {
      writeFileSync(sourcePath, JSON.stringify({ ok: true }), "utf8");
      const calibration: CalibrationSet = {
        seed: { doi: "10.1234/seed", trackedClaim: "Tracked claim" },
        resolvedSeedPaperTitle: "Seed Paper",
        studyMode: "all_functions_census",
        createdAt: "2026-04-07T00:00:00.000Z",
        targetSize: 1,
        records: [],
        samplingStrategy: {
          targetByMode: {},
          oversampled: [],
        },
        runTelemetry: undefined,
      };

      const artifacts = writeAdjudicationArtifacts({
        outputRoot: dir,
        stamp: "2026-04-07_002",
        result: calibration,
        sourceArtifacts: [sourcePath],
        model: "claude-opus-4-6",
        agreementMarkdown: "# Agreement\n\nLooks good.",
      });

      expect(artifacts.jsonPath).toBe(
        `${dir}/06-adjudicate/2026-04-07_002_llm-calibration.json`,
      );
      expect(artifacts.summaryPath).toBe(
        `${dir}/06-adjudicate/2026-04-07_002_llm-summary.md`,
      );
      expect(artifacts.agreementPath).toBe(
        `${dir}/06-adjudicate/2026-04-07_002_agreement-report.md`,
      );

      const manifest = artifactManifestSchema.parse(
        JSON.parse(readFileSync(artifacts.manifestPath, "utf8")) as unknown,
      );
      expect(manifest.model).toBe("claude-opus-4-6");
      expect(manifest.relatedArtifacts).toContain(artifacts.summaryPath);
      expect(manifest.relatedArtifacts).toContain(artifacts.agreementPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
