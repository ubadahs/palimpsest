import { describe, expect, it } from "vitest";

import type { ClaimFamilyPreScreen } from "../../src/domain/types.js";
import {
  toPreScreenJson,
  toPreScreenMarkdown,
} from "../../src/reporting/pre-screen-report.js";

const sampleResult: ClaimFamilyPreScreen = {
  seed: {
    doi: "10.1234/seed",
    trackedClaim: "Gene X increases protein Y",
    notes: "Hedged in original",
  },
  resolvedSeedPaper: {
    id: "seed-id",
    doi: "10.1234/seed",
    title: "Seed Paper Title",
    authors: ["Alice"],
    abstract: "Abstract text.",
    source: "openalex",
    fullTextHints: {
      providerAvailability: "available",
      providerSourceHint: "biorxiv_xml",
      landingPageUrl: "https://example.com",
      repositoryUrl: "https://example.com",
    },
    paperType: "article",
    referencedWorksCount: 20,
    publicationYear: 2021,
  },
  edges: [
    {
      citingPaperId: "citing-1",
      citedPaperId: "seed-id",
      inClaimFamily: true,
      claimRelevanceScore: 1,
      auditabilityStatus: "auditable_structured",
      auditabilityReason: "Structured full text from biorxiv_xml",
      classification: {
        isReview: false,
        isCommentary: false,
        isLetter: false,
        isBookChapter: false,
        isPreprint: false,
        isJournalArticle: true,
        isPrimaryLike: true,
        highReferenceCount: false,
      },
      paperType: "article",
      referencedWorksCount: 15,
    },
    {
      citingPaperId: "citing-2",
      citedPaperId: "seed-id",
      inClaimFamily: true,
      claimRelevanceScore: 0.5,
      auditabilityStatus: "not_auditable",
      auditabilityReason: "No open-access URL available",
      classification: {
        isReview: false,
        isCommentary: false,
        isLetter: false,
        isBookChapter: false,
        isPreprint: false,
        isJournalArticle: true,
        isPrimaryLike: true,
        highReferenceCount: false,
      },
      paperType: "article",
      referencedWorksCount: 10,
    },
  ],
  resolvedPapers: {
    "seed-id": {
      id: "seed-id",
      doi: "10.1234/seed",
      title: "Seed Paper Title",
      authors: ["Alice"],
      abstract: "Abstract text.",
      source: "openalex",
      fullTextHints: {
        providerAvailability: "available",
        providerSourceHint: "biorxiv_xml",
        landingPageUrl: "https://example.com",
        repositoryUrl: "https://example.com",
      },
      paperType: "article",
      referencedWorksCount: 20,
      publicationYear: 2021,
    },
    "citing-1": {
      id: "citing-1",
      doi: "10.1234/c1",
      title: "Citing Paper One Gene X protein Y",
      authors: ["Bob"],
      abstract: "Gene X increases protein Y in cells.",
      source: "openalex",
      fullTextHints: {
        providerAvailability: "available",
        providerSourceHint: "biorxiv_xml",
        landingPageUrl: "https://example.com/c1",
        repositoryUrl: "https://example.com/c1",
      },
      paperType: "article",
      referencedWorksCount: 15,
      publicationYear: 2022,
    },
    "citing-2": {
      id: "citing-2",
      doi: "10.1234/c2",
      title: "Citing Paper Two Gene X",
      authors: ["Carol"],
      abstract: "Gene X and protein Y signaling.",
      source: "openalex",
      fullTextHints: {
        providerAvailability: "unavailable",
        providerReason: "No OA",
      },
      paperType: "article",
      referencedWorksCount: 10,
      publicationYear: 2023,
    },
  },
  duplicateGroups: [],
  metrics: {
    totalEdges: 2,
    uniqueEdges: 2,
    collapsedDuplicates: 0,
    auditableStructuredEdges: 1,
    auditablePdfEdges: 0,
    partiallyAuditableEdges: 0,
    notAuditableEdges: 1,
    auditableCoverage: 0.5,
    primaryLikeEdgeCount: 2,
    primaryLikeEdgeRate: 1,
    reviewEdgeCount: 0,
    reviewEdgeRate: 0,
    commentaryEdgeCount: 0,
    commentaryEdgeRate: 0,
    letterEdgeCount: 0,
    letterEdgeRate: 0,
    bookChapterEdgeCount: 0,
    bookChapterEdgeRate: 0,
    articleEdgeCount: 2,
    articleEdgeRate: 1,
    preprintEdgeCount: 0,
    preprintEdgeRate: 0,
  },
  neighborhoodMetrics: {
    totalEdges: 2,
    uniqueEdges: 2,
    collapsedDuplicates: 0,
    auditableStructuredEdges: 1,
    auditablePdfEdges: 0,
    partiallyAuditableEdges: 0,
    notAuditableEdges: 1,
    auditableCoverage: 0.5,
    primaryLikeEdgeCount: 2,
    primaryLikeEdgeRate: 1,
    reviewEdgeCount: 0,
    reviewEdgeRate: 0,
    commentaryEdgeCount: 0,
    commentaryEdgeRate: 0,
    letterEdgeCount: 0,
    letterEdgeRate: 0,
    bookChapterEdgeCount: 0,
    bookChapterEdgeRate: 0,
    articleEdgeCount: 2,
    articleEdgeRate: 1,
    preprintEdgeCount: 0,
    preprintEdgeRate: 0,
  },
  claimGrounding: {
    status: "grounded",
    analystClaim: "Gene X increases protein Y",
    normalizedClaim: "Gene X increases protein Y",
    supportSpans: [
      {
        text: "Gene X increases protein Y in the assay.",
        sectionTitle: "Results",
        blockKind: "body_paragraph",
        bm25Score: 2.1,
      },
    ],
    blocksDownstream: false,
    detailReason: "Claim grounded in one seed passage(s).",
  },
  familyUseProfile: ["primary_empirical_heavy"],
  m2Priority: "not_now",
  decision: "deprioritize",
  decisionReason: "Only 1 auditable edge(s), need at least 3",
};

