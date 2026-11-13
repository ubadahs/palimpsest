import type { ResolvedPaper } from "../src/domain/common.js";

export function makePaper(
  overrides: Partial<ResolvedPaper> = {},
): ResolvedPaper {
  return {
    id: "paper-1",
    doi: "10.1234/example",
    title: "Example Paper",
    authors: ["Author A"],
    abstract: undefined,
    source: "openalex",
    fullTextHints: {
      providerAvailability: "available",
      providerSourceHint: "pdf",
      pdfUrl: "https://example.com/paper.pdf",
    },
    paperType: "article",
    referencedWorksCount: 10,
    publicationYear: 2024,
    ...overrides,
  };
}
