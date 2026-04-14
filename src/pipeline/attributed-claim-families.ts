/**
 * Singleton family construction (Phase 4 of discover redesign).
 *
 * Each in-scope attributed claim becomes its own single-member family
 * candidate. A conservative dedupe pass can later merge exact and near-
 * duplicate families before screen.
 */

import type {
  AttributedClaimExtractionRecord,
  AttributedClaimFamilyCandidate,
  HarvestedSeedMention,
  PaperHarvestSummary,
} from "../domain/types.js";

/**
 * Build one `AttributedClaimFamilyCandidate` per in-scope extraction record.
 * Out-of-scope records are silently skipped — callers should persist them
 * separately with their `reasonIfExcluded` for auditability.
 */
export function buildSingletonFamilies(params: {
  doi: string;
  records: AttributedClaimExtractionRecord[];
  mentions: HarvestedSeedMention[];
  harvestSummaries: PaperHarvestSummary[];
}): AttributedClaimFamilyCandidate[] {
  const { doi, records, mentions, harvestSummaries } = params;

  const mentionById = new Map(mentions.map((m) => [m.mentionId, m]));
  const probeStats = computeProbeStats(harvestSummaries);

  return records
    .filter((r) => r.inScopeEmpiricalAttribution && r.attributedClaimText)
    .map((r): AttributedClaimFamilyCandidate => {
      const mention = mentionById.get(r.mentionId);
      return {
        familyId: `fam-${r.recordId}`,
        doi,
        canonicalTrackedClaim: r.attributedClaimText!,
        memberRecordIds: [r.recordId],
        memberMentionIds: [r.mentionId],
        memberCitingPaperIds: [r.citingPaperId],
        seedGrounding: {
          status: "not_attempted",
          normalizedClaim: undefined,
          supportSpanText: undefined,
          groundingDetail: undefined,
        },
        probeMetrics: {
          // Probe-level (shared context)
          probePaperCount: probeStats.probePaperCount,
          successfulHarvestCount: probeStats.successfulHarvestCount,
          harvestSuccessRate: probeStats.harvestSuccessRate,
          // Per-family (singleton: 1 mention from 1 paper)
          totalMentionCount: 1,
          uniqueCitingPaperCount: 1,
          auditableEdgeCount: 1,
          hasPrimaryPapers: false,
          hasReviewPapers: false,
        },
        shortlistEligible: true,
        shortlistReason: buildShortlistReason(r, mention),
        dedupe: {
          dedupeStatus: "unique",
          dedupeGroupId: `fam-${r.recordId}`,
          dedupeStrategy: "none",
          mergedFamilyIds: [],
          mergedCanonicalClaims: [],
        },
      };
    });
}

function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeClaimText(text)
    .split(" ")
    .filter((token) => token.length >= 3);
}

const SEMANTIC_OPERATOR_TOKENS = new Set([
  "required",
  "necessary",
  "sufficient",
  "increase",
  "increases",
  "decrease",
  "decreases",
  "promotes",
  "promote",
  "inhibits",
  "inhibit",
  "prevents",
  "prevent",
  "causes",
  "cause",
]);

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function canonicalComparisonText(
  family: AttributedClaimFamilyCandidate,
): string {
  return family.seedGrounding.normalizedClaim ?? family.canonicalTrackedClaim;
}

function dedupeStatusRank(
  status: AttributedClaimFamilyCandidate["seedGrounding"]["status"],
): number {
  switch (status) {
    case "grounded":
      return 0;
    case "ambiguous":
      return 1;
    default:
      return 2;
  }
}

function compareCanonicalFamilies(
  left: AttributedClaimFamilyCandidate,
  right: AttributedClaimFamilyCandidate,
): number {
  const statusDelta =
    dedupeStatusRank(left.seedGrounding.status) -
    dedupeStatusRank(right.seedGrounding.status);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  const memberDelta =
    right.memberMentionIds.length - left.memberMentionIds.length ||
    right.memberCitingPaperIds.length - left.memberCitingPaperIds.length;
  if (memberDelta !== 0) {
    return memberDelta;
  }

  return left.familyId.localeCompare(right.familyId);
}

