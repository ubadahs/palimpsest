import type {
  AttributedClaimFamilyCandidate,
  DiscoveryShortlistEntry,
  FamilyCandidateSeedGrounding,
} from "../../domain/types.js";
import { selectDiverseShortlistFamilies } from "../attributed-claim-families.js";

function toShortlistEntry(
  family: AttributedClaimFamilyCandidate,
): DiscoveryShortlistEntry {
  return {
    doi: family.doi,
    trackedClaim: family.canonicalTrackedClaim,
    familyId: family.familyId,
    discoveryMethod: "attribution_first",
    supportingMentionCount: family.memberMentionIds.length,
    supportingPaperCount: family.memberCitingPaperIds.length,
    seedGroundingStatus: family.seedGrounding.status,
    notes: family.shortlistReason,
    dedupeGroupId: family.dedupe.dedupeGroupId,
    dedupeStatus: family.dedupe.dedupeStatus,
  };
}

function groundingStatusRank(
  status: FamilyCandidateSeedGrounding["status"],
): number {
  switch (status) {
    case "grounded":
      return 0;
    case "ambiguous":
      return 1;
    case "not_attempted":
      return 2;
    case "not_found":
      return 3;
    case "no_seed_fulltext":
      return 4;
    case "materialize_failed":
      return 5;
    default:
      return 9;
  }
}

export function rankAndSelectShortlist(
  families: AttributedClaimFamilyCandidate[],
  cap: number,
): DiscoveryShortlistEntry[] {
  // Sort: grounded first, then by grounding status, then by confidence.
  const ranked = [...families].sort((a, b) => {
    const statusOrder =
      groundingStatusRank(a.seedGrounding.status) -
      groundingStatusRank(b.seedGrounding.status);
    if (statusOrder !== 0) return statusOrder;
    return b.memberMentionIds.length - a.memberMentionIds.length;
  });

  const topCapByRank = new Set(ranked.slice(0, cap));
  const shortlisted = selectDiverseShortlistFamilies(ranked, cap);
  const shortlistedSet = new Set(shortlisted);

  for (const fam of families) {
    if (shortlistedSet.has(fam)) {
      fam.shortlistEligible = true;
      continue;
    }
    fam.shortlistEligible = false;
    if (topCapByRank.has(fam)) {
      fam.shortlistReason =
        "Excluded from shortlist: near-identical citing papers vs a higher-ranked family";
    } else {
      fam.shortlistReason = "Excluded from shortlist by cap";
    }
  }

  return shortlisted.map(toShortlistEntry);
}
