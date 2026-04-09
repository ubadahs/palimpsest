import { describe, expect, it } from "vitest";

import type { PreScreenEdge, ResolvedPaper } from "../../src/domain/types.js";
import {
  extractEdgeContext,
  type ExtractionAdapters,
} from "../../src/retrieval/citation-context.js";

const GROBID_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI>
  <text>
    <body>
      <div>
        <head>Results</head>
        <p><ref type="bibr" target="#b1">Belicova et al., 2021</ref> demonstrated that silencing Rab35 results in loss of apical bulkheads and cyst formation in hepatocytes.</p>
      </div>
    </body>
  </text>
  <back>
    <listBibl>
      <biblStruct xml:id="b1">
        <analytic>
          <title level="a">Seed Paper Title</title>
          <author><persName><surname>Belicova</surname></persName></author>
        </analytic>
        <monogr>
          <imprint><date when="2021"/></imprint>
        </monogr>
        <idno type="doi">10.1234/seed</idno>
      </biblStruct>
    </listBibl>
  </back>
</TEI>`;

function makePaper(overrides: Partial<ResolvedPaper> = {}): ResolvedPaper {
  return {
    id: "citing-1",
    title: "Some Citing Paper",
    doi: "10.1234/citing",
    authors: ["Author One"],
    abstract: undefined,
    source: "openalex",
    fullTextHints: {
      providerAvailability: "available",
      providerSourceHint: "biorxiv_xml",
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
      fullTextHints: {
        providerAvailability: "unavailable",
        providerReason: "Paywalled",
      },
    });
    const seed = makePaper({
      id: "seed-1",
      doi: "10.1234/seed",
      title: "Seed Paper Title",
    });
    const edge = makeEdge();

    const adapters: ExtractionAdapters = {
      fullText: {
        fetchUrl: async (url) =>
          Promise.resolve({
            ok: true as const,
            data: {
              finalUrl: url,
              status: 200,
              contentType: "application/xml",
              body: Buffer.from('<?xml version="1.0"?><article />'),
            },
          }),
        processPdfWithGrobid: async () =>
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
      fullTextHints: {
        providerAvailability: "available",
        providerSourceHint: "pdf",
        pdfUrl: "https://example.com/paper.pdf",
        repositoryUrl: "https://example.com/paper.pdf",
      },
    });
    const seed = makePaper({
      id: "seed-1",
      doi: "10.1234/seed",
      title: "Seed Paper Title",
    });
    const edge = makeEdge();

    const adapters: ExtractionAdapters = {
      fullText: {
        fetchUrl: async (url, options) =>
          Promise.resolve({
            ok: true as const,
            data: {
              finalUrl: url,
              status: options?.accept?.includes("pdf") ? 403 : 404,
              contentType: options?.accept?.includes("pdf")
                ? "application/pdf"
                : "application/xml",
              body: Buffer.from(""),
            },
          }),
        processPdfWithGrobid: async () =>
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
      fullTextHints: {
        providerAvailability: "available",
        providerSourceHint: "pdf",
      },
    });
    const seed = makePaper({
      id: "seed-1",
      doi: "10.9999/notfound",
      title: "Completely Different Title",
    });
    const edge = makeEdge();

    const adapters: ExtractionAdapters = {
      fullText: {
        fetchUrl: async () =>
          Promise.resolve({
            ok: false as const,
            error: "connection timeout",
          }),
        processPdfWithGrobid: async () =>
          Promise.resolve({ ok: false as const, error: "no text" }),
        email: undefined,
      },
      biorxivBaseUrl: "https://api.biorxiv.org",
    };

    const result = await extractEdgeContext(edge, citing, seed, adapters);

    expect(result.extractionSuccess).toBe(false);
    expect(result.extractionOutcome).toBe("fail_unknown");
  });

  it("extracts citation mentions from GROBID TEI for PDF-backed papers", async () => {
    const citing = makePaper({
      fullTextHints: {
        providerAvailability: "available",
        providerSourceHint: "pdf",
        pdfUrl: "https://example.com/paper.pdf",
        repositoryUrl: "https://example.com/paper.pdf",
      },
    });
    const seed = makePaper({
      id: "seed-1",
      doi: "10.1234/seed",
      title: "Seed Paper Title",
    });
    const edge = makeEdge();

    const adapters: ExtractionAdapters = {
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
      },
      biorxivBaseUrl: "https://api.biorxiv.org",
    };

    const result = await extractEdgeContext(edge, citing, seed, adapters);

    expect(result.extractionOutcome).toBe("success_grobid");
    expect(result.sourceType).toBe("grobid_tei");
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]!.sectionTitle).toBe("Results");
  });
});