function shouldMergeNearDuplicate(
  left: AttributedClaimFamilyCandidate,
  right: AttributedClaimFamilyCandidate,
): boolean {
  const allowedStatuses = new Set(["grounded", "ambiguous"]);
  if (
    !allowedStatuses.has(left.seedGrounding.status) ||
    !allowedStatuses.has(right.seedGrounding.status)
  ) {
    return false;
  }

  const leftText = canonicalComparisonText(left);
  const rightText = canonicalComparisonText(right);
  const leftNorm = normalizeClaimText(leftText);
  const rightNorm = normalizeClaimText(rightText);
  if (leftNorm === rightNorm) {
    return true;
  }

  const leftTokens = new Set(tokenize(leftText));
  const rightTokens = new Set(tokenize(rightText));
  const differingTokens = new Set(
    [...leftTokens]
      .filter((token) => !rightTokens.has(token))
      .concat([...rightTokens].filter((token) => !leftTokens.has(token))),
  );
  for (const token of differingTokens) {
    if (SEMANTIC_OPERATOR_TOKENS.has(token)) {
      return false;
    }
  }

  const leftSupport = normalizeClaimText(
    left.seedGrounding.supportSpanText ?? "",
  );
  const rightSupport = normalizeClaimText(
    right.seedGrounding.supportSpanText ?? "",
  );
  if (leftSupport.length > 0 && rightSupport.length > 0) {
    const supportSimilarity = jaccardSimilarity(
      new Set(tokenize(leftSupport)),
      new Set(tokenize(rightSupport)),
    );
    if (supportSimilarity >= 0.6) {
      return true;
    }
    if (leftSupport.includes(rightNorm) || rightSupport.includes(leftNorm)) {
      return true;
    }
    if (
      left.seedGrounding.normalizedClaim != null &&
      right.seedGrounding.normalizedClaim != null &&
      normalizeClaimText(left.seedGrounding.normalizedClaim) ===
        normalizeClaimText(right.seedGrounding.normalizedClaim)
    ) {
      return true;
    }
  }

  const similarity = jaccardSimilarity(leftTokens, rightTokens);
  if (similarity < 0.45) {
    return false;
  }

  return false;
}

/**
 * Merge families that share the same normalized `canonicalTrackedClaim` for a
 * given DOI (pre-grounding). Avoids duplicate full-seed grounding LLM calls.
 */
export function collapseExactDuplicateTrackedClaimFamilies(
  families: AttributedClaimFamilyCandidate[],
): AttributedClaimFamilyCandidate[] {
  if (families.length <= 1) {
    return families;
  }

  const sorted = [...families].sort((a, b) =>
    a.familyId.localeCompare(b.familyId),
  );
  const consumed = new Set<string>();
  const collapsed: AttributedClaimFamilyCandidate[] = [];

  for (const family of sorted) {
    if (consumed.has(family.familyId)) {
      continue;
    }
    const trackedNorm = normalizeClaimText(family.canonicalTrackedClaim);
    const group = sorted.filter((candidate) => {
      if (consumed.has(candidate.familyId)) {
        return false;
      }
      return (
        candidate.doi === family.doi &&
        normalizeClaimText(candidate.canonicalTrackedClaim) === trackedNorm
      );
    });

    for (const member of group) {
      consumed.add(member.familyId);
    }

    collapsed.push(
      mergeFamilies(
        `dedupe-${group[0]!.doi}-${group[0]!.familyId}`,
        "exact_normalized_claim",
        group,
      ),
    );
  }

  return collapsed.sort(compareCanonicalFamilies);
}

