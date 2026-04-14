import { describe, expect, it } from "vitest";

import { annotateCitingContext } from "../../src/shared/citation-context-window.js";

describe("annotateCitingContext", () => {
  it("wraps the sentence containing the marker", () => {
    const ctx =
      "Yeast condensin is required for compaction. " +
      "In worms, axis expansion was observed (Mets and Meyer, 2009). " +
      "Drosophila CAP-G affects SC disassembly (Resnick et al., 2009).";
    const result = annotateCitingContext(ctx, "Mets and Meyer, 2009");
    expect(result).toContain("▶");
    expect(result).toContain("◀");
    // The Mets sentence should be wrapped.
    expect(result).toMatch(/▶.*Mets and Meyer.*◀/);
    // The Resnick sentence should NOT be wrapped.
    expect(result).not.toMatch(/▶.*Resnick.*◀/);
  });

  it("returns unchanged text for a single sentence", () => {
    const ctx = "This is one sentence with a marker (Smith, 2020).";
    expect(annotateCitingContext(ctx, "Smith, 2020")).toBe(ctx);
  });

  it("returns unchanged text when marker is not found", () => {
    const ctx = "First sentence. Second sentence. Third sentence.";
    expect(annotateCitingContext(ctx, "nonexistent")).toBe(ctx);
  });

  it("handles numbered markers like [59]", () => {
    const ctx =
      "SC length correlates with CO sites [57,58] and not with total CO number [59,60,61]. " +
      "We find the mean length is shorter in tel1.";
    const result = annotateCitingContext(ctx, "59");
    expect(result).toContain("▶");
    expect(result).toMatch(/▶.*\[59.*◀/);
  });

  it("disambiguates using seedRefLabel (ground truth from reference resolution)", () => {
    const ctx =
      "In Drosophila, mutation of CAP-G led to aneuploidy (Resnick et al., 2009). " +
      "In C. elegans, condensin disruption expands axes (Mets and Meyer, 2009). " +
      "Condensin II localizes at diplotene (Chan et al., 2004; Mets and Meyer, 2009).";
    const result = annotateCitingContext(ctx, "2009", "Mets and Meyer, 2009");
    expect(result).toContain("▶");
    // Mets sentences should be wrapped, Resnick should NOT.
    expect(result).toMatch(/▶.*Mets and Meyer.*◀/);
    expect(result).not.toMatch(/▶.*Resnick.*◀/);
  });

  it("falls back to raw marker when no seedRefLabel provided", () => {
    const ctx =
      "Result A was shown (2009). " + "Result B was also shown (2009).";
    const result = annotateCitingContext(ctx, "2009");
    // All sentences contain "2009" — annotation would wrap everything, so skip.
    expect(result).not.toContain("▶");
    expect(result).toBe(ctx);
  });
});
