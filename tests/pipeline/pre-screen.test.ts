import { describe, expect, it } from "vitest";

import type { ResolvedPaper, Result } from "../../src/domain/types.js";
import {
  runPreScreen,
  type PreScreenAdapters,
} from "../../src/pipeline/pre-screen.js";

function makePaper(
  id: string,
  overrides: Partial<ResolvedPaper> = {},
): ResolvedPaper {
  return {
    id,
    doi: `10.1234/${id}`,
    title: `Paper ${id}`,
    authors: ["Author"],
    abstract: "Abstract text.",
    source: "openalex",
    openAccessUrl: "https://example.com/paper",
    fullTextStatus: { status: "available", source: "biorxiv_xml" },
    paperType: "article",
    referencedWorksCount: 30,
    publicationYear: 2022,
    ...overrides,
  };
}

function makeAdapters(
  papers: Record<string, ResolvedPaper>,
  citingMap: Record<string, string[]>,
): PreScreenAdapters {
  return {
    resolveByDoi: (doi: string): Promise<Result<ResolvedPaper>> => {
      for (const paper of Object.values(papers)) {
        if (paper.doi === doi)
          return Promise.resolve({ ok: true, data: paper });
      }
      return Promise.resolve({ ok: false, error: `Not found: ${doi}` });
    },
    getCitingPapers: (openAlexId: string): Promise<Result<ResolvedPaper[]>> => {
      const ids = citingMap[openAlexId] ?? [];
      const results = ids
        .map((cid) => papers[cid])
        .filter((p): p is ResolvedPaper => p != null);
      return Promise.resolve({ ok: true, data: results });
    },
  };
}

describe("runPreScreen", () => {
  it("greenlights a seed with enough auditable edges", async () => {
    const seed = makePaper("seed-1");
    const citing1 = makePaper("citing-1");
    const citing2 = makePaper("citing-2");
    const citing3 = makePaper("citing-3");

    const adapters = makeAdapters(
      {
        "seed-1": seed,
        "citing-1": citing1,
        "citing-2": citing2,
        "citing-3": citing3,
      },
      { "seed-1": ["citing-1", "citing-2", "citing-3"] },
    );

    const results = await runPreScreen(
      [{ doi: "10.1234/seed-1", trackedClaim: "Gene X does Y" }],
      adapters,
    );

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.decision).toBe("greenlight");
    expect(result.metrics.totalEdges).toBe(3);
    expect(result.metrics.auditableStructuredEdges).toBe(3);
    expect(result.metrics.auditableCoverage).toBe(1);
  });

  it("deprioritizes when too few auditable edges", async () => {
    const seed = makePaper("seed-1");
    const closed1 = makePaper("closed-1", {
      fullTextStatus: { status: "unavailable", reason: "Paywalled" },
    });
    const closed2 = makePaper("closed-2", {
      fullTextStatus: { status: "unavailable", reason: "Paywalled" },
    });

    const adapters = makeAdapters(
      { "seed-1": seed, "closed-1": closed1, "closed-2": closed2 },
      { "seed-1": ["closed-1", "closed-2"] },
    );

    const results = await runPreScreen(
      [{ doi: "10.1234/seed-1", trackedClaim: "Gene X does Y" }],
      adapters,
    );

    const result = results[0]!;
    expect(result.decision).toBe("deprioritize");
    expect(result.metrics.notAuditableEdges).toBe(2);
    expect(result.metrics.auditableStructuredEdges).toBe(0);
    expect(result.metrics.auditablePdfEdges).toBe(0);
  });

  it("deprioritizes when seed cannot be resolved", async () => {
    const adapters = makeAdapters({}, {});

    const results = await runPreScreen(
      [{ doi: "10.1234/missing", trackedClaim: "Unknown claim" }],
      adapters,
    );

    const result = results[0]!;
    expect(result.decision).toBe("deprioritize");
    expect(result.resolvedSeedPaper).toBeUndefined();
    expect(result.decisionReason).toContain("resolve");
  });

  it("handles mixed auditability across edges", async () => {
    const seed = makePaper("seed-1");
    const open1 = makePaper("open-1");
    const open2 = makePaper("open-2");
    const open3 = makePaper("open-3");
    const partial = makePaper("partial-1", {
      fullTextStatus: { status: "abstract_only" },
    });
    const closed = makePaper("closed-1", {
      fullTextStatus: { status: "unavailable", reason: "Paywalled" },
    });

    const adapters = makeAdapters(
      {
        "seed-1": seed,
        "open-1": open1,
        "open-2": open2,
        "open-3": open3,
        "partial-1": partial,
        "closed-1": closed,
      },
      { "seed-1": ["open-1", "open-2", "open-3", "partial-1", "closed-1"] },
    );

    const results = await runPreScreen(
      [{ doi: "10.1234/seed-1", trackedClaim: "Gene X does Y" }],
      adapters,
    );

    const result = results[0]!;
    expect(result.decision).toBe("greenlight");
    expect(result.metrics.totalEdges).toBe(5);
    expect(result.metrics.auditableStructuredEdges).toBe(3);
    expect(result.metrics.partiallyAuditableEdges).toBe(1);
    expect(result.metrics.notAuditableEdges).toBe(1);
    expect(result.metrics.auditableCoverage).toBe(0.6);
  });

  it("processes multiple seeds independently", async () => {
    const seed1 = makePaper("seed-1");
    const seed2 = makePaper("seed-2");
    const citing = makePaper("citing-1");

    const adapters = makeAdapters(
      { "seed-1": seed1, "seed-2": seed2, "citing-1": citing },
      { "seed-1": ["citing-1"], "seed-2": [] },
    );

    const results = await runPreScreen(
      [
        { doi: "10.1234/seed-1", trackedClaim: "Claim A" },
        { doi: "10.1234/seed-2", trackedClaim: "Claim B" },
      ],
      adapters,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.decision).toBe("deprioritize");
    expect(results[1]!.decision).toBe("deprioritize");
  });
});
