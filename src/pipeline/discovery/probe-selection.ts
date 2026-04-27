import type {
  DiscoveryProbeSelection,
  ResolvedPaper,
  SeedNeighborhoodSnapshot,
} from "../../domain/types.js";

export const DEFAULT_PROBE_BUDGET = 20;

export function buildNeighborhood(
  doi: string,
  seedPaperId: string,
  citingPapers: ResolvedPaper[],
): SeedNeighborhoodSnapshot {
  let available = 0;
  let abstractOnly = 0;
  let unavailable = 0;
  for (const p of citingPapers) {
    const hint = p.fullTextHints.providerAvailability;
    if (hint === "available") available++;
    else if (hint === "abstract_only") abstractOnly++;
    else unavailable++;
  }
  return {
    seedPaperId,
    doi,
    totalCitingPapers: citingPapers.length,
    fullTextAvailableCount: available,
    abstractOnlyCount: abstractOnly,
    unavailableCount: unavailable,
    generatedAt: new Date().toISOString(),
  };
}

export function selectProbeSet(
  doi: string,
  seedPaperId: string,
  citingPapers: ResolvedPaper[],
  budget: number,
): DiscoveryProbeSelection {
  const useAll = citingPapers.length <= budget;

  // Sort: full-text-available first, then by year (newest first).
  const sorted = [...citingPapers].sort((a, b) => {
    const aAvail = a.fullTextHints.providerAvailability === "available" ? 0 : 1;
    const bAvail = b.fullTextHints.providerAvailability === "available" ? 0 : 1;
    if (aAvail !== bAvail) return aAvail - bAvail;
    return (b.publicationYear ?? 0) - (a.publicationYear ?? 0);
  });

  const papers = sorted.map((p, i) => {
    const hasFullText = p.fullTextHints.providerAvailability === "available";
    const selected = useAll ? hasFullText : i < budget && hasFullText;
    return {
      citingPaperId: p.id,
      citingPaperTitle: p.title,
      selected,
      reason: selected
        ? useAll
          ? ("selected_all_auditable" as const)
          : ("selected_full_text_available" as const)
        : !hasFullText
          ? ("excluded_no_full_text" as const)
          : ("excluded_probe_budget" as const),
    };
  });

  return {
    seedPaperId,
    doi,
    strategy: useAll ? "all_auditable" : "capped",
    ...(useAll ? {} : { probeBudget: budget }),
    papers,
    selectedCount: papers.filter((p) => p.selected).length,
    excludedCount: papers.filter((p) => !p.selected).length,
    generatedAt: new Date().toISOString(),
  };
}
