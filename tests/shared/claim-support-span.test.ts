import { describe, expect, it } from "vitest";

import { verifyClaimSupportSpan } from "../../src/shared/claim-support-span.js";

describe("verifyClaimSupportSpan", () => {
  it("exact-verifies a substring and persists offsets", () => {
    const rawContext =
      "Prior work showed alpha increases in cortex (Smith et al., 2021).";
    const span = verifyClaimSupportSpan(
      rawContext,
      "showed alpha increases in cortex",
    );
    expect(span).toEqual({
      text: "showed alpha increases in cortex",
      charOffsetStart: rawContext.indexOf("showed alpha increases in cortex"),
      charOffsetEnd:
        rawContext.indexOf("showed alpha increases in cortex") +
        "showed alpha increases in cortex".length,
      verificationStatus: "verified_exact",
    });
  });

  it("accepts whitespace-collapsed matches using corpus text", () => {
    const rawContext = "The seed paper   showed   a measurable effect nearby.";
    const span = verifyClaimSupportSpan(
      rawContext,
      "showed a measurable effect",
    );
    expect(span?.verificationStatus).toBe("verified_exact");
    expect(span?.text).toBe("showed   a measurable effect");
    expect(rawContext.slice(span!.charOffsetStart, span!.charOffsetEnd)).toBe(
      span!.text,
    );
  });

  it("returns undefined when the proposed span is absent", () => {
    expect(
      verifyClaimSupportSpan(
        "Context without the claim.",
        "missing claim text",
      ),
    ).toBeUndefined();
  });

  it("recovers a copied prompt highlight at its source offsets, preserving source glyphs", () => {
    const raw = "See [2]. ▶ denotes the intervention in group [2, 3].";
    const start = raw.lastIndexOf("[2,");
    const target = {
      citationMarker: "[2,",
      markerSpan: { charOffsetStart: start, charOffsetEnd: start + 3 },
    };
    const quoted = "▶ denotes the intervention in group [2, 3].";
    for (const decoration of ["▶[2,◀", "▶[2,", "[2,◀"]) {
      expect(
        verifyClaimSupportSpan(raw, quoted.replace("[2,", decoration), target),
      ).toEqual({
        text: quoted,
        charOffsetStart: raw.indexOf(quoted),
        charOffsetEnd: raw.length,
        verificationStatus: "verified_exact",
      });
    }
    expect(verifyClaimSupportSpan(raw, quoted, target)?.text).toBe(quoted);
  });

  it("rejects repairs at another marker, ambiguous source text, and other edits", () => {
    const raw = "First effect [1]. Next effect [1].";
    const start = raw.indexOf("[1]");
    const target = {
      citationMarker: "[1]",
      markerSpan: { charOffsetStart: start, charOffsetEnd: start + 3 },
    };
    for (const quote of [
      "Next effect ▶[1]◀.",
      "effect ▶[1]◀.",
      "First  effect ▶[1]◀.",
      "First effects ▶[1]◀.",
      "▶First effect [1]◀.",
      "Next effect ▶[1].",
    ]) {
      expect(verifyClaimSupportSpan(raw, quote, target)).toBeUndefined();
    }
    expect(verifyClaimSupportSpan(raw, "First effect ▶[1]◀.")).toBeUndefined();
    expect(
      verifyClaimSupportSpan(raw, "First effect ▶[1]◀.", {
        ...target,
        markerSpan: { charOffsetStart: start, charOffsetEnd: start + 2 },
      }),
    ).toBeUndefined();
  });
});