/** Jaccard similarity of citing-paper id sets (order-independent). */
export function jaccardSimilarityCitingPaperIds(
  a: readonly string[],
  b: readonly string[],
): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const id of sa) {
    if (sb.has(id)) {
      intersection += 1;
    }
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const DEFAULT_SHORTLIST_OVERLAP_THRESHOLD = 0.85;

/**
 * Greedy shortlist: walk `ranked` in order; skip a family if its citing-paper
 * set is too similar (Jaccard ≥ threshold) to any already selected family.
 */
export function selectDiverseShortlistFamilies(
  ranked: AttributedClaimFamilyCandidate[],
  cap: number,
  overlapThreshold: number = DEFAULT_SHORTLIST_OVERLAP_THRESHOLD,
): AttributedClaimFamilyCandidate[] {
  const selected: AttributedClaimFamilyCandidate[] = [];

  for (const fam of ranked) {
    if (selected.length >= cap) {
      break;
    }
    let maxJ = 0;
    for (const sel of selected) {
      const j = jaccardSimilarityCitingPaperIds(
        fam.memberCitingPaperIds,
        sel.memberCitingPaperIds,
      );
      if (j > maxJ) {
        maxJ = j;
      }
    }
    if (selected.length === 0 || maxJ < overlapThreshold) {
      selected.push(fam);
    }
  }

  return selected;
}

function mergeFamilies(
  groupId: string,
  strategy: "exact_normalized_claim" | "near_duplicate_claim",
  members: AttributedClaimFamilyCandidate[],
): AttributedClaimFamilyCandidate {
  const canonical = [...members].sort(compareCanonicalFamilies)[0]!;
  const mergedFamilyIds = members
    .map((member) => member.familyId)
    .filter((familyId) => familyId !== canonical.familyId)
    .sort();
  const mergedCanonicalClaims = members
    .map((member) => member.canonicalTrackedClaim)
    .filter((claim) => claim !== canonical.canonicalTrackedClaim)
    .filter((claim, index, claims) => claims.indexOf(claim) === index)
    .sort();

  const unique = (values: string[]): string[] => [...new Set(values)].sort();

  return {
    ...canonical,
    memberRecordIds: unique(
      members.flatMap((member) => member.memberRecordIds),
    ),
    memberMentionIds: unique(
      members.flatMap((member) => member.memberMentionIds),
    ),
    memberCitingPaperIds: unique(
      members.flatMap((member) => member.memberCitingPaperIds),
    ),
    probeMetrics: {
      ...canonical.probeMetrics,
      totalMentionCount: members.reduce(
        (sum, member) => sum + member.probeMetrics.totalMentionCount,
        0,
      ),
      uniqueCitingPaperCount: unique(
        members.flatMap((member) => member.memberCitingPaperIds),
      ).length,
      auditableEdgeCount: unique(
        members.flatMap((member) => member.memberCitingPaperIds),
      ).length,
    },
    shortlistReason:
      mergedFamilyIds.length === 0
        ? canonical.shortlistReason
        : `${canonical.shortlistReason}; merged ${String(mergedFamilyIds.length)} duplicate family${mergedFamilyIds.length === 1 ? "" : "ies"}`,
    dedupe: {
      dedupeStatus:
        mergedFamilyIds.length === 0
          ? "unique"
          : strategy === "exact_normalized_claim"
            ? "canonical_exact"
            : "canonical_near_duplicate",
      dedupeGroupId: groupId,
      dedupeStrategy: mergedFamilyIds.length === 0 ? "none" : strategy,
      mergedFamilyIds,
      mergedCanonicalClaims,
    },
  };
}

export function dedupeAttributedClaimFamilies(
  families: AttributedClaimFamilyCandidate[],
): AttributedClaimFamilyCandidate[] {
  if (families.length <= 1) {
    return families;
  }

  const sorted = [...families].sort((a, b) =>
    a.familyId.localeCompare(b.familyId),
  );
  const consumed = new Set<string>();
  const deduped: AttributedClaimFamilyCandidate[] = [];

  for (const family of sorted) {
    if (consumed.has(family.familyId)) {
      continue;
    }

    const familyTrackedNorm = normalizeClaimText(family.canonicalTrackedClaim);
    const familyCanonNorm = normalizeClaimText(canonicalComparisonText(family));
    const exactGroup = sorted.filter((candidate) => {
      if (consumed.has(candidate.familyId)) {
        return false;
      }
      if (candidate.doi !== family.doi) {
        return false;
      }
      const candTrackedNorm = normalizeClaimText(
        candidate.canonicalTrackedClaim,
      );
      const candCanonNorm = normalizeClaimText(
        canonicalComparisonText(candidate),
      );
      return (
        candTrackedNorm === familyTrackedNorm ||
        candCanonNorm === familyCanonNorm
      );
    });

    let group = exactGroup;
    let strategy: "exact_normalized_claim" | "near_duplicate_claim" =
      "exact_normalized_claim";

    if (group.length === 1) {
      const nearGroup = [family];
      for (const candidate of sorted) {
        if (
          candidate.familyId === family.familyId ||
          consumed.has(candidate.familyId) ||
          candidate.doi !== family.doi
        ) {
          continue;
        }
        if (shouldMergeNearDuplicate(family, candidate)) {
          nearGroup.push(candidate);
        }
      }
      if (nearGroup.length > 1) {
        group = nearGroup;
        strategy = "near_duplicate_claim";
      }
    }

    for (const member of group) {
      consumed.add(member.familyId);
    }

    deduped.push(
      mergeFamilies(
        `dedupe-${group[0]!.doi}-${group[0]!.familyId}`,
        strategy,
        group,
      ),
    );
  }

  return deduped.sort(compareCanonicalFamilies);
}

function buildShortlistReason(
  record: AttributedClaimExtractionRecord,
  mention: HarvestedSeedMention | undefined,
): string {
  const confidence = record.confidence ?? "unknown";
  const section = mention?.sectionTitle ?? "unknown section";
  return `Singleton family; ${confidence} confidence; cited in ${section}`;
}

/** Probe-level aggregate stats shared across all singletons in a run. */
function computeProbeStats(summaries: PaperHarvestSummary[]): {
  probePaperCount: number;
  successfulHarvestCount: number;
  harvestSuccessRate: number;
} {
  const total = summaries.length;
  const successful = summaries.filter(
    (s) => s.harvestOutcome === "success",
  ).length;
  return {
    probePaperCount: total,
    successfulHarvestCount: successful,
    harvestSuccessRate: total > 0 ? successful / total : 0,
  };
}
