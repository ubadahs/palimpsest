import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedPaper } from "../../src/domain/types.js";
import {
  materializeParsedPaper,
  PARSED_PAPER_PARSER_VERSION,
} from "../../src/retrieval/parsed-paper.js";
import {
  fetchFullText,
  type FullTextFetchAdapters,
} from "../../src/retrieval/fulltext-fetch.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import {
  computeContentHash,
  upsertParsedData,
  upsertRawPaper,
} from "../../src/storage/paper-cache.js";

const RAW_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI>
  <text>
    <body>
      <div>
        <head>Results</head>
        <p>Silencing of Rab35 caused cyst formation and loss of apical bulkheads.</p>
      </div>
    </body>
  </text>
  <back>
    <listBibl>
      <biblStruct xml:id="b1">
        <analytic><title level="a">Seed Paper</title></analytic>
      </biblStruct>
    </listBibl>
  </back>
</TEI>`;

const UPDATED_RAW_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI>
  <text>
    <body>
      <div>
        <head>Discussion</head>
        <p>Updated full text with a different section title and revised interpretation.</p>
      </div>
    </body>
  </text>
</TEI>`;

function makePaper(): ResolvedPaper {
  return {
    id: "paper-1",
    title: "Cached Paper",
    doi: "10.1234/cached",
    authors: ["Alice Smith"],
    abstract: undefined,
    source: "openalex",
    openAccessUrl: "https://example.com/paper.pdf",
    openAccessPdfUrl: "https://example.com/paper.pdf",
    fullTextStatus: {
      status: "available",
      source: "publisher_pdf",
    },
    paperType: "article",
    referencedWorksCount: 12,
    publicationYear: 2024,
    resolutionProvenance: {
      method: "doi",
      confidence: "exact",
    },
  };
}

function makeAdapters(
  teiXml: string,
  counters: { fetchPdf: number; processPdfWithGrobid: number },
): FullTextFetchAdapters {
  return {
    fetchXml: () => Promise.resolve({ ok: false as const, error: "not used" }),
    fetchPdf: () => {
      counters.fetchPdf++;
      return Promise.resolve({ ok: true as const, data: Buffer.from("pdf") });
    },
    processPdfWithGrobid: () => {
      counters.processPdfWithGrobid++;
      return Promise.resolve({ ok: true as const, data: teiXml });
    },
    email: undefined,
  };
}

