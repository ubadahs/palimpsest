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

    await resolveWorkByDoi("10.1101/2024.01.01.000001", "https://api.test");

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
      "10.1101/2024.01.01.000001",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.doi).toBe("10.1101/2024.01.01.000001");
    expect(result.data.title).toBe(
      "A Hedged Finding About Gene X in Mouse Liver",
    );
    expect(result.data.authors).toEqual(["Alice Smith", "Bob Jones"]);
    expect(result.data.source).toBe("openalex");
    expect(result.data.fullTextHints).toEqual({
      providerAvailability: "available",
      locations: [
        {
          url: "https://www.biorxiv.org/content/10.1101/2024.01.01.000001v1.full.pdf",
          kind: "pdf",
          host: "repository",
        },
        {
          url: "https://doi.org/10.1101/2024.01.01.000001",
          kind: "landing_page",
          host: "repository",
        },
      ],
    });
    expect(result.data.resolutionProvenance).toEqual({
      method: "doi",
      confidence: "exact",
      requestedIdentifierType: "doi",
      requestedIdentifier: "10.1101/2024.01.01.000001",
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

    expect(result.data.fullTextHints.locations).toEqual([
      { url: "https://example.com/paper.pdf", kind: "pdf", host: "publisher" },
      {
        url: "https://example.com/landing",
        kind: "landing_page",
        host: "publisher",
      },
    ]);

    vi.restoreAllMocks();
  });

  it("lists the work's other open-access locations after the primary one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "https://openalex.org/W997",
            doi: "https://doi.org/10.1088/1475-7516/2021/02/019",
            display_name: "Journal Article With Preprint",
            authorships: [],
            open_access: {
              is_oa: true,
              oa_url: "https://iopscience.iop.org/article/10.1088/x",
            },
            primary_location: {
              is_oa: true,
              landing_page_url: "https://iopscience.iop.org/article/10.1088/x",
              pdf_url: null,
              source: { display_name: "JCAP", type: "journal" },
            },
            locations: [
              {
                is_oa: true,
                landing_page_url:
                  "https://iopscience.iop.org/article/10.1088/x",
                pdf_url: null,
              },
              {
                is_oa: true,
                landing_page_url: "https://arxiv.org/abs/2010.04074",
                pdf_url: "https://arxiv.org/pdf/2010.04074v2",
                source: { display_name: "arXiv", type: "repository" },
              },
              {
                is_oa: false,
                landing_page_url: "https://closed.example.com/x",
                pdf_url: "https://closed.example.com/x.pdf",
              },
              null,
            ],
          }),
      }),
    );

    const result = await resolveWorkByDoi(
      "10.1088/1475-7516/2021/02/019",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fullTextHints.locations).toEqual([
      {
        url: "https://iopscience.iop.org/article/10.1088/x",
        kind: "landing_page",
        host: "publisher",
      },
      {
        url: "https://arxiv.org/pdf/2010.04074v2",
        kind: "pdf",
        host: "repository",
      },
      {
        url: "https://arxiv.org/abs/2010.04074",
        kind: "landing_page",
        host: "repository",
      },
    ]);
    expect(result.data.arxivId).toBe("2010.04074");

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

    expect(result.data.fullTextHints).toEqual({
      providerAvailability: "available",
      locations: [
        {
          url: "https://example.com/landing",
          kind: "landing_page",
          host: "publisher",
        },
      ],
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
      "https://openalex.org/W0000000001",
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
      page: 1,
      returnedCount: 3,
      keptCount: 3,
    });
    // Everything available fits on the provider's single page; no second request.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const biorxivPaper = result.data.papers[0];
    expect(biorxivPaper?.fullTextHints).toMatchObject({
      providerAvailability: "available",
    });

    const closedPaper = result.data.papers[1];
    expect(closedPaper?.fullTextHints).toMatchObject({
      providerAvailability: "unavailable",
    });

    const pmcPaper = result.data.papers[2];
    expect(pmcPaper?.fullTextHints).toMatchObject({
      providerAvailability: "available",
    });

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
      "https://openalex.org/W0000000001",
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
      "https://openalex.org/W0000000001",
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

describe("getCitingWorks over a large neighborhood", () => {
  const total = 450;
  function syntheticPage(start: number, size: number) {
    return {
      meta: { count: total },
      results: Array.from({ length: size }, (_, offset) => ({
        id: `https://openalex.org/W${String(9_000_000 + start + offset)}`,
        display_name: `Citing work ${String(start + offset)}`,
        publication_year: 2005 + ((start + offset) % 20),
      })),
    };
  }
  function pagedFetch(options: { repeatAcrossPages?: boolean } = {}) {
    // Serve pages by the requested page number and per_page, as OpenAlex does.
    return vi.fn((url: string) => {
      const parsed = new URL(url);
      const page = Number(parsed.searchParams.get("page"));
      const perPage = Number(parsed.searchParams.get("per_page"));
      let start = (page - 1) * perPage;
      // A reorder between requests can push a work seen on page 1 onto page 2.
      if (options.repeatAcrossPages && page === 2) start -= 1;
      const size = Math.max(0, Math.min(perPage, total - start));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(syntheticPage(start, size)),
      });
    });
  }

  it("enumerates every citing work past the first 200", async () => {
    const fetchMock = pagedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCitingWorks(
      "https://openalex.org/W0000000001",
      "https://api.openalex.org",
      10_000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.data.papers).toHaveLength(total);
    expect(new Set(result.data.papers.map((paper) => paper.id)).size).toBe(
      total,
    );
    expect(result.data.pages.map((page) => page.returnedCount)).toEqual([
      200, 200, 50,
    ]);
    // Plain page numbers with one per_page: cursor paging needs an API key.
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(
      urls.every((url) => url.searchParams.get("per_page") === "200"),
    ).toBe(true);
    expect(urls.some((url) => url.searchParams.has("cursor"))).toBe(false);
    // An explicit sort keeps page offsets stable between requests.
    expect(
      urls.every(
        (url) => url.searchParams.get("sort") === "publication_date:asc",
      ),
    ).toBe(true);
    expect(result.data.providerReportedTotal).toBe(total);
    expect(result.data.coverage).toBe("complete");

    vi.restoreAllMocks();
  });

  it("stops at the safety cap and reports truncated coverage", async () => {
    const fetchMock = pagedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCitingWorks(
      "https://openalex.org/W0000000001",
      "https://api.openalex.org",
      300,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data.papers).toHaveLength(300);
    expect(result.data.coverage).toBe("truncated");

    vi.restoreAllMocks();
  });

  it("keeps a work repeated across pages once and reports the shortfall", async () => {
    const fetchMock = pagedFetch({ repeatAcrossPages: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCitingWorks(
      "https://openalex.org/W0000000001",
      "https://api.openalex.org",
      10_000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.data.papers.map((paper) => paper.id)).size).toBe(
      result.data.papers.length,
    );
    expect(result.data.pages[1]).toMatchObject({
      returnedCount: 200,
      keptCount: 199,
    });
    expect(result.data.coverage).toBe("truncated");

    vi.restoreAllMocks();
  });
});
