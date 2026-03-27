import { describe, expect, it } from "vitest";

import type { CitationMention } from "../../src/domain/types.js";
import {
  annotateMention,
  assessConfidence,
  assessUsability,
  classifyContextType,
  classifyMarkerStyle,
  deduplicateMentions,
} from "../../src/retrieval/mention-analysis.js";

function baseMention(
  overrides: Partial<CitationMention> = {},
): CitationMention {
  return {
    mentionIndex: 0,
    rawContext:
      "This is a narrative paragraph about Rab35 function in membrane trafficking, citing Smith et al., 2021 as the primary source.",
    citationMarker: "Smith et al., 2021",
    sectionTitle: "Introduction",
    isDuplicate: false,
    contextLength: 120,
    markerStyle: "unknown",
    contextType: "unknown",
    confidence: "low",
    isBundledCitation: false,
    bundleSize: 1,
    bundleRefIds: [],
    bundlePattern: "single",
    provenance: {
      sourceType: "jats_xml",
      parser: "jats-xref",
      refId: "bib7",
      charOffsetStart: 80,
      charOffsetEnd: 98,
    },
    ...overrides,
  };
}

describe("classifyMarkerStyle", () => {
  it("recognizes author_year markers", () => {
    expect(classifyMarkerStyle("Smith et al., 2021")).toBe("author_year");
    expect(classifyMarkerStyle("Belicova et al., 2021")).toBe("author_year");
    expect(classifyMarkerStyle("Jones and Smith, 2020")).toBe("author_year");
  });

  it("recognizes numeric markers", () => {
    expect(classifyMarkerStyle("7")).toBe("numeric");
    expect(classifyMarkerStyle("42")).toBe("numeric");
  });

  it("recognizes year-only markers", () => {
    expect(classifyMarkerStyle("2021")).toBe("year_only");
  });

  it("returns unknown for unrecognizable markers", () => {
    expect(classifyMarkerStyle("ibid")).toBe("unknown");
  });
});

describe("classifyContextType", () => {
  it("detects bibliography-like text with many DOIs", () => {
    const bibText =
      "Adams DH 2019 10.1234/a Smith B 2020 10.5678/b Jones C 2021 10.9999/c and more refs";
    expect(classifyContextType(bibText, undefined)).toBe("bibliography_like");
  });

  it("detects methods-like from section title", () => {
    expect(
      classifyContextType(
        "Cells were cultured as described previously.",
        "Materials and Methods",
      ),
    ).toBe("methods_like");
  });

  it("classifies narrative paragraphs correctly", () => {
    const narrative =
      "Recent work has demonstrated that Rab35 plays a critical role in membrane trafficking during hepatocyte differentiation.";
    expect(classifyContextType(narrative, "Introduction")).toBe(
      "narrative_like",
    );
  });

  it("returns unknown for very short text", () => {
    expect(classifyContextType("Short.", undefined)).toBe("unknown");
  });
});

describe("assessConfidence", () => {
  it("returns high for author_year + narrative + long context", () => {
    expect(assessConfidence("author_year", "narrative_like", 150)).toBe("high");
  });

  it("returns low for bibliography_like context", () => {
    expect(assessConfidence("author_year", "bibliography_like", 300)).toBe(
      "low",
    );
  });

  it("returns medium for numeric + adequate length", () => {
    expect(assessConfidence("numeric", "narrative_like", 100)).toBe("medium");
  });
});

describe("deduplicateMentions", () => {
  it("removes exact duplicates by refId + context + offset", () => {
    const m1 = baseMention();
    const m2 = baseMention();
    const { unique, rawCount } = deduplicateMentions([m1, m2]);

    expect(rawCount).toBe(2);
    expect(unique).toHaveLength(1);
  });

  it("keeps distinct mentions with different contexts", () => {
    const m1 = baseMention();
    const m2 = baseMention({
      rawContext: "A completely different paragraph about other things.",
    });
    const { unique } = deduplicateMentions([m1, m2]);

    expect(unique).toHaveLength(2);
  });

  it("re-indexes after dedup", () => {
    const m1 = baseMention({ mentionIndex: 0 });
    const m2 = baseMention({ mentionIndex: 1 });
    const m3 = baseMention({
      mentionIndex: 2,
      rawContext: "Different context.",
      provenance: {
        ...baseMention().provenance,
        charOffsetStart: 999,
        charOffsetEnd: 1010,
      },
    });
    const { unique } = deduplicateMentions([m1, m2, m3]);

    expect(unique.map((m) => m.mentionIndex)).toEqual([0, 1]);
  });
});

describe("annotateMention", () => {
  it("fills in quality fields", () => {
    const raw = baseMention();
    const annotated = annotateMention(raw);

    expect(annotated.markerStyle).toBe("author_year");
    expect(annotated.contextType).toBe("narrative_like");
    expect(annotated.confidence).toBe("high");
    expect(annotated.contextLength).toBe(raw.rawContext.length);
  });
});

describe("assessUsability", () => {
  it("returns true when at least one narrative mention has medium+ confidence", () => {
    const mentions = [
      baseMention({ contextType: "narrative_like", confidence: "high" }),
    ];
    expect(assessUsability(mentions)).toBe(true);
  });

  it("returns false for all-bibliography mentions", () => {
    const mentions = [
      baseMention({ contextType: "bibliography_like", confidence: "low" }),
    ];
    expect(assessUsability(mentions)).toBe(false);
  });

  it("returns unknown for methods-only mentions", () => {
    const mentions = [
      baseMention({ contextType: "methods_like", confidence: "medium" }),
    ];
    expect(assessUsability(mentions)).toBe("unknown");
  });

  it("returns false for empty mentions", () => {
    expect(assessUsability([])).toBe(false);
  });
});
