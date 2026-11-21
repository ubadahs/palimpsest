import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FullTextFetchAdapters } from "../../src/retrieval/fulltext-fetch.js";
import { materializeParsedPaper } from "../../src/retrieval/parsed-paper.js";
import { sha256Text } from "../../src/shared/stable-identity.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import {
  computeContentHash,
  upsertRawPaper,
} from "../../src/storage/paper-cache.js";
import { makePaper } from "../paper.fixture.js";

const pmcUrl = "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/";
const incompleteJats =
  "<article><body><p>This is a full body paragraph from an article with no bibliography.</p></body></article>";
const html = `<!doctype html><html><head><meta name="citation_doi" content="10.1234/EXAMPLE"></head><body>
<section class="main-article-body">
  <section class="abstract"><p>Article abstract.</p></section>
  <section><h2>Results</h2><p>Earlier work (<a href="#r1">Author, 2024</a>) found &alpha;.</p></section>
  <section class="ref-list"><ol><li id="r1"><cite>Author, 2024</cite>
    <a href="https://doi.org/10.1234/seed">DOI</a></li></ol></section>
</section></body></html>`;

function makeAdapters(
  page = html,
  finalPmcUrl = pmcUrl,
): FullTextFetchAdapters {
  return {
    fetchUrl: vi.fn((url: string) =>
      Promise.resolve({
        ok: true as const,
        data: {
          status: 200,
          finalUrl: url === pmcUrl ? finalPmcUrl : url,
          contentType: url === pmcUrl ? "text/html" : "application/xml",
          body: Buffer.from(url === pmcUrl ? page : incompleteJats),
        },
      }),
    ),
    processPdfWithGrobid: () => Promise.resolve({ ok: false, error: "unused" }),
    email: undefined,
    institutionalProxyUrl: undefined,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("citation-harvest article completeness", () => {
  const paper = makePaper({
    pmcid: "PMC123",
    fullTextHints: { providerAvailability: "available", locations: [] },
  });
  const bioRxiv = "https://api.biorxiv.org";

  it("retries incomplete raw cache and XML using the verified PMC article page", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ records: [] })),
    );
    const directory = mkdtempSync(join(tmpdir(), "citing-acquisition-"));
    const db = openDatabase(join(directory, "cache.sqlite"));
    try {
      runMigrations(db);
      const first = await materializeParsedPaper(
        paper,
        bioRxiv,
        makeAdapters(),
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      upsertRawPaper(db, {
        paperId: paper.id,
        rawFullText: first.data.fullText.content,
        fullTextFormat: first.data.fullText.format,
        contentHash: computeContentHash(first.data.fullText.content),
        acquisitionProvenanceJson: JSON.stringify(first.data.acquisition),
      });

      const result = await materializeParsedPaper(
        paper,
        bioRxiv,
        makeAdapters(),
        { db, cachePolicy: "prefer_cache" },
        "citation_harvest",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.acquisition.selectedMethod).toBe(
        "pmc_html_projection",
      );
      expect(result.data.acquisition.attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            candidateKind: "raw_cache",
            contentHash: computeContentHash(incompleteJats),
            probeClassification: "incomplete_full_text",
            success: false,
          }),
          expect.objectContaining({
            candidateKind: "pmc_xml",
            probeClassification: "incomplete_full_text",
            success: false,
          }),
          expect.objectContaining({
            candidateKind: "pmc_html",
            rawHtmlSha256: sha256Text(html),
            derivedXmlSha256: sha256Text(result.data.fullText.content),
            success: true,
          }),
        ]),
      );
      expect(result.data.parsedDocument.references[0]?.doi).toBe(
        "10.1234/seed",
      );
      const mention = result.data.parsedDocument.mentions[0];
      expect(mention?.rawContext).toBe("Earlier work (Author, 2024) found α.");
      expect(mention?.markerSpan).toEqual({
        charOffsetStart: 14,
        charOffsetEnd: 26,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [html.replace("10.1234/EXAMPLE", "10.1234/other"), pmcUrl],
    [html, "https://example.org/articles/PMC123/"],
  ])(
    "records incomplete articles when the alternative article identity fails",
    async (page, finalUrl) => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(Response.json({ records: [] })),
      );
      const result = await materializeParsedPaper(
        paper,
        bioRxiv,
        makeAdapters(page, finalUrl),
        undefined,
        "citation_harvest",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failureCode).toBe("incomplete_content");
      const attempt = result.acquisition?.attempts.find(
        (item) => item.candidateKind === "pmc_html",
      );
      expect(attempt).toMatchObject({
        probeClassification: "invalid_pmc_html",
        success: false,
      });
    },
  );
});
