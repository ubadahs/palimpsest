import { describe, expect, it } from "vitest";

import type { ResolvedPaper } from "../../src/domain/types.js";
import { deduplicatePapers } from "../../src/pipeline/dedup.js";

function makePaper(
  id: string,
  overrides: Partial<ResolvedPaper> = {},
): ResolvedPaper {
  return {
    id,
    doi: `10.1234/${id}`,
    title: `Paper ${id}`,
    authors: ["First Author", "Last Author"],
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

describe("deduplicatePapers", () => {
  it("returns empty result for empty input", () => {
    const result = deduplicatePapers([]);
    expect(result.uniquePapers).toHaveLength(0);
    expect(result.duplicateGroups).toHaveLength(0);
  });

  it("keeps unique papers unchanged", () => {
    const papers = [
      makePaper("a", { title: "Alpha study" }),
      makePaper("b", { title: "Beta study" }),
      makePaper("c", { title: "Gamma study" }),
    ];
    const result = deduplicatePapers(papers);
    expect(result.uniquePapers).toHaveLength(3);
    expect(result.duplicateGroups).toHaveLength(0);
  });

  it("collapses papers with matching DOIs", () => {
    const papers = [
      makePaper("preprint-1", {
        doi: "10.1101/2020.01.01.123",
        title: "My Cool Study",
        paperType: "posted-content",
      }),
      makePaper("article-1", {
        doi: "10.1101/2020.01.01.123",
        title: "My Cool Study",
        paperType: "article",
      }),
    ];
    const result = deduplicatePapers(papers);
    expect(result.uniquePapers).toHaveLength(1);
    expect(result.uniquePapers[0]!.paperType).toBe("article");
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0]!.collapseReason).toContain("doi-match");
  });

  it("collapses papers with exact title + author overlap", () => {
    const papers = [
      makePaper("preprint-1", {
        doi: "10.1101/preprint-doi",
        title: "My Cool Study on Liver",
        authors: ["Alice Smith", "Bob Jones"],
        paperType: "posted-content",
      }),
      makePaper("article-1", {
        doi: "10.1234/journal-doi",
        title: "My Cool Study on Liver",
        authors: ["Alice Smith", "Bob Jones"],
        paperType: "article",
      }),
    ];
    const result = deduplicatePapers(papers);
    expect(result.uniquePapers).toHaveLength(1);
    expect(result.uniquePapers[0]!.paperType).toBe("article");
    expect(result.duplicateGroups[0]!.collapseReason).toContain(
      "exact-title+author-overlap",
    );
  });

  it("collapses papers with high title similarity + author overlap + year proximity", () => {
    const papers = [
      makePaper("preprint-1", {
        doi: "10.1101/preprint-doi",
        title: "A novel mechanism for hepatocyte polarity",
        authors: ["Alice Smith", "Bob Jones"],
        publicationYear: 2021,
        paperType: "posted-content",
      }),
      makePaper("article-1", {
        doi: "10.1234/journal-doi",
        title: "A novel mechanism for hepatocyte polarity regulation",
        authors: ["Alice Smith", "Bob Jones", "Carol White"],
        publicationYear: 2022,
        paperType: "article",
      }),
    ];
    const result = deduplicatePapers(papers);
    expect(result.uniquePapers).toHaveLength(1);
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0]!.collapseReason).toContain(
      "title-similarity",
    );
  });

  it("does NOT collapse papers with different authors even if titles match", () => {
    const papers = [
      makePaper("a", {
        title: "Trained immunity and heme",
        authors: ["Alice Smith"],
      }),
      makePaper("b", {
        title: "Trained immunity and heme",
        authors: ["Charlie Davis"],
      }),
    ];
    const result = deduplicatePapers(papers);
    expect(result.uniquePapers).toHaveLength(2);
    expect(result.duplicateGroups).toHaveLength(0);
  });

  it("does NOT collapse papers with similar titles but distant years", () => {
    const papers = [
      makePaper("a", {
        title: "Hepatocyte polarity and Rab35 signaling in liver development",
        authors: ["Alice Smith", "Bob Jones"],
        publicationYear: 2015,
      }),
      makePaper("b", {
        title: "Hepatocyte polarity and Rab35 signaling in liver regeneration",
        authors: ["Alice Smith", "Bob Jones"],
        publicationYear: 2023,
      }),
    ];
    const result = deduplicatePapers(papers);
    expect(result.uniquePapers).toHaveLength(2);
    expect(result.duplicateGroups).toHaveLength(0);
  });

  it("preserves provenance in duplicate groups", () => {
    const papers = [
      makePaper("preprint-1", {
        doi: "10.1101/2020.01.01.123",
        title: "Study X",
        paperType: "posted-content",
      }),
      makePaper("article-1", {
        doi: "10.1101/2020.01.01.123",
        title: "Study X",
        paperType: "article",
      }),
    ];
    const result = deduplicatePapers(papers);
    const group = result.duplicateGroups[0]!;
    expect(group.keptRepresentativePaperId).toBe("article-1");
    expect(group.collapsedFromPaperIds).toEqual(["preprint-1"]);
    expect(group.duplicateGroupId).toMatch(/^dedup-/);
  });

  it("prefers published article over preprint as representative", () => {
    const papers = [
      makePaper("preprint", {
        doi: "10.1101/123",
        title: "My Study",
        paperType: "posted-content",
      }),
      makePaper("article", {
        doi: "10.1101/123",
        title: "My Study",
        paperType: "article",
      }),
    ];
    const result = deduplicatePapers(papers);
    expect(result.uniquePapers[0]!.id).toBe("article");
  });
});
