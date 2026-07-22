import { describe, expect, it } from "vitest";

import {
  assessAdjudicatePacketQuality,
  buildCanonicalAdjudicatePrompt,
  type CanonicalAdjudicatePacket,
} from "../../src/adjudication/canonical-adjudicate-packet.js";

function basePacket(
  overrides: Partial<CanonicalAdjudicatePacket> = {},
): CanonicalAdjudicatePacket {
  return {
    recordId: "rec_1",
    familyId: "fam_1",
    citationOccurrenceId: "occ_1",
    citationRole: "substantive_attribution",
    evaluationMode: "fidelity_specific_claim",
    isBundled: false,
    bundleSize: 1,
    citingPaperTitle: "Citing paper",
    citedPaperTitle: "Seed paper",
    familyTrackedClaim: "Seed reported three marker classes.",
    markedCitingContext:
      "Background. ▶ Marlowe et al. (2021) reported three marker classes in mouse Norel. ◀ Later text.",
    occurrenceClaims: [
      {
        claimRecordId: "claim_1",
        claimText: "The seed reported three marker classes.",
        supportSpanText: "reported three marker classes",
        supportSpanCharOffsetStart: 10,
        supportSpanCharOffsetEnd: 47,
      },
    ],
    selectedChunks: [
      {
        chunkId: "chunk_1",
        text: "We identified three marker classes in the mouse Norel.",
        sourceBlockKind: "body_paragraph",
        charOffsetStart: 0,
        charOffsetEnd: 66,
      },
    ],
    ...overrides,
  };
}

describe("canonical adjudicate packet quality", () => {
  it("accepts packets with verified spans and substantive markers", () => {
    expect(assessAdjudicatePacketQuality(basePacket())).toEqual({ ok: true });
  });

  it("fails closed when verified support spans are missing", () => {
    const result = assessAdjudicatePacketQuality(
      basePacket({
        occurrenceClaims: [
          {
            claimRecordId: "claim_1",
            claimText: "The seed reported three marker classes.",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.gateReason).toMatch(/support spans/i);
  });

  it("fails closed when scope markers are non-substantive", () => {
    const result = assessAdjudicatePacketQuality(
      basePacket({
        markedCitingContext: "Background. ▶ 2021). ◀ Later text.",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("pins quantifier, proxy-endpoint, and bundle kernel guidance in the prompt", () => {
    const prompt = buildCanonicalAdjudicatePrompt(
      basePacket({ isBundled: true, bundleSize: 3 }),
    );
    expect(prompt).toMatch(/reasonable compression is allowed/i);
    expect(prompt).toMatch(/Quantifier compression/i);
    expect(prompt).toMatch(/Proxy endpoints/i);
    expect(prompt).toMatch(/supportSpan:/);
    expect(prompt).toMatch(/figure-only support/i);
  });
});
