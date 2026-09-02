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
    familyTrackedClaim: "Seed reported four inhibitory neuron types.",
    markedCitingContext:
      "Background. ▶ Marlowe et al. (2021) reported four inhibitory neuron types in mouse dLGN. ◀ Later text.",
    occurrenceClaims: [
      {
        claimRecordId: "claim_1",
        claimText: "The seed reported four inhibitory neuron types.",
        supportSpanText: "reported four inhibitory neuron types",
        supportSpanCharOffsetStart: 10,
        supportSpanCharOffsetEnd: 47,
      },
    ],
    selectedChunks: [
      {
        chunkId: "chunk_1",
        text: "We identified four types of inhibitory neurons in the mouse dLGN.",
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
            claimText: "The seed reported four inhibitory neuron types.",
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

describe("canonical adjudicate prompt contract", () => {
  it("asks for mutation kinds and direction and never for a claim id echo", () => {
    const prompt = buildCanonicalAdjudicatePrompt(basePacket());
    expect(prompt).toMatch(/mutationKinds/);
    expect(prompt).toMatch(/direction/);
    expect(prompt).toMatch(/citingAssertion/);
    expect(prompt).toMatch(/sourceStatement/);
    expect(prompt).not.toMatch(/evaluatedClaimRecordIds/);
    expect(prompt).not.toMatch(/claimRecordId=/);
    // Offsets index the full paragraph, not the shown window, so they are
    // not rendered.
    expect(prompt).not.toMatch(/supportSpan: ".*" \(offsets/);
  });

  it("explains role and mode tokens instead of leaking bare enums", () => {
    const prompt = buildCanonicalAdjudicatePrompt(basePacket());
    expect(prompt).toMatch(
      /Citation role: substantive_attribution \(the citing text attributes/,
    );
    expect(prompt).toMatch(
      /Evaluation mode: fidelity_specific_claim \(judge the specific/,
    );
  });

  it("labels chunk section roles and third-party citations for the judge", () => {
    const prompt = buildCanonicalAdjudicatePrompt(
      basePacket({
        selectedChunks: [
          {
            chunkId: "chunk_intro",
            text: "Prior studies identified four types (Smith 2001).",
            sourceBlockKind: "body_paragraph",
            sourceSectionRole: "introduction",
            sourceCitesOtherWork: true,
            charOffsetStart: 0,
            charOffsetEnd: 50,
          },
        ],
      }),
    );
    expect(prompt).toMatch(/role=introduction/);
    expect(prompt).toMatch(/cites other work/);
    expect(prompt).toMatch(/only role=results, figure, table, or abstract/);
  });

  it("accepts a window where every sentence is attributed to the seed", () => {
    const result = assessAdjudicatePacketQuality(
      basePacket({
        markedCitingContext:
          "▶ Marlowe et al. (2021) reported four inhibitory neuron types. They also mapped their laminar positions in the mouse dLGN. ◀",
      }),
    );
    expect(result).toEqual({ ok: true });
  });
});
