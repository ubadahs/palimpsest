import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  _reconstructAbstract,
  getCitingWorks,
  resolveWorkByDoi,
} from "../../src/integrations/openalex.js";

const fixturesPath = fileURLToPath(
  new URL("../../fixtures/openalex", import.meta.url),
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesPath}/${name}`, "utf8")) as unknown;
}

describe("reconstructAbstract", () => {
  it("reconstructs words from an inverted index", () => {
    const result = _reconstructAbstract({
      We: [0],
      found: [1],
      that: [2],
      gene: [3],
      X: [4],
    });
    expect(result).toBe("We found that gene X");
  });
});

describe("resolveWorkByDoi", () => {
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
    expect(result.data.abstract).toContain("gene X may increase");
    expect(result.data.source).toBe("openalex");
    expect(result.data.fullTextStatus).toEqual({
      status: "available",
      source: "biorxiv_xml",
    });
    expect(result.data.openAccessPdfUrl).toContain(".pdf");
    expect(result.data.openAccessLandingPageUrl).toBe(
      "https://doi.org/10.1101/2024.01.15.575745",
    );
    expect(result.data.openAccessOaUrl).toContain("biorxiv.org");
    expect(result.data.resolutionProvenance).toEqual({
      method: "doi",
      confidence: "exact",
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

    expect(result.data.openAccessPdfUrl).toBe("https://example.com/paper.pdf");
    expect(result.data.openAccessLandingPageUrl).toBe(
      "https://example.com/landing",
    );
    expect(result.data.openAccessUrl).toBe("https://example.com/paper.pdf");

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

    expect(result.data.openAccessPdfUrl).toBeUndefined();
    expect(result.data.openAccessLandingPageUrl).toBe(
      "https://example.com/landing",
    );
    expect(result.data.openAccessUrl).toBe("https://example.com/landing");
    expect(result.data.fullTextStatus).toEqual({
      status: "available",
      source: "oa_link",
    });

    vi.restoreAllMocks();
  });
});

describe("getCitingWorks", () => {
  it("returns resolved papers from citing-works response", async () => {
    const fixture = loadFixture("citing-works-response.json");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(fixture),
      }),
    );

    const result = await getCitingWorks(
      "https://openalex.org/W2100837269",
      "https://api.openalex.org",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(3);

    const biorxivPaper = result.data[0];
    expect(biorxivPaper?.fullTextStatus).toEqual({
      status: "available",
      source: "biorxiv_xml",
    });

    const closedPaper = result.data[1];
    expect(closedPaper?.fullTextStatus.status).toBe("unavailable");

    const pmcPaper = result.data[2];
    expect(pmcPaper?.fullTextStatus).toEqual({
      status: "available",
      source: "pmc_xml",
    });

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
