import { describe, expect, it } from "vitest";

import type { PreScreenEdge, ResolvedPaper } from "../../src/domain/types.js";
import {
  extractEdgeContext,
  type ExtractionAdapters,
} from "../../src/retrieval/citation-context.js";

function makePaper(overrides: Partial<ResolvedPaper> = {}): ResolvedPaper {
  return {
    id: "citing-1",
    title: "Some Citing Paper",
    doi: "10.1234/citing",
    authors: ["Author One"],
    abstract: undefined,
    source: "openalex",
    openAccessUrl: undefined,
    fullTextStatus: {
      status: "available",
      source: "biorxiv_xml",
    },
    paperType: "article",
    referencedWorksCount: 30,
    publicationYear: 2022,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<PreScreenEdge> = {}): PreScreenEdge {
  return {
    citingPaperId: "citing-1",
    citedPaperId: "seed-1",
    auditabilityStatus: "auditable_structured",
    auditabilityReason: "Structured full text",
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
    referencedWorksCount: 30,
    ...overrides,
  };
}

describe("extractEdgeContext", () => {
  it("returns skipped_not_auditable when full text is unavailable", async () => {
    const citing = makePaper({
      fullTextStatus: { status: "unavailable", reason: "Paywalled" },
    });
    const seed = makePaper({
      id: "seed-1",
      doi: "10.1234/seed",
      title: "Seed Paper Title",
    });
    const edge = makeEdge();

    const adapters: ExtractionAdapters = {
      fullText: {
        fetchXml: async () => Promise.resolve({ ok: true as const, data: "" }),
        fetchPdf: async () =>
          Promise.resolve({ ok: false as const, error: "not needed" }),
        extractPdfText: async () =>
          Promise.resolve({ ok: false as const, error: "not needed" }),
        email: undefined,
      },
      biorxivBaseUrl: "https://api.biorxiv.org",
    };

    const result = await extractEdgeContext(edge, citing, seed, adapters);

    expect(result.extractionSuccess).toBe(false);
    expect(result.extractionOutcome).toBe("skipped_not_auditable");
    expect(result.sourceType).toBe("not_attempted");
  });

  it("returns structured failure when full text fetch fails with 403", async () => {
    const citing = makePaper({
      fullTextStatus: { status: "available", source: "publisher_pdf" },
      openAccessUrl: "https://example.com/paper.pdf",
    });
    const seed = makePaper({
      id: "seed-1",
      doi: "10.1234/seed",
      title: "Seed Paper Title",
    });
    const edge = makeEdge();

    const adapters: ExtractionAdapters = {
      fullText: {
        fetchXml: async () =>
          Promise.resolve({ ok: false as const, error: "no xml" }),
        fetchPdf: async () =>
          Promise.resolve({
            ok: false as const,
            error: "HTTP 403 from publisher",
          }),
        extractPdfText: async () =>
          Promise.resolve({ ok: false as const, error: "no text" }),
        email: undefined,
      },
      biorxivBaseUrl: "https://api.biorxiv.org",
    };

    const result = await extractEdgeContext(edge, citing, seed, adapters);

    expect(result.extractionSuccess).toBe(false);
    expect(result.extractionOutcome).toBe("fail_http_403");
    expect(result.failureReason).toContain("403");
  });

  it("reports failure when fetch fails for non-403 reasons", async () => {
    const citing = makePaper({
      doi: undefined,
      openAccessUrl: undefined,
      fullTextStatus: { status: "available", source: "publisher_pdf" },
    });
    const seed = makePaper({
      id: "seed-1",
      doi: "10.9999/notfound",
      title: "Completely Different Title",
    });
    const edge = makeEdge();

    const adapters: ExtractionAdapters = {
      fullText: {
        fetchXml: async () =>
          Promise.resolve({ ok: false as const, error: "connection timeout" }),
        fetchPdf: async () =>
          Promise.resolve({ ok: false as const, error: "connection timeout" }),
        extractPdfText: async () =>
          Promise.resolve({ ok: false as const, error: "no text" }),
        email: undefined,
      },
      biorxivBaseUrl: "https://api.biorxiv.org",
    };

    const result = await extractEdgeContext(edge, citing, seed, adapters);

    expect(result.extractionSuccess).toBe(false);
    expect(result.extractionOutcome).toBe("fail_unknown");
  });
});
