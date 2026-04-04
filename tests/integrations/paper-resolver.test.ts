import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedPaper } from "../../src/domain/types.js";

vi.mock("../../src/integrations/openalex.js", () => ({
  resolveWorkByDoi: vi.fn(),
  resolveWorkByPmid: vi.fn(),
  resolveWorkByPmcid: vi.fn(),
  resolveWorkByMetadata: vi.fn(),
}));

vi.mock("../../src/integrations/semantic-scholar.js", () => ({
  resolvePaperByDoi: vi.fn(),
  resolvePaperByPmid: vi.fn(),
  resolvePaperByPmcid: vi.fn(),
  resolvePaperByMetadata: vi.fn(),
}));

import * as openalex from "../../src/integrations/openalex.js";
import * as semanticScholar from "../../src/integrations/semantic-scholar.js";
import { resolvePaperByMetadata } from "../../src/integrations/paper-resolver.js";

const CONFIG = {
  openAlexBaseUrl: "https://api.openalex.org",
  semanticScholarBaseUrl: "https://api.semanticscholar.org/graph/v1",
  openAlexEmail: undefined,
  semanticScholarApiKey: undefined,
};

function makePaper(overrides: Partial<ResolvedPaper> = {}): ResolvedPaper {
  return {
    id: "paper-1",
    title: "Seed Paper Title",
    doi: "10.1234/seed",
    authors: ["Belicova"],
    abstract: undefined,
    source: "openalex",
    openAccessUrl: "https://example.com/paper.pdf",
    openAccessPdfUrl: "https://example.com/paper.pdf",
    fullTextStatus: { status: "available", source: "publisher_pdf" },
    paperType: "article",
    referencedWorksCount: 10,
    publicationYear: 2021,
    resolutionProvenance: {
      method: "doi",
      confidence: "exact",
    },
    ...overrides,
  };
}

describe("resolvePaperByMetadata", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("falls back to exact PMID lookup when DOI is absent", async () => {
    vi.mocked(openalex.resolveWorkByPmid).mockResolvedValue({
      ok: false,
      error: "No OpenAlex PMID match",
    });
    vi.mocked(semanticScholar.resolvePaperByPmid).mockResolvedValue({
      ok: true,
      data: makePaper({
        source: "semantic_scholar",
        resolutionProvenance: { method: "pmid", confidence: "exact" },
      }),
    });

    const result = await resolvePaperByMetadata(
      {
        pmid: "12345678",
        title: "Seed Paper Title",
        authors: ["Belicova"],
        publicationYear: 2021,
      },
      CONFIG,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.source).toBe("semantic_scholar");
    expect(result.data.resolutionProvenance).toEqual({
      method: "pmid",
      confidence: "exact",
    });
  });

  it("uses exact PMCID matches before metadata search", async () => {
    vi.mocked(openalex.resolveWorkByPmcid).mockResolvedValue({
      ok: true,
      data: makePaper({
        resolutionProvenance: { method: "pmcid", confidence: "exact" },
      }),
    });

    const result = await resolvePaperByMetadata(
      {
        pmcid: "PMC1234567",
        title: "Seed Paper Title",
        authors: ["Belicova"],
        publicationYear: 2021,
      },
      CONFIG,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.resolutionProvenance).toEqual({
      method: "pmcid",
      confidence: "exact",
    });
    expect(openalex.resolveWorkByMetadata).not.toHaveBeenCalled();
  });

  it("uses conservative title+author+year metadata matching when identifiers are absent", async () => {
    vi.mocked(openalex.resolveWorkByMetadata).mockResolvedValue({
      ok: true,
      data: makePaper({
        resolutionProvenance: {
          method: "title_author_year",
          confidence: "high",
        },
      }),
    });

    const result = await resolvePaperByMetadata(
      {
        title: "Seed Paper Title",
        authors: ["Belicova"],
        publicationYear: 2021,
      },
      CONFIG,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.resolutionProvenance).toEqual({
      method: "title_author_year",
      confidence: "high",
    });
  });

  it("fails on ambiguous metadata matches instead of guessing", async () => {
    vi.mocked(openalex.resolveWorkByMetadata).mockResolvedValue({
      ok: false,
      error: "Ambiguous OpenAlex metadata match",
    });
    vi.mocked(semanticScholar.resolvePaperByMetadata).mockResolvedValue({
      ok: false,
      error: "Ambiguous Semantic Scholar metadata match",
    });

    const result = await resolvePaperByMetadata(
      {
        title: "Ambiguous Title",
        authors: ["Smith"],
        publicationYear: 2021,
      },
      CONFIG,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("Ambiguous");
  });
});
