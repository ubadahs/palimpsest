import { describe, expect, it } from "vitest";

import { assessAuditability } from "../../src/domain/auditability.js";
import type { ResolvedPaper } from "../../src/domain/types.js";

function makePaper(overrides: Partial<ResolvedPaper> = {}): ResolvedPaper {
  return {
    id: "test-id",
    doi: "10.1234/test",
    title: "Test Paper",
    authors: ["Author A"],
    abstract: "Test abstract.",
    source: "openalex",
    openAccessUrl: "https://example.com/paper.pdf",
    fullTextStatus: { status: "available", source: "biorxiv_xml" },
    paperType: "article",
    referencedWorksCount: 25,
    publicationYear: 2022,
    ...overrides,
  };
}

describe("assessAuditability", () => {
  it("returns auditable_structured for XML full text sources", () => {
    for (const source of ["biorxiv_xml", "pmc_xml", "jats_xml"]) {
      const result = assessAuditability(
        makePaper({ fullTextStatus: { status: "available", source } }),
      );
      expect(result.status).toBe("auditable_structured");
    }
  });

  it("returns auditable_pdf for PDF full text", () => {
    const result = assessAuditability(
      makePaper({ fullTextStatus: { status: "available", source: "pdf" } }),
    );
    expect(result.status).toBe("auditable_pdf");
    expect(result.reason).toContain("PDF");
  });

  it("returns partially_auditable for abstract-only papers", () => {
    const result = assessAuditability(
      makePaper({ fullTextStatus: { status: "abstract_only" } }),
    );
    expect(result.status).toBe("partially_auditable");
    expect(result.reason).toContain("abstract");
  });

  it("returns not_auditable for unavailable full text", () => {
    const result = assessAuditability(
      makePaper({
        fullTextStatus: { status: "unavailable", reason: "Paywalled" },
      }),
    );
    expect(result.status).toBe("not_auditable");
    expect(result.reason).toBe("Paywalled");
  });
});
