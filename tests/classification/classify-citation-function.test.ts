import { describe, expect, it } from "vitest";

import {
  classifyCitationFunction,
  type CitationFunctionInput,
} from "../../src/classification/classify-citation-function.js";

function mention(
  overrides: Partial<CitationFunctionInput> = {},
): CitationFunctionInput {
  return {
    rawContext: "",
    citationMarker: "Belicova et al., 2021",
    sectionTitle: undefined,
    contextLength: 200,
    confidence: "high",
    isBundledCitation: false,
    bundleSize: 1,
    ...overrides,
  };
}

describe("classifyCitationFunction", () => {
  it("classifies methods section as methods_materials", () => {
    const m = mention({
      sectionTitle: "Materials and Methods",
      rawContext:
        "Hepatoblast isolation was performed as described in Belicova et al., 2021.",
    });
    const result = classifyCitationFunction(m, false);
    expect(result.citationRole).toBe("methods_materials");
    expect(result.modifiers.isReviewMediated).toBe(false);
  });

  it("classifies attribution verbs as substantive_attribution", () => {
    const m = mention({
      sectionTitle: "Results",
      rawContext:
        "Belicova et al., 2021 demonstrated that silencing Rab35 leads to cyst formation.",
    });
    expect(classifyCitationFunction(m, false).citationRole).toBe(
      "substantive_attribution",
    );
  });

  it("classifies broad intro language as background_context", () => {
    const m = mention({
      sectionTitle: "Introduction",
      rawContext:
        "The role of Rab35 in membrane trafficking has been well characterized (Belicova et al., 2021).",
    });
    expect(classifyCitationFunction(m, false).citationRole).toBe(
      "background_context",
    );
  });

  it("bundled citation keeps its content role + sets isBundled modifier", () => {
    const m = mention({
      sectionTitle: "Introduction",
      rawContext:
        "The role of Rab35 has been well characterized (Smith 2019; Jones 2020; Belicova et al., 2021).",
      isBundledCitation: true,
      bundleSize: 3,
    });
    const result = classifyCitationFunction(m, false);
    expect(result.citationRole).toBe("background_context");
    expect(result.modifiers.isBundled).toBe(true);
  });

  it("classifies short low-confidence context as acknowledgment_or_low_information", () => {
    const m = mention({
      rawContext: "See also Belicova et al., 2021.",
      contextLength: 30,
      confidence: "low",
    });
    expect(classifyCitationFunction(m, false).citationRole).toBe(
      "acknowledgment_or_low_information",
    );
  });

  it("returns unclear when no signals fire", () => {
    const m = mention({
      sectionTitle: "Supplementary Note",
      citationMarker: "[12]",
      rawContext: "We also looked at other proteins alongside [12] data.",
    });
    expect(classifyCitationFunction(m, false).citationRole).toBe("unclear");
  });

  it("treats author-year cites in Results as substantive for bundled fidelity use", () => {
    const m = mention({
      sectionTitle: "Results",
      citationMarker: "Marlowe et al., 2020",
      rawContext:
        "LP neurons receive input from many areas (Marlowe et al., 2020; Jones 2019).",
      isBundledCitation: true,
      bundleSize: 2,
      contextLength: 120,
      confidence: "medium",
    });
    const result = classifyCitationFunction(m, false);
    expect(result.citationRole).toBe("substantive_attribution");
    expect(result.modifiers.isBundled).toBe(true);
  });

  it("sets isReviewMediated from citing paper type", () => {
    const m = mention({
      rawContext: "Belicova et al., 2021 showed X.",
      sectionTitle: "Results",
    });
    const result = classifyCitationFunction(m, true);
    expect(result.modifiers.isReviewMediated).toBe(true);
  });

  it("sets isBundled when the mention is bundled", () => {
    const m = mention({ isBundledCitation: true, bundleSize: 4 });
    const result = classifyCitationFunction(m, false);
    expect(result.modifiers.isBundled).toBe(true);
    expect(result.modifiers.bundleSize).toBe(4);
  });

  it("classifies an occurrence-local bundled attribution without forcing unclear", () => {
    // After citation-group correction, the occurrence targets one seed even when
    // the source marker sits inside a multi-reference group.
    const m = mention({
      sectionTitle: "Results",
      citationMarker: "Belicova et al., 2021",
      rawContext:
        "Earlier work showed and demonstrated that VRN shapes Pvalb expression (Smith 2019; Belicova et al., 2021; Jones 2020).",
      isBundledCitation: true,
      bundleSize: 3,
      contextLength: 140,
      confidence: "medium",
    });
    const result = classifyCitationFunction(m, false);
    expect(result.citationRole).toBe("substantive_attribution");
    expect(result.modifiers.isBundled).toBe(true);
  });

  it("keeps genuinely signal-free numeric cites as unclear for manual review", () => {
    const m = mention({
      sectionTitle: "Supplementary Note",
      citationMarker: "[12]",
      rawContext:
        "Additional related observations appear near [12] without a decisive claim verb.",
      isBundledCitation: false,
      bundleSize: 1,
      contextLength: 120,
      confidence: "medium",
    });
    expect(classifyCitationFunction(m, false).citationRole).toBe("unclear");
  });

  it("keeps thin see-also author-year acknowledgments as low-information", () => {
    const m = mention({
      citationMarker: "Belicova et al., 2021",
      rawContext: "See also Belicova et al., 2021.",
      contextLength: 30,
      confidence: "low",
    });
    expect(classifyCitationFunction(m, false).citationRole).toBe(
      "acknowledgment_or_low_information",
    );
  });
});
