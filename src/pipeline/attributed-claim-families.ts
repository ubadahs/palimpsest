/**
 * Singleton family construction (Phase 4 of discover redesign).
 *
 * Each in-scope attributed claim becomes its own single-member family
 * candidate. Clustering similar attributions is deferred to a later iteration.
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
      };
    });
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
function computeProbeStats(
  summaries: PaperHarvestSummary[],
): { probePaperCount: number; successfulHarvestCount: number; harvestSuccessRate: number } {
  const total = summaries.length;
  const successful = summaries.filter((s) => s.harvestOutcome === "success").length;
  return {
    probePaperCount: total,
    successfulHarvestCount: successful,
    harvestSuccessRate: total > 0 ? successful / total : 0,
  };
}
