import { describe, expect, it } from "vitest";

import {
  annotateCitingContext,
  assessCitationScopeAnnotation,
} from "../../src/shared/citation-context-window.js";

describe("annotateCitingContext", () => {
  it("wraps the sentence containing the marker", () => {
    const ctx =
      "Yeast foldin is required for compaction. " +
      "In worms, span widening was observed (Adeyemi and Okonkwo, 2009). " +
      "Fictophila subunit-Q affects lattice release (Marr et al., 2009).";
    const result = annotateCitingContext(ctx, "Adeyemi and Okonkwo, 2009");
    expect(result).toContain("▶");
    expect(result).toContain("◀");
    // The Adeyemi sentence should be wrapped.
    expect(result).toMatch(/▶.*Adeyemi and Okonkwo.*◀/);
    // The Marr sentence should NOT be wrapped.
    expect(result).not.toMatch(/▶.*Marr.*◀/);
  });

  it("does not split sentences on et al. abbreviations", () => {
    const ctx =
      "Background framing is unrelated. " +
      "Marlowe et al. (2021) reported three marker classes in mouse Norel. " +
      "Later work used a different assay.";
    const result = annotateCitingContext(ctx, "2021", "Marlowe et al., 2021");
    expect(result).toMatch(
      /▶\s*Marlowe et al\. \(2021\) reported three marker classes in mouse Norel\.\s*◀/,
    );
    expect(assessCitationScopeAnnotation(result).ok).toBe(true);
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
      "track length correlates with mark sites [57,58] and not with total mark number [59,60,61]. " +
      "We find the mean length is shorter in qel1.";
    const result = annotateCitingContext(ctx, "59");
    expect(result).toContain("▶");
    expect(result).toMatch(/▶.*\[59.*◀/);
  });

  it("disambiguates using seedRefLabel (ground truth from reference resolution)", () => {
    const ctx =
      "In Fictophila, mutation of subunit-Q led to miscount (Marr et al., 2009). " +
      "In C. fictus, foldin disruption expands spans (Adeyemi and Okonkwo, 2009). " +
      "Foldin II localizes at mid-stage (Ibarra et al., 2004; Adeyemi and Okonkwo, 2009).";
    const result = annotateCitingContext(ctx, "2009", "Adeyemi and Okonkwo, 2009");
    expect(result).toContain("▶");
    // Adeyemi sentences should be wrapped, Marr should NOT.
    expect(result).toMatch(/▶.*Adeyemi and Okonkwo.*◀/);
    expect(result).not.toMatch(/▶.*Marr.*◀/);
  });

  it("falls back to raw marker when no seedRefLabel provided", () => {
    const ctx =
      "Result A was shown (2009). " + "Result B was also shown (2009).";
    const result = annotateCitingContext(ctx, "2009");
    // All sentences contain "2009": the whole window is attributed and wrapped,
    // so the packet gate sees claim-bearing text inside the markers.
    expect(result).toMatch(/^▶ .*◀$/s);
    expect(result).toContain("Result A was shown (2009).");
    expect(result).toContain("Result B was also shown (2009).");
  });

  it("uses a verified support span and reference identity instead of an ambiguous year", () => {
    const span =
      "cells were assigned identity based on a single gene (Pell et al. 2021)";
    const ctx =
      `Earlier work classified neurons differently. The cited work found ${span}. ` +
      "A broader approach was proposed (Quill et al. 2021).";
    const start = ctx.indexOf(span);
    const result = annotateCitingContext(ctx, "2021", "Pell et al., 2021", [
      {
        text: span,
        charOffsetStart: start,
        charOffsetEnd: start + span.length,
      },
    ]);
    expect(result).toMatch(/▶ The cited work found .*Pell.* ◀/);
    expect(result).not.toMatch(/▶[^◀]*Quill/);
  });

  it("leaves an unverifiable citation target unmarked", () => {
    const ctx =
      "One result cited another paper (Quill et al. 2021). Another result followed.";
    const span = "One result cited another paper";
    expect(
      annotateCitingContext(ctx, "2021", "Pell et al., 2021", [
        { text: span, charOffsetStart: 0, charOffsetEnd: span.length },
      ]),
    ).toBe(ctx);
  });

  it("fails closed on punctuation-only scope markers", () => {
    expect(
      assessCitationScopeAnnotation("Prior work. ▶ 2021). ◀ Later work."),
    ).toMatchObject({ ok: false });
  });
});