describe("paper cache integration", () => {
  let tempDirectory = "";

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "citation-fidelity-cache-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("reuses cached raw full text on subsequent fetches", async () => {
    const database = openDatabase(join(tempDirectory, "cache.sqlite"));
    runMigrations(database);

    const counters = { fetchPdf: 0, processPdfWithGrobid: 0 };
    const paper = makePaper();
    const adapters = makeAdapters(RAW_TEI, counters);

    try {
      const first = await fetchFullText(
        paper,
        "https://api.biorxiv.org",
        adapters,
        {
          db: database,
          cachePolicy: "prefer_cache",
        },
      );
      const second = await fetchFullText(
        paper,
        "https://api.biorxiv.org",
        adapters,
        {
          db: database,
          cachePolicy: "prefer_cache",
        },
      );

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(counters.fetchPdf).toBe(1);
      expect(counters.processPdfWithGrobid).toBe(1);
    } finally {
      database.close();
    }
  });

  it("reuses cached parsed papers when the content hash matches", async () => {
    const database = openDatabase(join(tempDirectory, "parsed.sqlite"));
    runMigrations(database);

    const paper = makePaper();
    const contentHash = computeContentHash(RAW_TEI);
    upsertRawPaper(database, {
      paperId: paper.id,
      doi: paper.doi,
      openalexId: undefined,
      pmcid: undefined,
      title: paper.title,
      authorsJson: JSON.stringify(paper.authors),
      accessStatus: "available",
      rawFullText: RAW_TEI,
      fullTextFormat: "grobid_tei_xml",
      fetchSourceUrl: paper.openAccessPdfUrl,
      fetchStatus: "success",
      contentHash,
      fetchedAt: new Date().toISOString(),
      metadataJson: undefined,
    });
    upsertParsedData(database, {
      paperId: paper.id,
      parserVersion: PARSED_PAPER_PARSER_VERSION,
      parserKind: "grobid_tei",
      contentHash,
      sectionsJson: JSON.stringify(["Cached Section"]),
      refsJson: "[]",
      chunksJson: JSON.stringify([
        {
          blockId: "cached-1",
          text: "Loaded from parsed cache",
          sectionTitle: "Cached Section",
          blockKind: "body_paragraph",
          charOffsetStart: 0,
          charOffsetEnd: 23,
        },
      ]),
      mentionsJson: "[]",
      parsedAt: new Date().toISOString(),
    });

    try {
      const result = await materializeParsedPaper(
        paper,
        "https://api.biorxiv.org",
        makeAdapters(UPDATED_RAW_TEI, { fetchPdf: 0, processPdfWithGrobid: 0 }),
        {
          db: database,
          cachePolicy: "prefer_cache",
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data.parsedDocument.blocks[0]?.text).toBe(
        "Loaded from parsed cache",
      );
      expect(result.data.parsedDocument.blocks[0]?.sectionTitle).toBe(
        "Cached Section",
      );
    } finally {
      database.close();
    }
  });

  it("invalidates cached parsed papers when the raw content hash changes", async () => {
    const database = openDatabase(join(tempDirectory, "invalidate.sqlite"));
    runMigrations(database);

    const paper = makePaper();
    upsertRawPaper(database, {
      paperId: paper.id,
      doi: paper.doi,
      openalexId: undefined,
      pmcid: undefined,
      title: paper.title,
      authorsJson: JSON.stringify(paper.authors),
      accessStatus: "available",
      rawFullText: UPDATED_RAW_TEI,
      fullTextFormat: "grobid_tei_xml",
      fetchSourceUrl: paper.openAccessPdfUrl,
      fetchStatus: "success",
      contentHash: computeContentHash(UPDATED_RAW_TEI),
      fetchedAt: new Date().toISOString(),
      metadataJson: undefined,
    });
    upsertParsedData(database, {
      paperId: paper.id,
      parserVersion: PARSED_PAPER_PARSER_VERSION,
      parserKind: "grobid_tei",
      contentHash: computeContentHash(RAW_TEI),
      sectionsJson: JSON.stringify(["Stale Section"]),
      refsJson: "[]",
      chunksJson: JSON.stringify([
        {
          blockId: "stale-1",
          text: "Stale parsed content",
          sectionTitle: "Stale Section",
          blockKind: "body_paragraph",
          charOffsetStart: 0,
          charOffsetEnd: 20,
        },
      ]),
      mentionsJson: "[]",
      parsedAt: new Date().toISOString(),
    });

    try {
      const result = await materializeParsedPaper(
        paper,
        "https://api.biorxiv.org",
        makeAdapters(RAW_TEI, { fetchPdf: 0, processPdfWithGrobid: 0 }),
        {
          db: database,
          cachePolicy: "prefer_cache",
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data.parsedDocument.blocks[0]?.text).toContain(
        "Updated full text",
      );
      expect(result.data.parsedDocument.blocks[0]?.sectionTitle).toBe(
        "Discussion",
      );
    } finally {
      database.close();
    }
  });

  it("bypasses cache entries when force refresh is requested", async () => {
    const database = openDatabase(join(tempDirectory, "force-refresh.sqlite"));
    runMigrations(database);

    const paper = makePaper();
    upsertRawPaper(database, {
      paperId: paper.id,
      doi: paper.doi,
      openalexId: undefined,
      pmcid: undefined,
      title: paper.title,
      authorsJson: JSON.stringify(paper.authors),
      accessStatus: "available",
      rawFullText: RAW_TEI,
      fullTextFormat: "grobid_tei_xml",
      fetchSourceUrl: paper.openAccessPdfUrl,
      fetchStatus: "success",
      contentHash: computeContentHash(RAW_TEI),
      fetchedAt: new Date().toISOString(),
      metadataJson: undefined,
    });

    const counters = { fetchPdf: 0, processPdfWithGrobid: 0 };

    try {
      const result = await fetchFullText(
        paper,
        "https://api.biorxiv.org",
        makeAdapters(UPDATED_RAW_TEI, counters),
        {
          db: database,
          cachePolicy: "force_refresh",
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data.content).toBe(UPDATED_RAW_TEI);
      expect(counters.fetchPdf).toBe(1);
      expect(counters.processPdfWithGrobid).toBe(1);
    } finally {
      database.close();
    }
  });
});
