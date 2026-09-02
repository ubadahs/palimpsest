import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  getCitingWorks,
  resolveWorkByDoi,
} from "../../src/integrations/openalex.js";

const fixturesPath = fileURLToPath(
  new URL("../../fixtures/openalex", import.meta.url),
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesPath}/${name}`, "utf8")) as unknown;
}

describe("resolveWorkByDoi", () => {
  it("asks OpenAlex only for the fields it reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(loadFixture("work-response.json")),
    });
    vi.stubGlobal("fetch", fetchMock);

    await resolveWorkByDoi("10.1101/2024.01.15.575745", "https://api.test");

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("select=");
    expect(url).toContain("primary_location");
    // The inverted abstract index is the largest field and nothing reads it.
    expect(url).not.toContain("abstract_inverted_index");
  });

  it("transforms an OpenAlex work response into a ResolvedPaper", async () => {
    const fixture = loadFixture("work-response.json");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(fixture),
      }),
    );

    const result = await resolveWorkByDoi(
      "10.1101/2024.01.15.575745",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.doi).toBe("10.1101/2024.01.15.575745");
    expect(result.data.title).toBe(
      "A Hedged Finding About Gene X in Mouse Liver",
    );
    expect(result.data.authors).toEqual(["Alice Smith", "Bob Jones"]);
    expect(result.data.source).toBe("openalex");
    expect(result.data.fullTextHints).toMatchObject({
      providerAvailability: "available",
      providerSourceHint: "biorxiv_xml",
    });
    expect(result.data.fullTextHints.pdfUrl).toContain(".pdf");
    expect(result.data.fullTextHints.landingPageUrl).toBe(
      "https://doi.org/10.1101/2024.01.15.575745",
    );
    expect(result.data.fullTextHints.repositoryUrl).toContain("biorxiv.org");
    expect(result.data.resolutionProvenance).toEqual({
      method: "doi",
      confidence: "exact",
      requestedIdentifierType: "doi",
      requestedIdentifier: "10.1101/2024.01.15.575745",
    });

    vi.restoreAllMocks();
  });

  it("keeps direct PDF URLs separate from landing pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "https://openalex.org/W999",
            doi: "https://doi.org/10.1234/direct-pdf",
            display_name: "Direct PDF Paper",
            authorships: [],
            open_access: {
              is_oa: true,
              oa_url: "https://example.com/landing",
            },
            primary_location: {
              landing_page_url: "https://example.com/landing",
              pdf_url: "https://example.com/paper.pdf",
              source: {
                display_name: "Example Publisher",
                type: "journal",
              },
            },
          }),
      }),
    );

    const result = await resolveWorkByDoi(
      "10.1234/direct-pdf",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.fullTextHints.pdfUrl).toBe(
      "https://example.com/paper.pdf",
    );
    expect(result.data.fullTextHints.landingPageUrl).toBe(
      "https://example.com/landing",
    );
    expect(result.data.fullTextHints.repositoryUrl).toBe(
      "https://example.com/landing",
    );

    vi.restoreAllMocks();
  });

  it("does not promote landing pages to direct PDF URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "https://openalex.org/W998",
            doi: "https://doi.org/10.1234/landing-only",
            display_name: "Landing Page Only",
            authorships: [],
            open_access: {
              is_oa: true,
              oa_url: "https://example.com/landing",
            },
            primary_location: {
              landing_page_url: "https://example.com/landing",
              pdf_url: null,
              source: {
                display_name: "Example Publisher",
                type: "journal",
              },
            },
          }),
      }),
    );

    const result = await resolveWorkByDoi(
      "10.1234/landing-only",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.fullTextHints.pdfUrl).toBeUndefined();
    expect(result.data.fullTextHints.landingPageUrl).toBe(
      "https://example.com/landing",
    );
    expect(result.data.fullTextHints.repositoryUrl).toBe(
      "https://example.com/landing",
    );
    expect(result.data.fullTextHints).toMatchObject({
      providerAvailability: "available",
      providerSourceHint: "oa_link",
    });

    vi.restoreAllMocks();
  });
});

describe("getCitingWorks", () => {
  it("returns resolved papers from citing-works response", async () => {
    const fixture = loadFixture("citing-works-response.json");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fixture),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCitingWorks(
      "https://openalex.org/W2100837269",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.papers).toHaveLength(3);
    expect(result.data.providerReportedTotal).toBe(3);
    expect(result.data.coverage).toBe("complete");
    expect(result.data.pages).toHaveLength(1);
    expect(result.data.pages[0]).toMatchObject({
      pageIndex: 0,
      cursor: "*",
      returnedCount: 3,
      nextCursor: null,
    });
    // Everything available fits on the provider's single page; no second request.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const biorxivPaper = result.data.papers[0];
    expect(biorxivPaper?.fullTextHints).toMatchObject({
      providerAvailability: "available",
      providerSourceHint: "biorxiv_xml",
    });

    const closedPaper = result.data.papers[1];
    expect(closedPaper?.fullTextHints).toMatchObject({
      providerAvailability: "unavailable",
    });

    const pmcPaper = result.data.papers[2];
    expect(pmcPaper?.fullTextHints).toMatchObject({
      providerAvailability: "available",
      providerSourceHint: "pmc_xml",
    });

    vi.restoreAllMocks();
  });

  it("paginates across cursor pages until the limit or provider exhaustion", async () => {
    const page1 = loadFixture("citing-works-page1.json");
    const page2 = loadFixture("citing-works-page2.json");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page2) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCitingWorks(
      "https://openalex.org/W2100837269",
      "https://api.openalex.org",
      4,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data.papers).toHaveLength(4);
    expect(result.data.papers.map((paper) => paper.title)).toEqual([
      "Page One Citing Paper A",
      "Page One Citing Paper B",
      "Page Two Citing Paper C",
      "Page Two Citing Paper D",
    ]);
    expect(result.data.providerReportedTotal).toBe(4);
    expect(result.data.coverage).toBe("complete");
    expect(result.data.pages).toHaveLength(2);
    expect(result.data.pages[0]).toMatchObject({
      pageIndex: 0,
      cursor: "*",
      perPage: 4,
      returnedCount: 2,
      nextCursor: "cursor-page-2",
    });
    expect(result.data.pages[1]).toMatchObject({
      pageIndex: 1,
      cursor: "cursor-page-2",
      perPage: 2,
      returnedCount: 2,
      nextCursor: null,
    });
    // Second page's request URL carries the cursor from the first page's response.
    const secondRequestUrl = fetchMock.mock.calls[1]![0] as string;
    expect(secondRequestUrl).toContain("cursor=cursor-page-2");

    vi.restoreAllMocks();
  });

  it("reports truncated coverage when the observation limit stops pagination early", async () => {
    const page1 = loadFixture("citing-works-page1.json");
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(page1),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCitingWorks(
      "https://openalex.org/W2100837269",
      "https://api.openalex.org",
      2,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // page1.json reports meta.count=4 but the limit of 2 stops after one page.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data.papers).toHaveLength(2);
    expect(result.data.providerReportedTotal).toBe(4);
    expect(result.data.coverage).toBe("truncated");

    vi.restoreAllMocks();
  });

  it("propagates a page fetch failure without fabricating partial results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const result = await getCitingWorks(
      "https://openalex.org/W2100837269",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(false);

    vi.restoreAllMocks();
  });
});

describe("resolveWorkByDoi error handling", () => {
  it("returns an error for HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }),
    );

    const result = await resolveWorkByDoi(
      "10.1234/nonexistent",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("404");

    vi.restoreAllMocks();
  });

  it("returns an error for malformed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ garbage: true }),
      }),
    );

    const result = await resolveWorkByDoi(
      "10.1234/bad",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(false);

    vi.restoreAllMocks();
  });
});
