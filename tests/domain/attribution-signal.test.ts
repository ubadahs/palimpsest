import { describe, expect, it } from "vitest";

import { classifyEdge } from "../../src/domain/attribution-signal.js";
import type { ResolvedPaper } from "../../src/domain/types.js";

function makePaper(overrides: Partial<ResolvedPaper> = {}): ResolvedPaper {
  return {
    id: "test-id",
    doi: "10.1234/test",
    title: "Normal Research Paper",
    authors: ["Author A"],
    abstract: "Test abstract.",
    source: "openalex",
    openAccessUrl: "https://example.com/paper.pdf",
    fullTextStatus: { status: "available", source: "biorxiv_xml" },
    paperType: "article",
    referencedWorksCount: 30,
    publicationYear: 2022,
    ...overrides,
  };
}

describe("classifyEdge", () => {
  it("marks a normal article as primary-like and journal article", () => {
    const c = classifyEdge(makePaper());
    expect(c.isPrimaryLike).toBe(true);
    expect(c.isJournalArticle).toBe(true);
    expect(c.isReview).toBe(false);
    expect(c.isCommentary).toBe(false);
    expect(c.isPreprint).toBe(false);
  });

  it("classifies reviews", () => {
    const c = classifyEdge(makePaper({ paperType: "review" }));
    expect(c.isReview).toBe(true);
    expect(c.isPrimaryLike).toBe(false);
    expect(c.isJournalArticle).toBe(false);
  });

  it("classifies book chapters", () => {
    const c = classifyEdge(makePaper({ paperType: "book-chapter" }));
    expect(c.isBookChapter).toBe(true);
    expect(c.isPrimaryLike).toBe(false);
  });

  it("classifies letters", () => {
    const c = classifyEdge(makePaper({ paperType: "letter" }));
    expect(c.isLetter).toBe(true);
    expect(c.isPrimaryLike).toBe(false);
  });

  it("classifies editorials as commentary", () => {
    const c = classifyEdge(makePaper({ paperType: "editorial" }));
    expect(c.isCommentary).toBe(true);
    expect(c.isPrimaryLike).toBe(false);
  });

  it("detects commentary from title cues even if type is article", () => {
    const c = classifyEdge(
      makePaper({ title: "Commentary on recent findings in liver biology" }),
    );
    expect(c.isCommentary).toBe(true);
    expect(c.isPrimaryLike).toBe(false);
  });

  it("detects 'the people behind the papers' title pattern", () => {
    const c = classifyEdge(
      makePaper({ title: "The People Behind the Papers – Smith et al" }),
    );
    expect(c.isCommentary).toBe(true);
    expect(c.isPrimaryLike).toBe(false);
  });

  it("detects perspective title cue", () => {
    const c = classifyEdge(
      makePaper({ title: "A perspective on mRNA vaccine durability" }),
    );
    expect(c.isCommentary).toBe(true);
  });

  it("classifies preprints", () => {
    const c = classifyEdge(makePaper({ paperType: "posted-content" }));
    expect(c.isPreprint).toBe(true);
    expect(c.isPrimaryLike).toBe(true);
    expect(c.isJournalArticle).toBe(false);
  });

  it("flags high reference count as a soft signal", () => {
    const c = classifyEdge(makePaper({ referencedWorksCount: 250 }));
    expect(c.highReferenceCount).toBe(true);
    expect(c.isPrimaryLike).toBe(true);
  });

  it("does not flag moderate reference counts", () => {
    const c = classifyEdge(makePaper({ referencedWorksCount: 80 }));
    expect(c.highReferenceCount).toBe(false);
  });

  it("handles missing paperType gracefully", () => {
    const c = classifyEdge(makePaper({ paperType: undefined }));
    expect(c.isReview).toBe(false);
    expect(c.isPrimaryLike).toBe(true);
  });

  it("handles missing referencedWorksCount gracefully", () => {
    const c = classifyEdge(makePaper({ referencedWorksCount: undefined }));
    expect(c.highReferenceCount).toBe(false);
  });

  it("detects review title cue on an article-type paper", () => {
    const c = classifyEdge(
      makePaper({
        paperType: "article",
        title: "A comprehensive review of trained immunity mechanisms",
      }),
    );
    expect(c.isCommentary).toBe(true);
    expect(c.isPrimaryLike).toBe(false);
  });
});
