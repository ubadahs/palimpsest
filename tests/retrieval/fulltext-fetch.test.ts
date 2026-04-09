import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedPaper } from "../../src/domain/types.js";
import {
  fetchFullText,
  type FullTextFetchResponse,
} from "../../src/retrieval/fulltext-fetch.js";

const PMC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<article>
  <front>
    <article-meta>
      <title-group>
        <article-title>PMC XML Fixture</article-title>
      </title-group>
    </article-meta>
  </front>
  <body>
    <sec>
      <title>Results</title>
      <p>Fixture content.</p>
    </sec>
  </body>
</article>`;

function makePaper(overrides: Partial<ResolvedPaper> = {}): ResolvedPaper {
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

function makeXmlResponse(url: string): FullTextFetchResponse {
  return {
    finalUrl: url,
    status: 200,
    contentType: "application/xml",
    body: Buffer.from(PMC_XML),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchFullText acquisition policy", () => {
  it("prefers PMC XML via the original DOI input over the resolver DOI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (!url.includes("/pmc/utils/idconv/")) {
          throw new Error(`Unexpected fetchJson request: ${url}`);
        }

        const ids = new URL(url).searchParams.get("ids");
        const body =
          ids === "10.1091/mbc.E22-09-0443"
            ? { records: [{ pmcid: "PMC10092647" }] }
            : { records: [{ errmsg: "No PMCID found for DOI" }] };

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(body),
        });
      }),
    );

    const grobid = vi.fn(async () =>
      Promise.resolve({ ok: true as const, data: "<tei />" }),
    );
    const fetchUrl = vi.fn(async (url: string) =>
      Promise.resolve({ ok: true as const, data: makeXmlResponse(url) }),
    );
    const paper = makePaper({
      doi: "10.1091/mbc.e22-09-0443",
      resolutionProvenance: {
        method: "doi",
        confidence: "exact",
        requestedIdentifierType: "doi",
        requestedIdentifier: "10.1091/mbc.E22-09-0443",
      },
    });

    const result = await fetchFullText(paper, "https://api.biorxiv.org", {
      fetchUrl,
      processPdfWithGrobid: grobid,
      email: undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.acquisition.selectedMethod).toBe("pmc_xml");
    expect(result.data.acquisition.selectedLocatorKind).toBe("doi_input");
    expect(grobid).not.toHaveBeenCalled();
    expect(fetchUrl).toHaveBeenCalledTimes(1);
  });

  it("derives PMCID from PMC URLs before trying PDF acquisition", async () => {
    const grobid = vi.fn(async () =>
      Promise.resolve({ ok: true as const, data: "<tei />" }),
    );
    const fetchUrl = vi.fn(async (url: string) =>
      Promise.resolve({ ok: true as const, data: makeXmlResponse(url) }),
    );
    const paper = makePaper({
      doi: undefined,
      pmcid: undefined,
      fullTextHints: {
        providerAvailability: "available",
        providerSourceHint: "pmc_xml",
        pdfUrl: "https://example.com/paper.pdf",
        repositoryUrl:
          "https://pmc.ncbi.nlm.nih.gov/articles/PMC10092647/pdf/mbc-34-ar24.pdf",
      },
    });

    const result = await fetchFullText(paper, "https://api.biorxiv.org", {
      fetchUrl,
      processPdfWithGrobid: grobid,
      email: undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.acquisition.selectedMethod).toBe("pmc_xml");
    expect(result.data.acquisition.selectedLocatorKind).toBe(
      "pmcid_derived_url",
    );
    expect(grobid).not.toHaveBeenCalled();
    expect(fetchUrl).toHaveBeenCalledTimes(1);
  });

  it("rejects HTML returned from a PDF URL without invoking GROBID", async () => {
    const grobid = vi.fn(async () =>
      Promise.resolve({ ok: true as const, data: "<tei />" }),
    );
    const fetchUrl = vi.fn(async (url: string) =>
      Promise.resolve({
        ok: true as const,
        data: {
          finalUrl: url,
          status: 200,
          contentType: "text/html",
          body: Buffer.from(
            "<html><head><title>challenge</title></head></html>",
          ),
        },
      }),
    );

    const result = await fetchFullText(
      makePaper({ doi: undefined }),
      "https://api.biorxiv.org",
      {
        fetchUrl,
        processPdfWithGrobid: grobid,
        email: undefined,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("html_instead_of_pdf");
    expect(result.acquisition?.attempts.at(-1)?.probeClassification).toBe(
      "html_instead_of_pdf",
    );
    expect(grobid).not.toHaveBeenCalled();
  });
});
