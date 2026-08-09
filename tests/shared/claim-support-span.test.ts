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
});