describe("toPreScreenJson", () => {
  it("produces valid JSON with all required fields", () => {
    const json = toPreScreenJson([sampleResult]);
    const parsed = JSON.parse(json) as ClaimFamilyPreScreen[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.decision).toBe("deprioritize");
    expect(parsed[0]!.metrics.auditableCoverage).toBe(0.5);
    expect(parsed[0]!.familyUseProfile).toContain("primary_empirical_heavy");
    expect(parsed[0]!.m2Priority).toBe("not_now");
  });
});

describe("toPreScreenMarkdown", () => {
  it("includes summary table and seed sections", () => {
    const md = toPreScreenMarkdown([sampleResult]);

    expect(md).toContain("# Pre-Screen Report");
    expect(md).toContain("## Summary");
    expect(md).toContain("Seed Paper Title");
    expect(md).toContain("Gene X increases protein Y");
    expect(md).toContain("Claim grounding (LLM):");
    expect(md).toContain("Neighborhood auditability");
    expect(md).toContain("Claim-scoped auditability");
    expect(md).toContain("DEPRIORITIZE");
    expect(md).toContain("Citing Paper One");
    expect(md).toContain("auditable");
  });

  it("includes notes when present", () => {
    const md = toPreScreenMarkdown([sampleResult]);
    expect(md).toContain("Hedged in original");
  });

  it("includes seed acquisition failure reasons when available", () => {
    const md = toPreScreenMarkdown([
      {
        ...sampleResult,
        seedFullTextAcquisition: {
          materializationSource: "network",
          attempts: [],
          failureReason: "No fetchable full text candidates",
        },
      },
    ]);

    expect(md).toContain("Seed full text acquisition:");
    expect(md).toContain("No fetchable full text candidates");
  });

  it("includes explanatory note about review-heavy neighborhoods", () => {
    const md = toPreScreenMarkdown([sampleResult]);
    expect(md).toContain("review-heavy neighborhood is not");
    expect(md).toContain("claim-transmission");
    expect(md).toContain("latent bias and consolidation");
  });

  it("includes citation population mix section", () => {
    const md = toPreScreenMarkdown([sampleResult]);
    expect(md).toContain("Citation population mix");
    expect(md).toContain("Primary-like");
    expect(md).toContain("empirical-attribution pipeline");
    expect(md).toContain("Reviews");
  });

  it("includes family profile and m2 priority", () => {
    const md = toPreScreenMarkdown([sampleResult]);
    expect(md).toContain("Family profile:");
    expect(md).toContain("M2 priority:");
    expect(md).toContain("primary_empirical_heavy");
  });

  it("includes summary columns for composition", () => {
    const md = toPreScreenMarkdown([sampleResult]);
    expect(md).toContain("Primary-like");
    expect(md).toContain("Profile");
    expect(md).toContain("M2");
    expect(md).toContain("Grounding");
    expect(md).toContain("Claim edges");
  });

  it("includes dedup metrics in per-seed section", () => {
    const md = toPreScreenMarkdown([sampleResult]);
    expect(md).toContain("Unique edges (after dedup)");
    expect(md).toContain("Collapsed duplicates");
  });

  it("includes edge tags in edge table", () => {
    const md = toPreScreenMarkdown([sampleResult]);
    expect(md).toContain("Tags");
    expect(md).toContain("primary");
  });

  it("mentions the grounding trace sidecar when a basename is provided", () => {
    const md = toPreScreenMarkdown([sampleResult], {
      groundingTraceFileName: "2026-04-05_001_pre-screen-grounding-trace.json",
    });
    expect(md).toContain("LLM grounding trace");
    expect(md).toContain("2026-04-05_001_pre-screen-grounding-trace.json");
  });
});
