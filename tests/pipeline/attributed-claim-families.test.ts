import { describe, expect, it } from "vitest";

import type { AttributedClaimFamilyCandidate } from "../../src/domain/types.js";
import {
  collapseExactDuplicateTrackedClaimFamilies,
  dedupeAttributedClaimFamilies,
  jaccardSimilarityCitingPaperIds,
  selectDiverseShortlistFamilies,
} from "../../src/pipeline/attributed-claim-families.js";

function makeFamily(
  familyId: string,
  claim: string,
  overrides: Partial<AttributedClaimFamilyCandidate> = {},
): AttributedClaimFamilyCandidate {
  return {
    familyId,
    doi: "10.1234/seed",
    canonicalTrackedClaim: claim,
    memberRecordIds: [`rec-${familyId}`],
    memberMentionIds: [`mention-${familyId}`],
    memberCitingPaperIds: [`paper-${familyId}`],
    seedGrounding: {
      status: "grounded",
      normalizedClaim: claim,
      supportSpanText: claim,
      groundingDetail: "grounded",
    },
    probeMetrics: {
      probePaperCount: 2,
      successfulHarvestCount: 2,
      harvestSuccessRate: 1,
      totalMentionCount: 1,
      uniqueCitingPaperCount: 1,
      auditableEdgeCount: 1,
      hasPrimaryPapers: true,
      hasReviewPapers: false,
    },
    shortlistEligible: true,
    shortlistReason: "candidate",
    dedupe: {
      dedupeStatus: "unique",
      dedupeGroupId: familyId,
      dedupeStrategy: "none",
      mergedFamilyIds: [],
      mergedCanonicalClaims: [],
    },
    ...overrides,
  };
}

describe("dedupeAttributedClaimFamilies", () => {
  it("merges exact duplicate claims into one canonical family", () => {
    const families = [
      makeFamily("fam-a", "The seed paper showed that Rab35 is required."),
      makeFamily("fam-b", "The seed paper showed that Rab35 is required."),
    ];

    const deduped = dedupeAttributedClaimFamilies(families);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.dedupe.dedupeStatus).toBe("canonical_exact");
    expect(deduped[0]?.dedupe.mergedFamilyIds).toContain("fam-b");
    expect(deduped[0]?.memberRecordIds).toHaveLength(2);
  });

  it("merges conservative near-duplicates when grounded text aligns", () => {
    const families = [
      makeFamily(
        "fam-a",
        "The seed paper showed that Rab35 is required for apical bulkheads in hepatocytes.",
        {
          seedGrounding: {
            status: "grounded",
            normalizedClaim:
              "Rab35 is required for apical bulkheads in hepatocytes.",
            supportSpanText:
              "Rab35 is required for apical bulkheads in hepatocytes.",
            groundingDetail: "grounded",
          },
        },
      ),
      makeFamily(
        "fam-b",
        "The seed paper showed that Rab35 was required for apical bulkheads in hepatocytes.",
        {
          seedGrounding: {
            status: "grounded",
            normalizedClaim:
              "Rab35 was required for apical bulkheads in hepatocytes.",
            supportSpanText:
              "Rab35 is required for apical bulkheads in hepatocytes.",
            groundingDetail: "grounded",
          },
        },
      ),
    ];

    const deduped = dedupeAttributedClaimFamilies(families);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.dedupe.dedupeStatus).toBe("canonical_near_duplicate");
  });

  it("does not merge similar but distinct grounded claims", () => {
    const deduped = dedupeAttributedClaimFamilies([
      makeFamily("fam-a", "The seed paper showed that Rab35 is required."),
      makeFamily("fam-b", "The seed paper showed that Rab35 is sufficient."),
    ]);

    expect(deduped).toHaveLength(2);
  });

  it("merges identical canonicalTrackedClaim even when grounded paraphrases differ", () => {
    const sameTracked =
      "The seed paper showed that calbindin and parvalbumin mark different cell types.";
    const families = [
      makeFamily("fam-a", sameTracked, {
        memberCitingPaperIds: ["https://openalex.org/W1"],
        seedGrounding: {
          status: "grounded",
          normalizedClaim:
            "Calbindin and parvalbumin label distinct populations A.",
          supportSpanText: "span a",
          groundingDetail: "g",
        },
      }),
      makeFamily("fam-b", sameTracked, {
        memberCitingPaperIds: ["https://openalex.org/W2"],
        seedGrounding: {
          status: "grounded",
          normalizedClaim:
            "Calbindin and parvalbumin label distinct populations B.",
          supportSpanText: "span b",
          groundingDetail: "g",
        },
      }),
    ];

    const deduped = dedupeAttributedClaimFamilies(families);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.memberCitingPaperIds).toHaveLength(2);
  });

  it("collapseExactDuplicateTrackedClaimFamilies merges before grounding", () => {
    const claim = "The seed paper showed that X is true.";
    const notAttempted = {
      status: "not_attempted" as const,
      normalizedClaim: undefined,
      supportSpanText: undefined,
      groundingDetail: undefined,
    };
    const collapsed = collapseExactDuplicateTrackedClaimFamilies([
      makeFamily("fam-a", claim, {
        seedGrounding: notAttempted,
      }),
      makeFamily("fam-b", claim, {
        seedGrounding: notAttempted,
      }),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.dedupe.dedupeStatus).toBe("canonical_exact");
  });

  it("selectDiverseShortlistFamilies skips near-duplicate citing sets", () => {
    const paper = "https://openalex.org/Wsame";
    const a = makeFamily("fam-a", "Claim one.", {
      memberCitingPaperIds: [paper],
    });
    const b = makeFamily("fam-b", "Claim two.", {
      memberCitingPaperIds: [paper],
    });
    const ranked = [a, b];
    const picked = selectDiverseShortlistFamilies(ranked, 2, 0.85);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.familyId).toBe("fam-a");
  });

  it("jaccardSimilarityCitingPaperIds is 1 for identical non-empty sets", () => {
    const ids = ["a", "b"];
    expect(jaccardSimilarityCitingPaperIds(ids, ids)).toBe(1);
  });
});
