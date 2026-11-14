import { describe, expect, it } from "vitest";

import {
  annotateCitingContext,
  assessCitationScopeAnnotation,
} from "../../src/shared/citation-context-window.js";

/** The occurrence whose marker is the `nth` appearance of `marker` in `rawContext`. */
function occurrenceAt(
  rawContext: string,
  marker: string,
  nth = 0,
  seedRefLabel?: string,
) {
  let start = -1;
  for (let seen = 0; seen <= nth; seen++) {
    start = rawContext.indexOf(marker, start + 1);
  }
  return {
    rawContext,
    citationMarker: marker,
    ...(seedRefLabel ? { seedRefLabel } : {}),
    markerSpan: {
      charOffsetStart: start,
      charOffsetEnd: start + marker.length,
    },
  };
}

function spanOf(rawContext: string, text: string) {
  const start = rawContext.indexOf(text);
  return { text, charOffsetStart: start, charOffsetEnd: start + text.length };
}

describe("annotateCitingContext", () => {
  it("marks the support span's sentence when it holds this occurrence's marker", () => {
    const ctx =
      "Background framing is unrelated. " +
      "Marlowe et al. (2021) reported three marker classes in mouse Norel. " +
      "Later work used a different assay.";
    const result = annotateCitingContext(occurrenceAt(ctx, "(2021)"), [
      spanOf(ctx, "Marlowe et al. (2021) reported three marker classes"),
    ]);
    // "et al." does not end the sentence.
    expect(result).toMatch(
      /▶\s*Marlowe et al\. \(2021\) reported three marker classes in mouse Norel\.\s*◀/,
    );
    expect(assessCitationScopeAnnotation(result).ok).toBe(true);
  });

  it("tells repeated numeric markers apart by position", () => {
    const first =
      "Kestrin neurons dominate the projected response while other classes contribute equally [41].";
    const third =
      "Finally, Ref. [41] has also shown the effect is distinguishable from Lorn expression.";
    const ctx = `${first} Ref. [19] has shown slice thickness matters little. ${third}`;

    const atFirst = occurrenceAt(ctx, "[41]", 0);
    expect(annotateCitingContext(atFirst, [spanOf(ctx, first)])).toMatch(
      /^▶ Kestrin neurons dominate.*\[41\]\. ◀/,
    );
    // A span resting on the other [41] belongs to that occurrence.
    expect(annotateCitingContext(atFirst, [spanOf(ctx, third)])).toBe(ctx);
    expect(
      annotateCitingContext(occurrenceAt(ctx, "[41]", 1), [spanOf(ctx, third)]),
    ).toMatch(/▶ Finally, Ref\. \[41\].* ◀$/);
  });

  it("marks a marker that is a fragment of a citation group", () => {
    const span =
      "We expect that denser Norel sampling will drive the estimates [12,57].";
    const ctx = `The field covers a small sample [23]. ${span}`;
    const result = annotateCitingContext(occurrenceAt(ctx, "57]"), [
      spanOf(ctx, span),
    ]);
    expect(result).toMatch(/▶ We expect.*\[12,57\]\. ◀$/);
  });

  it("marks every sentence a span covers once one holds the marker", () => {
    const ctx =
      "Staining conditions follow Table 1 [8,33]. They were set with Eq. 4 using these parameters. Unrelated text.";
    const result = annotateCitingContext(occurrenceAt(ctx, "33]"), [
      spanOf(
        ctx,
        "Staining conditions follow Table 1 [8,33]. They were set with Eq. 4 using these parameters.",
      ),
    ]);
    expect(result).toMatch(
      /^▶ Staining conditions.*these parameters\. ◀ Unrelated/,
    );
  });

  it("ignores a support span whose text does not match its offsets", () => {
    const ctx = "A finding was reported [5]. Another sentence follows.";
    expect(
      annotateCitingContext(occurrenceAt(ctx, "[5]"), [
        { text: "Something else", charOffsetStart: 0, charOffsetEnd: 14 },
      ]),
    ).toBe(ctx);
  });

  describe("without an exact marker position", () => {
    it("uses the seed's author-year label rather than a shared year", () => {
      const span =
        "cells were assigned identity based on a single gene (Pell et al. 2021)";
      const ctx =
        `Earlier work classified neurons differently. The cited work found ${span}. ` +
        "A broader approach was proposed (Quill et al. 2021).";
      const result = annotateCitingContext(
        {
          rawContext: ctx,
          citationMarker: "2021",
          seedRefLabel: "Pell et al., 2021",
        },
        [spanOf(ctx, span)],
      );
      expect(result).toMatch(/▶ The cited work found .*Pell.* ◀/);
      expect(result).not.toMatch(/▶[^◀]*Quill/);
    });

    it("accepts a numeric marker only when it occurs once", () => {
      const span = "Spans widen in mutants [59].";
      const ctx = `${span} Other work disagrees [60].`;
      const occurrence = { rawContext: ctx, citationMarker: "[59]" };
      expect(annotateCitingContext(occurrence, [spanOf(ctx, span)])).toMatch(
        /^▶ Spans widen in mutants \[59\]\. ◀/,
      );
      const repeated = `${ctx} As [59] notes, this holds.`;
      expect(
        annotateCitingContext({ ...occurrence, rawContext: repeated }, [
          spanOf(repeated, span),
        ]),
      ).toBe(repeated);
    });

    it("leaves a span citing another reference unmarked", () => {
      const ctx =
        "One result cited another paper (Quill et al. 2021). Another result followed.";
      expect(
        annotateCitingContext(
          {
            rawContext: ctx,
            citationMarker: "2021",
            seedRefLabel: "Pell et al., 2021",
          },
          [spanOf(ctx, "One result cited another paper")],
        ),
      ).toBe(ctx);
    });
  });

  it("fails closed on punctuation-only scope markers", () => {
    expect(
      assessCitationScopeAnnotation("Prior work. ▶ 2021). ◀ Later work."),
    ).toMatchObject({ ok: false });
  });
});
