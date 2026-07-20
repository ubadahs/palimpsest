import { describe, expect, it } from "vitest";

import {
  findReferenceByMetadata,
  inferFirstAuthorSurname,
  matchReferenceByMetadata,
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
      targetRefIds: ["b1"],
      citationMarker: "Belicova et al., 2021",
      sectionTitle: "Results",
      sourceType: "grobid_tei",
      locationQuality: "exact_dom",
    });
    expect(mention?.sourceLocator?.kind).toBe("block_id");

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
      matchReferenceByMetadata(parsed.data.references, {
        doi: "10.1234/seed",
        title: "Wrong title",
      }),
    ).toMatchObject({ reference: { refId: "b1" }, method: "doi" });

    expect(
      matchReferenceByMetadata(parsed.data.references, {
        title: "Seed Paper Title",
        publicationYear: 2021,
        firstAuthorSurname: "Belicova",
      }),
    ).toMatchObject({
      reference: { refId: "b1" },
      method: "author_year_exact_title",
    });

    expect(
      findReferenceByMetadata(parsed.data.references, {
        title: "Seed Paper Title",
        publicationYear: 2021,
        firstAuthorSurname: "Belicova",
      })?.refId,
    ).toBe("b1");

    expect(
      matchReferenceByMetadata(parsed.data.references, {
        title: "Seed Paper Title",
        publicationYear: 1999,
        firstAuthorSurname: "SomeoneElse",
      }),
    ).toBeUndefined();
  });

  it("uses conservative author-year-title overlap and rejects ambiguous matches", () => {
    const references = [
      {
        refId: "r1",
        title: "Photosynthetic efficiency under fluctuating light: a study",
        authorSurnames: ["Mets", "Meyer"],
        year: 2009,
      },
      {
        refId: "r2",
        title: "Unrelated marine ecology observations",
        authorSurnames: ["Smith"],
        year: 2009,
      },
    ];

    expect(
      matchReferenceByMetadata(references, {
        title: "Photosynthetic efficiency under fluctuating light",
        publicationYear: 2009,
        firstAuthorSurname: "Mets",
      }),
    ).toMatchObject({
      reference: { refId: "r1" },
      method: "author_year_title_overlap",
    });

    // Punctuation-only differences collapse to exact normalized title, but
    // still require compatible author and year.
    expect(
      matchReferenceByMetadata(references, {
        title: "Photosynthetic efficiency under fluctuating light — a study!",
        publicationYear: 2009,
        firstAuthorSurname: "Mets",
      })?.method,
    ).toBe("author_year_exact_title");

    // Unrelated title rejected.
    expect(
      matchReferenceByMetadata(references, {
        title: "Completely different topic about whales",
        publicationYear: 2009,
        firstAuthorSurname: "Mets",
      }),
    ).toBeUndefined();

    // Duplicate conservative candidates rejected as ambiguous.
    expect(
      matchReferenceByMetadata(
        [
          references[0]!,
          {
            ...references[0]!,
            refId: "r1-dup",
          },
        ],
        {
          title: "Photosynthetic efficiency under fluctuating light",
          publicationYear: 2009,
          firstAuthorSurname: "Mets",
        },
      ),
    ).toBeUndefined();
  });

  it("infers common provider author-name forms conservatively", () => {
    expect(inferFirstAuthorSurname("Laurens Mets")).toBe("Mets");
    expect(inferFirstAuthorSurname("Mets, Laurens")).toBe("Mets");
    expect(inferFirstAuthorSurname("Laurens Mets Jr.")).toBe("Mets");
    expect(inferFirstAuthorSurname(undefined)).toBeUndefined();
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

  it("emits one citation group per xref with exact targetRefIds and DOM offsets", () => {
    const xml = `<?xml version="1.0"?>
<article>
  <body>
    <sec>
      <title>Discussion</title>
      <p>Prior work (<xref ref-type="bibr" rid="r1">1</xref>; <xref ref-type="bibr" rid="r2">2</xref>; <xref ref-type="bibr" rid="seed">3</xref>) and later (<xref ref-type="bibr" rid="seed">3</xref>) support the claim.</p>
    </sec>
  </body>
  <back>
    <ref-list>
      <ref id="r1"><element-citation><article-title>One</article-title></element-citation></ref>
      <ref id="r2"><element-citation><article-title>Two</article-title></element-citation></ref>
      <ref id="seed"><element-citation><article-title>Seed</article-title></element-citation></ref>
    </ref-list>
  </back>
</article>`;
    const result = parseParsedPaperDocument(xml, "jats_xml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.mentions).toHaveLength(4);
    const seedGroups = result.data.mentions.filter((mention) =>
      mention.targetRefIds.includes("seed"),
    );
    expect(seedGroups).toHaveLength(2);
    expect(seedGroups[0]?.targetRefIds).toEqual(["seed"]);
    expect(seedGroups[0]?.bundleRefIds).toEqual(
      expect.arrayContaining(["r1", "r2", "seed"]),
    );
    expect(seedGroups[0]?.sourceLocator).toMatchObject({
      kind: "block_id",
      value: expect.stringMatching(/#cg-\d+/),
    });
    expect(seedGroups[0]?.locationQuality).toBe("exact_dom");
    expect(seedGroups[0]?.charOffsetStart).toBeLessThan(
      seedGroups[0]!.charOffsetEnd!,
    );
    expect(seedGroups[1]?.charOffsetStart).toBeGreaterThan(
      seedGroups[0]!.charOffsetEnd!,
    );
  });

  it("records missing location quality when DOM offsets cannot be recovered", () => {
    const xml = `<?xml version="1.0"?>
<article>
  <body>
    <sec>
      <title>Discussion</title>
      <p>See <xref ref-type="bibr" rid="seed">1</xref> for the claim.</p>
    </sec>
  </body>
  <back>
    <ref-list>
      <ref id="seed"><element-citation><article-title>Seed</article-title></element-citation></ref>
    </ref-list>
  </back>
</article>`;
    const result = parseParsedPaperDocument(xml, "jats_xml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mention = result.data.mentions[0];
    expect(mention?.targetRefIds).toEqual(["seed"]);
    expect(mention?.locationQuality).toBe("missing");
    expect(mention?.sourceLocator).toBeUndefined();
    expect(mention?.charOffsetStart).toBeUndefined();
    expect(mention?.charOffsetEnd).toBeUndefined();
  });

  it("keeps multi-target xrefs as one group and distinguishes repeated markers", () => {
    const tei = `<?xml version="1.0" encoding="UTF-8"?>
<TEI>
  <text>
    <body>
      <div>
        <p>See the earlier reports <ref type="bibr" target="#b1 #b2">1,2</ref> and again <ref type="bibr" target="#b1">1</ref> versus <ref type="bibr" target="#b1">1</ref> for the repeated marker case.</p>
      </div>
    </body>
  </text>
  <back>
    <listBibl>
      <biblStruct xml:id="b1"><analytic><title level="a">A</title></analytic></biblStruct>
      <biblStruct xml:id="b2"><analytic><title level="a">B</title></analytic></biblStruct>
    </listBibl>
  </back>
</TEI>`;
    const result = parseParsedPaperDocument(tei, "grobid_tei_xml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.mentions).toHaveLength(3);
    expect(result.data.mentions[0]?.targetRefIds).toEqual(["b1", "b2"]);
    expect(result.data.mentions[1]?.charOffsetStart).not.toBe(
      result.data.mentions[2]?.charOffsetStart,
    );
    expect(result.data.mentions[1]?.citationGroupOrdinal).toBe(1);
    expect(result.data.mentions[2]?.citationGroupOrdinal).toBe(2);
  });
});
