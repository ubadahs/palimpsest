import { describe, expect, it } from "vitest";
import type {
  DiscoverAttributedClaimRecord,
  DiscoverCitationOccurrence,
} from "../../../src/contract/artifacts/index.js";
import { resolveClaimCitation } from "../../../src/stages/discover/citation-attachment.js";

const context = "Earlier (1). Bands (1,2,3).";
const first = {
  mentionId: "first",
  seedId: "seed",
  citingPaperRecordId: "paper",
  rawContext: context,
  charOffsetStart: 109,
  charOffsetEnd: 110,
  locationQuality: "exact_dom",
  markerSpan: { charOffsetStart: 9, charOffsetEnd: 10 },
  citationMarker: "1",
} as DiscoverCitationOccurrence;
const second = {
  ...first,
  mentionId: "second",
  charOffsetStart: 120,
  charOffsetEnd: 125,
  markerSpan: { charOffsetStart: 20, charOffsetEnd: 25 },
  citationMarker: "1,2,3",
  bundleSize: 3,
};
const claim = {
  mentionId: "first",
  supportSpan: {
    text: "Bands (1,2,3).",
    charOffsetStart: 13,
    charOffsetEnd: 27,
    verificationStatus: "verified_exact",
  },
} as DiscoverAttributedClaimRecord;

describe("claim citation attachment", () => {
  it("chooses the exact marker inside the claim instead of another sentence", () => {
    expect(resolveClaimCitation(claim, first, [first, second])).toBe(second);
  });
  it.each([
    ["another paper", { ...second, citingPaperRecordId: "other" }],
    ["another seed", { ...second, seedId: "other" }],
    [
      "repeated paragraph",
      { ...second, charOffsetStart: 220, charOffsetEnd: 225 },
    ],
    [
      "approximate marker",
      { ...second, locationQuality: "approximate" as const },
    ],
    [
      "wrong marker offsets",
      { ...second, markerSpan: { charOffsetStart: 19, charOffsetEnd: 24 } },
    ],
  ])("does not borrow from %s", (_name, candidate) => {
    expect(resolveClaimCitation(claim, first, [first, candidate])).toBe(first);
  });
  it("leaves ambiguous markers and unverified spans unchanged", () => {
    expect(
      resolveClaimCitation(claim, first, [
        second,
        { ...second, mentionId: "third" },
      ]),
    ).toBe(first);
    expect(
      resolveClaimCitation(
        { ...claim, supportSpan: { ...claim.supportSpan!, text: "not exact" } },
        first,
        [second],
      ),
    ).toBe(first);
    const withoutSpan = { ...claim };
    delete withoutSpan.supportSpan;
    expect(resolveClaimCitation(withoutSpan, first, [second])).toBe(first);
  });
});
