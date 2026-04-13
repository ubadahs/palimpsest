import { describe, expect, it } from "vitest";

import type {
  ClaimFamilyPreScreen,
  ResolvedPaper,
} from "../../src/domain/types.js";
import { runM2Extraction } from "../../src/pipeline/extract.js";
import type { ExtractionAdapters } from "../../src/retrieval/citation-context.js";

const GROBID_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI>
  <text>
    <body>
      <div>
        <head>Results</head>
        <p><ref type="bibr" target="#b1">Seed Author et al. 2020</ref> provided the foundational result used here.</p>
      </div>
    </body>
  </text>
  <back>
    <listBibl>
      <biblStruct xml:id="b1">
        <analytic>
          <title level="a">The Seed Paper</title>
          <author><persName><surname>Seed</surname></persName></author>
        </analytic>
        <monogr>
          <imprint><date when="2020"/></imprint>
        </monogr>
      </biblStruct>
    </listBibl>
  </back>
</TEI>`;

function makeSeedPaper(): ResolvedPaper {
  return {
    id: "seed-1",
    title: "The Seed Paper",
    doi: undefined,
    authors: ["Seed Author"],
    abstract: undefined,
    source: "openalex",
    fullTextHints: {
      providerAvailability: "available",
      providerSourceHint: "pdf",
    },
    paperType: "article",
    referencedWorksCount: 40,
    publicationYear: 2020,
  };
}

function makeCitingPaper(id: string, available: boolean): ResolvedPaper {
  return {
    id,
    title: `Citing Paper ${id}`,
    doi: undefined,
    authors: ["Author A"],
    abstract: undefined,
    source: "openalex",
    fullTextHints: available
      ? {
          providerAvailability: "available" as const,
          providerSourceHint: "pdf",
          pdfUrl: `https://example.com/${id}.pdf`,
          repositoryUrl: `https://example.com/${id}.pdf`,
        }
      : {
          providerAvailability: "unavailable" as const,
          providerReason: "Paywalled",
        },
    paperType: "article",
    referencedWorksCount: 25,
    publicationYear: 2022,
  };
}

function makeFamily(
  auditableCount: number,
  notAuditableCount: number,
): ClaimFamilyPreScreen {
  const seedPaper = makeSeedPaper();
  const resolvedPapers: Record<string, ResolvedPaper> = {
    [seedPaper.id]: seedPaper,
  };
  const edges = [];
  const classification = {
    isReview: false,
    isCommentary: false,
    isLetter: false,
    isBookChapter: false,
    isPreprint: false,
    isJournalArticle: true,
    isPrimaryLike: true,
    highReferenceCount: false,
  };

  for (let i = 0; i < auditableCount; i++) {
    const id = `aud-${String(i)}`;
    const paper = makeCitingPaper(id, true);
    resolvedPapers[id] = paper;
    edges.push({
      citingPaperId: id,
      citedPaperId: seedPaper.id,
      auditabilityStatus: "auditable_structured" as const,
      auditabilityReason: "Structured",
      classification,
      paperType: "article" as const,
      referencedWorksCount: 25,
    });
  }

  for (let i = 0; i < notAuditableCount; i++) {
    const id = `noaud-${String(i)}`;
    const paper = makeCitingPaper(id, false);
    resolvedPapers[id] = paper;
    edges.push({
      citingPaperId: id,
      citedPaperId: seedPaper.id,
      auditabilityStatus: "not_auditable" as const,
      auditabilityReason: "Paywalled",
      classification,
      paperType: "article" as const,
      referencedWorksCount: 25,
    });
  }

  const metrics = {
    totalEdges: auditableCount + notAuditableCount,
    uniqueEdges: auditableCount + notAuditableCount,
    collapsedDuplicates: 0,
    auditableStructuredEdges: auditableCount,
    auditablePdfEdges: 0,
    partiallyAuditableEdges: 0,
    notAuditableEdges: notAuditableCount,
    auditableCoverage:
      auditableCount / (auditableCount + notAuditableCount || 1),
    primaryLikeEdgeCount: auditableCount + notAuditableCount,
    primaryLikeEdgeRate: 1,
    reviewEdgeCount: 0,
    reviewEdgeRate: 0,
    commentaryEdgeCount: 0,
    commentaryEdgeRate: 0,
    letterEdgeCount: 0,
    letterEdgeRate: 0,
    bookChapterEdgeCount: 0,
    bookChapterEdgeRate: 0,
    articleEdgeCount: auditableCount + notAuditableCount,
    articleEdgeRate: 1,
    preprintEdgeCount: 0,
    preprintEdgeRate: 0,
  };

  const claimGrounding = {
    status: "grounded" as const,
    analystClaim: "Test claim",
    normalizedClaim: "Test claim",
    supportSpans: [
      {
        text: "Test claim is supported in results.",
        sectionTitle: "Results",
        blockKind: "body_paragraph" as const,
        bm25Score: 2.5,
      },
    ],
    blocksDownstream: false,
    detailReason: "Fixture grounding.",
  };

  return {
    seed: { doi: "10.1234/seed", trackedClaim: "Test claim" },
    resolvedSeedPaper: seedPaper,
    edges: edges.map((e) => ({
      ...e,
      inClaimFamily: true,
      claimRelevanceScore: 1,
    })),
    resolvedPapers,
    duplicateGroups: [],
    metrics,
    neighborhoodMetrics: metrics,
    claimGrounding,
    familyUseProfile: [],
    m2Priority: "first",
    decision: "greenlight",
    decisionReason: "Test",
  };
}

