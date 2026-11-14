import { describe, expect, it } from "vitest";

import {
  inferSurname,
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
        <p>Apical bulkheads help maintain elongated bile canaliculi in lining cells.</p>
      </abstract>
    </profileDesc>
  </teiHeader>
  <text>
    <body>
      <div>
        <head>Results</head>
        <p><ref type="bibr" target="#b1">Harlow et al., 2021</ref> showed that silencing Ril9 caused pocket formation and loss of surface ridges.</p>
        <figure>
          <head>Figure 2</head>
          <figDesc>Confocal microscopy reveals collapsed surface ridges after Ril9 knockdown.</figDesc>
        </figure>
      </div>
      <div>
        <head>Methods</head>
        <p>Cells were cultured in collagen sandwich conditions.</p>
        <figure type="table">
          <head>Table 1</head>
          <figDesc>Primer sequences and guide RNAs used for Ril9 perturbation.</figDesc>
        </figure>
      </div>
    </body>
  </text>
  <back>
    <listBibl>
      <biblStruct xml:id="b1">
        <analytic>
          <title level="a">Seed Paper Title</title>
          <author><persName><surname>Harlow</surname></persName></author>
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
      <p>Apical bulkheads are important for lining cell lumen morphogenesis.</p>
    </abstract>
  </front>
  <body>
    <sec>
      <title>Results</title>
      <p>Silencing of Ril9 resulted in loss of surface ridges and pocket formation in lining cells.</p>
    </sec>
  </body>
  <back>
    <ref-list>
      <ref id="bib2">
        <element-citation>
          <article-title>Seed Paper Title</article-title>
          <year>2021</year>
          <person-group>
            <name><surname>Harlow</surname></name>
          </person-group>
          <pub-id pub-id-type="doi">10.1234/seed</pub-id>
        </element-citation>
      </ref>
    </ref-list>
  </back>
</article>`;

describe("parseParsedPaperDocument", () => {
  it("rejects unsupported full-text formats", () => {
    const result = parseParsedPaperDocument(
      "Paragraph one.\n\nParagraph two that is long enough to look like body text.",
      "pdf_text" as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Unsupported full-text format/i);
  });

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
      citationMarker: "Harlow et al., 2021",
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
        authors: [],
      }),
    ).toMatchObject({ reference: { refId: "b1" }, method: "doi" });

    expect(
      matchReferenceByMetadata(parsed.data.references, {
        title: "Seed Paper Title",
        publicationYear: 2021,
        authors: ["Mara Harlow"],
      }),
    ).toMatchObject({
      reference: { refId: "b1" },
      method: "author_year_exact_title",
    });

    expect(
      matchReferenceByMetadata(parsed.data.references, {
        title: "Seed Paper Title",
        publicationYear: 1999,
        authors: ["Someone Else"],
      }),
    ).toBeUndefined();
  });

  it("uses conservative author-year-title overlap and rejects ambiguous matches", () => {
    const references = [
      {
        refId: "r1",
        title: "Sample efficiency under shifting light: a study",
        authorSurnames: ["Adeyemi", "Okonkwo"],
        year: 2009,
      },
      {
        refId: "r2",
        title: "Unrelated marine ecology observations",
        authorSurnames: ["Smith"],
        year: 2009,
      },
    ];
    const seed = {
      title: "Sample efficiency under shifting light",
      publicationYear: 2009,
      authors: ["Kamal Adeyemi"],
    };

    expect(matchReferenceByMetadata(references, seed)).toMatchObject({
      reference: { refId: "r1" },
      method: "author_year_title_overlap",
    });

    // Punctuation-only differences collapse to exact normalized title, but
    // still require compatible author and year.
    expect(
      matchReferenceByMetadata(references, {
        ...seed,
        title: "Sample efficiency under shifting light — a study!",
      })?.method,
    ).toBe("author_year_exact_title");

    // Unrelated title rejected.
    expect(
      matchReferenceByMetadata(references, {
        ...seed,
        title: "Completely different topic about whales",
      }),
    ).toBeUndefined();

    // Duplicate conservative candidates rejected as ambiguous.
    expect(
      matchReferenceByMetadata(
        [references[0]!, { ...references[0]!, refId: "r1-dup" }],
        seed,
      ),
    ).toBeUndefined();
  });

  describe("references that give no title", () => {
    const seed = {
      title: "Forecasting dark sector scattering with lensing",
      publicationYear: 2018,
      authors: ["Rin Halvorsen", "Teo Marchetti", "Ada Quist"],
      arxivId: "1801.00001",
      volume: "97",
    };

    it("matches an arXiv identifier", () => {
      expect(
        matchReferenceByMetadata(
          [
            {
              refId: "r1",
              authorSurnames: ["Halvorsen"],
              year: 2018,
              arxivId: "1801.00001",
            },
          ],
          seed,
        ),
      ).toMatchObject({ reference: { refId: "r1" }, method: "arxiv_id" });
    });

    it("matches first author, year, volume, and shared co-authors", () => {
      const reference = {
        refId: "r1",
        authorSurnames: ["Halvorsen", "Marchetti", "Quist"],
        year: 2018,
        volume: "97",
      };
      expect(matchReferenceByMetadata([reference], seed)).toMatchObject({
        reference: { refId: "r1" },
        method: "author_year_volume",
      });
      // Another volume, a lone shared author, or two candidates: no match.
      expect(
        matchReferenceByMetadata([{ ...reference, volume: "98" }], seed),
      ).toBeUndefined();
      expect(
        matchReferenceByMetadata(
          [{ ...reference, authorSurnames: ["Halvorsen", "Okafor"] }],
          seed,
        ),
      ).toBeUndefined();
      expect(
        matchReferenceByMetadata(
          [reference, { ...reference, refId: "r2" }],
          seed,
        ),
      ).toBeUndefined();
    });

    it("parses them from GROBID without taking the journal name as a title", () => {
      const tei = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><text><body><div><p>Text.</p></div></body>
<back><div type="references"><listBibl>
<biblStruct xml:id="b1"><monogr><title/>
  <author><persName><surname>Halvorsen</surname></persName></author>
  <idno type="arXiv">arXiv:1801.00001v2</idno>
  <imprint><date type="published" when="2018">2018</date></imprint></monogr>
  <note>ArXiv e-prints</note></biblStruct>
<biblStruct xml:id="b2"><analytic><title/>
  <author><persName><surname>Halvorsen</surname></persName></author>
  <author><persName><surname>Marchetti</surname></persName></author></analytic>
  <monogr><title level="j">Phys. Rev. D</title>
  <imprint><biblScope unit="volume">97</biblScope>
  <date type="published" when="2018">2018</date></imprint></monogr></biblStruct>
</listBibl></div></back></text></TEI>`;
      const parsed = parseParsedPaperDocument(tei, "grobid_tei_xml");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.data.references).toMatchObject([
        { refId: "b1", arxivId: "1801.00001", title: undefined },
        { refId: "b2", volume: "97", title: undefined },
      ]);
    });
  });

  it("infers common provider author-name forms conservatively", () => {
    expect(inferSurname("Kamal Adeyemi")).toBe("Adeyemi");
    expect(inferSurname("Adeyemi, Kamal")).toBe("Adeyemi");
    expect(inferSurname("Kamal Adeyemi Jr.")).toBe("Adeyemi");
    expect(inferSurname(undefined)).toBeUndefined();
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
    expect(seedGroups[0]?.sourceLocator?.kind).toBe("block_id");
    expect(seedGroups[0]?.sourceLocator?.value).toMatch(/#cg-\d+/);
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
    // Each repeated marker carries its own position in its paragraph.
    for (const mention of result.data.mentions) {
      const span = mention.markerSpan!;
      expect(
        mention.rawContext.slice(span.charOffsetStart, span.charOffsetEnd),
      ).toBe(mention.citationMarker);
    }
    expect(result.data.mentions[1]?.markerSpan?.charOffsetStart).toBeLessThan(
      result.data.mentions[2]!.markerSpan!.charOffsetStart,
    );
  });
});
