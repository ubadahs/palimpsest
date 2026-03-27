import { describe, expect, it } from "vitest";

import type { CitationMention } from "../../src/domain/types.js";
import { classifyMention } from "../../src/classification/classify-citation-function.js";

function mention(overrides: Partial<CitationMention> = {}): CitationMention {
  return {
    mentionIndex: 0,
    rawContext: "",
    citationMarker: "Belicova et al., 2021",
    sectionTitle: undefined,
    isDuplicate: false,
    contextLength: 200,
    markerStyle: "author_year",
    contextType: "narrative_like",
    confidence: "high",
    isBundledCitation: false,
    bundleSize: 1,
    bundleRefIds: [],
    bundlePattern: "single",
    provenance: {
      sourceType: "jats_xml",
      parser: "jats-xref",
      refId: "bib2",
      charOffsetStart: 50,
      charOffsetEnd: 72,
    },
    ...overrides,
  };
}

describe("classifyMention", () => {
  it("classifies methods section as methods_materials", () => {
    const m = mention({
      sectionTitle: "Materials and Methods",
      rawContext:
        "Hepatoblast isolation was performed as described in Belicova et al., 2021.",
    });
    const result = classifyMention(m, false);
    expect(result.citationRole).toBe("methods_materials");
    expect(result.modifiers.isReviewMediated).toBe(false);
  });

  it("classifies attribution verbs as substantive_attribution", () => {
    const m = mention({
      sectionTitle: "Results",
      rawContext:
        "Belicova et al., 2021 demonstrated that silencing Rab35 leads to cyst formation.",
    });
    expect(classifyMention(m, false).citationRole).toBe(
      "substantive_attribution",
    );
  });

  it("classifies broad intro language as background_context", () => {
    const m = mention({
      sectionTitle: "Introduction",
      rawContext:
        "The role of Rab35 in membrane trafficking has been well characterized (Belicova et al., 2021).",
    });
    expect(classifyMention(m, false).citationRole).toBe("background_context");
  });

  it("bundled citation keeps its content role + sets isBundled modifier", () => {
    const m = mention({
      sectionTitle: "Introduction",
      rawContext:
        "The role of Rab35 has been well characterized (Smith 2019; Jones 2020; Belicova et al., 2021).",
      isBundledCitation: true,
      bundleSize: 3,
    });
    const result = classifyMention(m, false);
    expect(result.citationRole).toBe("background_context");
    expect(result.modifiers.isBundled).toBe(true);
  });

  it("classifies short low-confidence context as acknowledgment_or_low_information", () => {
    const m = mention({
      rawContext: "See also Belicova et al., 2021.",
      contextLength: 30,
      confidence: "low",
    });
    expect(classifyMention(m, false).citationRole).toBe(
      "acknowledgment_or_low_information",
    );
  });

  it("returns unclear when no signals fire", () => {
    const m = mention({
      sectionTitle: "Results",
      rawContext:
        "We also looked at other proteins alongside Belicova et al., 2021 data.",
    });
    expect(classifyMention(m, false).citationRole).toBe("unclear");
  });

  it("sets isReviewMediated from citing paper type", () => {
    const m = mention({
      rawContext: "Belicova et al., 2021 showed X.",
      sectionTitle: "Results",
    });
    const result = classifyMention(m, true);
    expect(result.modifiers.isReviewMediated).toBe(true);
  });

  it("preserves bundle fields and provenance", () => {
    const m = mention({ isBundledCitation: true, bundleSize: 4 });
    const result = classifyMention(m, false);
    expect(result.isBundledCitation).toBe(true);
    expect(result.bundleSize).toBe(4);
    expect(result.provenance.refId).toBe("bib2");
    expect(result.modifiers.isBundled).toBe(true);
  });
});
