import { describe, expect, it } from "vitest";

import { findCitationMentionsByRegex } from "../../src/retrieval/pdf-extractor.js";

const SAMPLE_TEXT = [
  "This is the introduction paragraph that sets the scene for the study.",
  "",
  "",
  "Previous work has shown that Rab35 plays a key role in endosomal recycling (Klenchenko et al., 2015). " +
    "This pathway is critical for cell polarity.",
  "",
  "",
  "In a separate line of inquiry, Smith et al. demonstrated a link between " +
    "vesicle trafficking and cell division (Smith et al., 2020).",
  "",
  "",
  "These results were later confirmed by Klenchenko and colleagues in 2015, " +
    "using improved imaging techniques.",
  "",
  "",
  "A short line.",
].join("\n");

describe("findCitationMentionsByRegex", () => {
  it("finds mentions matching author surname + year", () => {
    const mentions = findCitationMentionsByRegex(
      SAMPLE_TEXT,
      ["A. Klenchenko", "B. Borber"],
      "2015",
    );

    expect(mentions.length).toBeGreaterThanOrEqual(1);
    expect(mentions[0]!.provenance.sourceType).toBe("pdf_text");
    expect(mentions[0]!.provenance.parser).toBe("pdf-regex");
    expect(mentions[0]!.citationMarker).toContain("Klenchenko");
  });

  it("returns empty when year is missing", () => {
    const mentions = findCitationMentionsByRegex(
      SAMPLE_TEXT,
      ["Klenchenko A."],
      undefined,
    );
    expect(mentions).toEqual([]);
  });

  it("returns empty when no authors match", () => {
    const mentions = findCitationMentionsByRegex(
      SAMPLE_TEXT,
      ["Nonexistent Z."],
      "2015",
    );
    expect(mentions).toEqual([]);
  });

  it("extracts surname from full author name", () => {
    const mentions = findCitationMentionsByRegex(
      SAMPLE_TEXT,
      ["John Smith"],
      "2020",
    );
    expect(mentions.length).toBeGreaterThanOrEqual(1);
    expect(mentions[0]!.citationMarker).toContain("Smith");
  });

  it("does not match very short paragraphs", () => {
    const mentions = findCitationMentionsByRegex(
      "Short 2015 Klenchenko",
      ["Klenchenko"],
      "2015",
    );
    expect(mentions).toEqual([]);
  });
});
