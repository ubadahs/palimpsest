import { describe, expect, it } from "vitest";

import {
  extractCitationMentions,
  findSeedReference,
  parseReferences,
} from "../../src/retrieval/jats-parser.js";

const SAMPLE_XML = `<?xml version="1.0"?>
<article>
  <body>
    <sec>
      <title>Introduction</title>
      <p>The role of Rab35 in membrane trafficking has been well characterized
      <xref ref-type="bibr" rid="bib7">Smith et al., 2018</xref>. Additional
      studies confirmed the finding <xref ref-type="bibr" rid="bib12">Jones 2020</xref>.</p>
    </sec>
    <sec>
      <title>Results</title>
      <p>We found that Rab35 acts upstream of ACAP2 <xref ref-type="bibr" rid="bib7">Smith et al., 2018</xref>.</p>
    </sec>
  </body>
  <back>
    <ref-list>
      <ref id="bib7">
        <element-citation>
          <person-group>
            <name><surname>Smith</surname><given-names>A</given-names></name>
            <name><surname>Doe</surname><given-names>B</given-names></name>
          </person-group>
          <article-title>Rab35 controls endosomal recycling</article-title>
          <pub-id pub-id-type="doi">10.1234/test.doi</pub-id>
          <label>7</label>
        </element-citation>
      </ref>
      <ref id="bib12">
        <element-citation>
          <person-group>
            <name><surname>Jones</surname><given-names>C</given-names></name>
          </person-group>
          <article-title>Endosomal sorting mechanisms</article-title>
          <pub-id pub-id-type="doi">10.5678/other.doi</pub-id>
          <label>12</label>
        </element-citation>
      </ref>
    </ref-list>
  </back>
</article>`;

describe("parseReferences", () => {
  it("extracts structured reference data from JATS XML", () => {
    const refs = parseReferences(SAMPLE_XML);

    expect(refs).toHaveLength(2);

    expect(refs[0]).toMatchObject({
      refId: "bib7",
      doi: "10.1234/test.doi",
      title: "Rab35 controls endosomal recycling",
      label: "7",
      authorSurnames: ["Smith", "Doe"],
    });

    expect(refs[1]).toMatchObject({
      refId: "bib12",
      doi: "10.5678/other.doi",
      title: "Endosomal sorting mechanisms",
      label: "12",
      authorSurnames: ["Jones"],
    });
  });

  it("returns empty array for XML with no ref-list", () => {
    expect(parseReferences("<article><body/></article>")).toEqual([]);
  });
});

describe("findSeedReference", () => {
  const refs = parseReferences(SAMPLE_XML);

  it("matches by DOI", () => {
    const found = findSeedReference(refs, "10.1234/test.doi", "anything");
    expect(found?.refId).toBe("bib7");
  });

  it("matches by DOI with https prefix", () => {
    const found = findSeedReference(
      refs,
      "https://doi.org/10.1234/test.doi",
      "anything",
    );
    expect(found?.refId).toBe("bib7");
  });

  it("falls back to title matching", () => {
    const found = findSeedReference(
      refs,
      undefined,
      "Endosomal Sorting Mechanisms",
    );
    expect(found?.refId).toBe("bib12");
  });

  it("returns undefined when no match", () => {
    expect(
      findSeedReference(refs, "10.9999/nope", "No Such Paper"),
    ).toBeUndefined();
  });
});

describe("extractCitationMentions", () => {
  it("finds xref mentions for target ref ID", () => {
    const mentions = extractCitationMentions(SAMPLE_XML, ["bib7"]);

    expect(mentions).toHaveLength(2);
    expect(mentions[0]!.citationMarker).toBe("Smith et al., 2018");
    expect(mentions[0]!.sectionTitle).toBe("Introduction");
    expect(mentions[0]!.provenance.sourceType).toBe("jats_xml");
    expect(mentions[0]!.provenance.parser).toBe("jats-xref");
    expect(mentions[0]!.provenance.refId).toBe("bib7");
    expect(mentions[0]!.isDuplicate).toBe(false);
    expect(mentions[0]!.contextLength).toBeGreaterThan(0);

    expect(mentions[1]!.sectionTitle).toBe("Results");
  });

  it("returns empty for non-matching ref ID", () => {
    expect(extractCitationMentions(SAMPLE_XML, ["bib99"])).toEqual([]);
  });

  it("assigns sequential mentionIndex", () => {
    const mentions = extractCitationMentions(SAMPLE_XML, ["bib7"]);
    expect(mentions.map((m) => m.mentionIndex)).toEqual([0, 1]);
  });

  it("populates bundle fields", () => {
    const mentions = extractCitationMentions(SAMPLE_XML, ["bib7"]);
    const m = mentions[0]!;
    expect(typeof m.isBundledCitation).toBe("boolean");
    expect(typeof m.bundleSize).toBe("number");
    expect(Array.isArray(m.bundleRefIds)).toBe(true);
    expect(m.bundlePattern).toBeDefined();
  });

  it("detects bundled citations when multiple xrefs in same paragraph", () => {
    const mentions = extractCitationMentions(SAMPLE_XML, ["bib7"]);
    const intro = mentions[0]!;
    expect(intro.bundleSize).toBeGreaterThanOrEqual(1);
  });
});
