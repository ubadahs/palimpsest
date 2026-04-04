import { describe, expect, it } from "vitest";

import {
  findReferenceByMetadata,
  parseParsedPaperDocument,
} from "../../src/retrieval/parsed-paper.js";

const GROBID_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI>
  <teiHeader>
    <fileDesc>
      <sourceDesc>
        <biblStruct xml:id="header-ref">
          <analytic>
            <title level="a">Ignored header ref</title>
          </analytic>
        </biblStruct>
      </sourceDesc>
    </fileDesc>
    <profileDesc>
      <abstract>
        <p>Apical bulkheads help maintain elongated bile canaliculi in hepatocytes.</p>
      </abstract>
    </profileDesc>
  </teiHeader>
  <text>
    <body>
      <div>
        <head>Results</head>
        <p><ref type="bibr" target="#b1">Belicova et al., 2021</ref> showed that silencing Rab35 caused cyst formation and loss of apical bulkheads.</p>
        <figure>
          <head>Figure 2</head>
          <figDesc>Confocal microscopy reveals collapsed apical bulkheads after Rab35 knockdown.</figDesc>
        </figure>
      </div>
      <div>
        <head>Methods</head>
        <p>Cells were cultured in collagen sandwich conditions.</p>
        <figure type="table">
          <head>Table 1</head>
          <figDesc>Primer sequences and guide RNAs used for Rab35 perturbation.</figDesc>
        </figure>
      </div>
    </body>
  </text>
  <back>
    <listBibl>
      <biblStruct xml:id="b1">
        <analytic>
          <title level="a">Seed Paper Title</title>
          <author><persName><surname>Belicova</surname></persName></author>
        </analytic>
        <monogr>
          <imprint><date when="2021"/></imprint>
        </monogr>
        <idno type="doi">10.1234/seed</idno>
      </biblStruct>
      <biblStruct xml:id="b2">
        <analytic>
          <title level="a">Another Study</title>
          <author><persName><surname>Smith</surname></persName></author>
        </analytic>
        <monogr>
          <imprint><date when="2020"/></imprint>
        </monogr>
      </biblStruct>
    </listBibl>
  </back>
</TEI>`;

const JATS_XML = `<?xml version="1.0"?>
<article>
  <front>
    <abstract>
      <p>Apical bulkheads are important for hepatocyte lumen morphogenesis.</p>
    </abstract>
  </front>
  <body>
    <sec>
      <title>Results</title>
      <p>Silencing of Rab35 resulted in loss of apical bulkheads and cyst formation in hepatocytes.</p>
    </sec>
  </body>
  <back>
    <ref-list>
      <ref id="bib2">
        <element-citation>
          <article-title>Seed Paper Title</article-title>
          <year>2021</year>
          <person-group>
            <name><surname>Belicova</surname></name>
          </person-group>
          <pub-id pub-id-type="doi">10.1234/seed</pub-id>
        </element-citation>
      </ref>
    </ref-list>
  </back>
</article>`;

describe("parseParsedPaperDocument", () => {
  it("parses GROBID TEI references, mentions, section titles, and captions", () => {
    const result = parseParsedPaperDocument(GROBID_TEI, "grobid_tei_xml");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.parserKind).toBe("grobid_tei");
    expect(result.data.references).toHaveLength(2);
    expect(result.data.references[0]).toMatchObject({
      refId: "b1",
      doi: "10.1234/seed",
      title: "Seed Paper Title",
      year: 2021,
    });

    const mention = result.data.mentions[0];
    expect(mention).toMatchObject({
      refId: "b1",
      citationMarker: "Belicova et al., 2021",
      sectionTitle: "Results",
      sourceType: "grobid_tei",
    });

    const figureCaption = result.data.blocks.find(
      (block) => block.blockKind === "figure_caption",
    );
    const tableCaption = result.data.blocks.find(
      (block) => block.blockKind === "table_caption",
    );
    expect(figureCaption?.sectionTitle).toBe("Results");
    expect(tableCaption?.sectionTitle).toBe("Methods");
  });

  it("matches references by DOI first and title as a conservative fallback", () => {
    const parsed = parseParsedPaperDocument(GROBID_TEI, "grobid_tei_xml");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(
      findReferenceByMetadata(parsed.data.references, {
        doi: "10.1234/seed",
        title: "Wrong title",
      })?.refId,
    ).toBe("b1");

    expect(
      findReferenceByMetadata(parsed.data.references, {
        title: "Seed Paper Title",
      })?.refId,
    ).toBe("b1");
  });

  it("preserves the JATS structured happy path", () => {
    const result = parseParsedPaperDocument(JATS_XML, "jats_xml");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.parserKind).toBe("jats");
    expect(result.data.blocks[0]?.blockKind).toBe("abstract");
    expect(result.data.blocks[1]?.sectionTitle).toBe("Results");
    expect(result.data.references[0]?.refId).toBe("bib2");
  });
});