function makeTestAdapters(): ExtractionAdapters {
  return {
    fullText: {
      fetchUrl: async (url, options) =>
        Promise.resolve({
          ok: true as const,
          data: {
            finalUrl: url,
            status: 200,
            contentType: options?.accept?.includes("pdf")
              ? "application/pdf"
              : "application/xml",
            body: options?.accept?.includes("pdf")
              ? Buffer.from("%PDF-1.7 fixture")
              : Buffer.from('<?xml version="1.0"?><article />'),
          },
        }),
      processPdfWithGrobid: async () =>
        Promise.resolve({ ok: true as const, data: GROBID_TEI }),
      email: undefined,
      institutionalProxyUrl: undefined,
    },
    biorxivBaseUrl: "https://api.biorxiv.org",
  };
}

describe("runM2Extraction", () => {
  it("skips non-auditable edges", async () => {
    const family = makeFamily(1, 2);
    const result = await runM2Extraction(family, makeTestAdapters());

    expect(result.groundedSeedClaimText).toBe("Test claim");
    expect(result.summary.totalEdges).toBe(3);
    expect(result.summary.attemptedEdges).toBe(1);

    const skipped = result.edgeResults.filter(
      (e) => e.extractionOutcome === "skipped_not_auditable",
    );
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.failureReason).toContain("Not auditable");
  });

  it("returns correct summary counts", async () => {
    const family = makeFamily(2, 1);
    const result = await runM2Extraction(family, makeTestAdapters());

    expect(result.summary.totalEdges).toBe(3);
    expect(result.summary.attemptedEdges).toBe(2);
    expect(result.edgeResults).toHaveLength(3);
    expect(result.summary.failureCountsByOutcome).toBeDefined();
  });

  it("reports structured extraction outcomes", async () => {
    const family = makeFamily(1, 0);
    const result = await runM2Extraction(family, makeTestAdapters());

    const edge = result.edgeResults[0]!;
    expect(edge.extractionOutcome).toBe("success_grobid");
    expect(edge.sourceType).toBe("grobid_tei");
    expect(edge.extractionSuccess).toBe(true);
    expect(edge.deduplicatedMentionCount).toBeGreaterThanOrEqual(1);
    expect(typeof edge.usableForGrounding).not.toBe("undefined");
  });
});
