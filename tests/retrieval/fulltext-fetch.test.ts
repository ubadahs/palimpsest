import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultAdapters,
  acquireFullText,
  classifyAcquisitionAttemptFailure,
  classifyHttpAcquisitionFailure,
  fetchFullText,
  type FullTextFetchResponse,
} from "../../src/retrieval/fulltext-fetch.js";
import { createAppConfig } from "../../src/config/app-config.js";
import { loadEnvironment } from "../../src/config/env.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import { upsertRawPaper } from "../../src/storage/paper-cache.js";
import { makePaper } from "../paper.fixture.js";

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

describe("typed full-text acquisition failures", () => {
  it("classifies publisher HTTP 401/403 as paywall, not provider auth", () => {
    expect(classifyHttpAcquisitionFailure(401)).toBe("paywall");
    expect(classifyHttpAcquisitionFailure(403)).toBe("paywall");
    expect(classifyHttpAcquisitionFailure(404)).toBe("not_found");
    expect(classifyHttpAcquisitionFailure(429)).toBe("rate_limited");
    expect(
      classifyAcquisitionAttemptFailure({
        httpStatus: 403,
        probeClassification: "http_error",
        failureReason: "HTTP 403 from http://www.cell.com/article/example/pdf",
      }),
    ).toBe("paywall");
  });

  it("returns a typed paywall failure when every PDF candidate is HTTP 403", async () => {
    const fetchUrl = vi.fn(async (url: string) =>
      Promise.resolve({
        ok: true as const,
        data: {
          finalUrl: url,
          status: 403,
          contentType: "text/html",
          body: Buffer.from("Forbidden"),
        },
      }),
    );
    const result = await fetchFullText(
      makePaper({
        fullTextHints: {
          providerAvailability: "available",
          locations: [
            {
              url: "http://www.cell.com/article/example/pdf",
              kind: "pdf",
              host: "publisher",
            },
          ],
        },
      }),
      "https://api.biorxiv.org",
      {
        fetchUrl,
        processPdfWithGrobid: () =>
          Promise.resolve({ ok: false as const, error: "unused" }),
        email: undefined,
        institutionalProxyUrl: undefined,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe("paywall");
    expect(result.error).toContain("HTTP 403");
  });
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
      institutionalProxyUrl: undefined,
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
        locations: [
          {
            url: "https://example.com/paper.pdf",
            kind: "pdf",
            host: "publisher",
          },
          {
            url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10092647/pdf/mbc-34-ar24.pdf",
            kind: "pdf",
            host: "repository",
          },
        ],
      },
    });

    const result = await fetchFullText(paper, "https://api.biorxiv.org", {
      fetchUrl,
      processPdfWithGrobid: grobid,
      email: undefined,
      institutionalProxyUrl: undefined,
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
        institutionalProxyUrl: undefined,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.failureCode).toBe("invalid_content");
    expect(result.error).toContain("html_instead_of_pdf");
    expect(result.acquisition?.attempts.at(-1)?.probeClassification).toBe(
      "html_instead_of_pdf",
    );
    expect(grobid).not.toHaveBeenCalled();
  });

  it("falls back to institutional proxy when open-access PDF fails", async () => {
    const PDF_MAGIC = Buffer.from("%PDF-1.4 fake pdf content");
    const grobid = vi.fn(async () =>
      Promise.resolve({ ok: true as const, data: "<tei>proxied</tei>" }),
    );
    const fetchUrl = vi.fn(async (url: string) => {
      // Open-access URLs return HTML paywall page
      if (!url.startsWith("https://proxy.example.edu/")) {
        return Promise.resolve({
          ok: true as const,
          data: {
            finalUrl: url,
            status: 200,
            contentType: "text/html",
            body: Buffer.from("<html>paywall</html>"),
          },
        });
      }
      // Proxy-prefixed URLs succeed with a real PDF
      return Promise.resolve({
        ok: true as const,
        data: {
          finalUrl: url,
          status: 200,
          contentType: "application/pdf",
          body: PDF_MAGIC,
        },
      });
    });

    const paper = makePaper({
      doi: "10.0000/nature00000",
      fullTextHints: {
        providerAvailability: "available",
        locations: [
          {
            url: "https://www.nature.com/articles/nature00000.pdf",
            kind: "pdf",
            host: "publisher",
          },
          {
            url: "https://www.nature.com/articles/nature00000",
            kind: "landing_page",
            host: "publisher",
          },
        ],
      },
    });

    const result = await fetchFullText(paper, "https://api.biorxiv.org", {
      fetchUrl,
      processPdfWithGrobid: grobid,
      email: undefined,
      institutionalProxyUrl: "https://proxy.example.edu/login?url=",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.acquisition.accessChannel).toBe("institutional_proxy");
    expect(result.data.acquisition.selectedMethod).toBe("direct_pdf_grobid");
    expect(grobid).toHaveBeenCalledWith(PDF_MAGIC);
  });

  it("falls back to a repository copy after the publisher's version", async () => {
    const PDF_MAGIC = Buffer.from("%PDF-1.4 preprint");
    const publisherPage = "https://iopscience.iop.org/article/10.1088/x";
    const preprintUrl = "https://arxiv.org/pdf/2010.04074";
    const grobid = vi.fn(async () =>
      Promise.resolve({ ok: true as const, data: "<tei>preprint</tei>" }),
    );
    const fetchUrl = vi.fn(async (url: string) =>
      Promise.resolve({
        ok: true as const,
        data:
          url === preprintUrl
            ? {
                finalUrl: url,
                status: 200,
                contentType: "application/pdf",
                body: PDF_MAGIC,
              }
            : {
                finalUrl: url,
                status: 200,
                contentType: "text/html",
                body: Buffer.from("<html>challenge</html>"),
              },
      }),
    );
    const paper = makePaper({
      doi: undefined,
      fullTextHints: {
        providerAvailability: "available",
        // Provider order lists the preprint first; the version of record
        // is still tried before it.
        locations: [
          { url: preprintUrl, kind: "pdf", host: "repository" },
          { url: publisherPage, kind: "landing_page", host: "publisher" },
        ],
      },
    });

    const result = await fetchFullText(paper, "https://api.biorxiv.org", {
      fetchUrl,
      processPdfWithGrobid: grobid,
      email: undefined,
      institutionalProxyUrl: undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.acquisition.selectedUrl).toBe(preprintUrl);
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
      publisherPage,
      preprintUrl,
    ]);
  });

  it("reports a PDF that failed to parse over a later challenge page", async () => {
    const fetchUrl = vi.fn(async (url: string) =>
      Promise.resolve({
        ok: true as const,
        data: url.endsWith(".pdf")
          ? {
              finalUrl: url,
              status: 200,
              contentType: "application/pdf",
              body: Buffer.from("%PDF-1.4 slow"),
            }
          : {
              finalUrl: url,
              status: 200,
              contentType: "text/html",
              body: Buffer.from("<html>challenge</html>"),
            },
      }),
    );
    const paper = makePaper({
      doi: undefined,
      fullTextHints: {
        providerAvailability: "available",
        locations: [
          {
            url: "https://example.org/paper.pdf",
            kind: "pdf",
            host: "publisher",
          },
          { url: "https://example.org/pdf/x", kind: "pdf", host: "publisher" },
        ],
      },
    });

    const result = await fetchFullText(paper, "https://api.biorxiv.org", {
      fetchUrl,
      processPdfWithGrobid: () =>
        Promise.resolve({
          ok: false as const,
          error: "GROBID parse error: timeout",
        }),
      email: undefined,
      institutionalProxyUrl: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.acquisition?.attempts.at(-1)?.probeClassification).toBe(
      "html_instead_of_pdf",
    );
    expect(result.error).toContain("GROBID parse error");
  });

  it("tags open-access acquisitions with accessChannel open_access", async () => {
    const grobid = vi.fn(async () =>
      Promise.resolve({ ok: true as const, data: "<tei />" }),
    );
    const fetchUrl = vi.fn(async (url: string) =>
      Promise.resolve({ ok: true as const, data: makeXmlResponse(url) }),
    );
    const paper = makePaper({
      pmcid: "PMC1234567",
      fullTextHints: {
        providerAvailability: "available",
        locations: [],
      },
    });

    const result = await fetchFullText(paper, "https://api.biorxiv.org", {
      fetchUrl,
      processPdfWithGrobid: grobid,
      email: undefined,
      institutionalProxyUrl: undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.acquisition.accessChannel).toBe("open_access");
  });

  it("does not fabricate acquisition provenance for pre-provenance cache rows", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "palimpsest-ft-"));
    const database = openDatabase(join(tempDirectory, "cache.sqlite"));
    try {
      runMigrations(database);
      const paper = makePaper({
        pmcid: "PMC1234567",
        fullTextHints: {
          providerAvailability: "available",
          locations: [],
        },
      });
      upsertRawPaper(database, {
        paperId: paper.id,
        rawFullText: PMC_XML,
        fullTextFormat: "jats_xml",
      });

      const fetchUrl = vi.fn(async (url: string) =>
        Promise.resolve({ ok: true as const, data: makeXmlResponse(url) }),
      );
      const result = await acquireFullText(
        paper,
        "https://api.biorxiv.org",
        {
          fetchUrl,
          processPdfWithGrobid: async () =>
            Promise.resolve({ ok: true as const, data: "<tei />" }),
          email: undefined,
          institutionalProxyUrl: undefined,
        },
        { db: database, cachePolicy: "prefer_cache" },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fetchUrl).toHaveBeenCalled();
      expect(result.data.acquisition.materializationSource).toBe("network");
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("GROBID concurrency bound", () => {
  it("sends at most grobidConcurrency PDFs to GROBID at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchStub = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response("<TEI/>", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const adapters = createDefaultAdapters({
        grobidBaseUrl: "http://localhost:8070",
        grobidConcurrency: 2,
        email: undefined,
      });
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          adapters.processPdfWithGrobid(Buffer.from("%PDF-1.4")),
        ),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      expect(fetchStub).toHaveBeenCalledTimes(6);
      expect(maxInFlight).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads the bound from GROBID_CONCURRENCY, default 2", () => {
    expect(
      createAppConfig(loadEnvironment({ GROBID_BASE_URL: "http://g:8070" }))
        .grobidConcurrency,
    ).toBe(2);
    expect(
      createAppConfig(
        loadEnvironment({
          GROBID_BASE_URL: "http://g:8070",
          GROBID_CONCURRENCY: "4",
        }),
      ).grobidConcurrency,
    ).toBe(4);
  });
});
