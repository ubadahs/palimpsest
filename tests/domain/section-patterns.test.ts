import { describe, expect, it } from "vitest";

import { classifySectionRole } from "../../src/domain/section-patterns.js";

describe("classifySectionRole", () => {
  it("uses block kind before section title", () => {
    expect(classifySectionRole("abstract", "Results")).toBe("abstract");
    expect(classifySectionRole("figure_caption", "Results")).toBe("figure");
    expect(classifySectionRole("table_caption", undefined)).toBe("table");
  });

  it("maps common headings to results, methods, discussion, and introduction", () => {
    expect(classifySectionRole("body_paragraph", "Results")).toBe("results");
    expect(
      classifySectionRole("body_paragraph", "3. Results and Discussion"),
    ).toBe("results");
    expect(classifySectionRole("body_paragraph", "Materials and Methods")).toBe(
      "methods",
    );
    expect(classifySectionRole("body_paragraph", "Statistical analysis")).toBe(
      "methods",
    );
    expect(classifySectionRole("body_paragraph", "Discussion")).toBe(
      "discussion",
    );
    expect(classifySectionRole("body_paragraph", "Introduction")).toBe(
      "introduction",
    );
  });

  it("falls back to other for untitled or unrecognized body text", () => {
    expect(classifySectionRole("body_paragraph", undefined)).toBe("other");
    expect(classifySectionRole("body_paragraph", "Acknowledgements")).toBe(
      "other",
    );
  });
});
