import { describe, expect, it } from "vitest";

import {
  classifySectionRole,
  inferSectionRoles,
} from "../../src/domain/section-patterns.js";

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

describe("inferSectionRoles", () => {
  const body = (sectionTitle?: string) => ({
    blockKind: "body_paragraph" as const,
    sectionTitle,
  });

  it("treats descriptive subsections after the introduction as results", () => {
    const roles = inferSectionRoles([
      { blockKind: "abstract" },
      body("INTRODUCTION"),
      body("INTRODUCTION"),
      body("Identification of distinct subtypes of GABAergic neurons"),
      body("Identification of distinct subtypes of GABAergic neurons"),
      body("GABAergic neurons in the four sublaminae differ"),
      { blockKind: "figure_caption", sectionTitle: "Figure 1" },
      body("DISCUSSION"),
      body("Animals"),
      body("Riboprobe production"),
      body("Statistics"),
    ]);
    expect(roles).toEqual([
      "abstract",
      "introduction",
      "introduction",
      "results",
      "results",
      "results",
      "figure",
      "discussion",
      "methods",
      "methods",
      "methods",
    ]);
  });

  it("keeps methods subsections as methods when methods precede results", () => {
    const roles = inferSectionRoles([
      body("Introduction"),
      body("Materials and Methods"),
      body("Riboprobe production"),
      body("Results"),
      body("Pvalb marks a lateral lamina"),
      body("Discussion"),
    ]);
    expect(roles).toEqual([
      "introduction",
      "methods",
      "methods",
      "results",
      "results",
      "discussion",
    ]);
  });
});
