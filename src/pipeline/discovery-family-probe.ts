/**
 * Attribution-first discovery probe (Phases 5–6 of discover redesign).
 *
 * Given a single seed DOI, runs the full attribution-first pipeline:
 *   resolve → materialize → gather neighborhood → select probe set →
 *   harvest mentions → extract attributed claims → build singleton families →
 *   ground families → score → shortlist
 */

import type {
  AttributedClaimExtractionRecord,
  AttributedClaimFamilyCandidate,
  ClaimGrounding,
  DiscoveryProbeSelection,
  DiscoveryShortlistEntry,
  FamilyCandidateSeedGrounding,
  HarvestedSeedMention,
  PaperHarvestSummary,
  ParsedPaperDocument,
  ResolvedPaper,
  Result,
  SeedNeighborhoodSnapshot,
} from "../domain/types.js";
import type { ParsedPaperMaterializeResult } from "../retrieval/parsed-paper.js";
import type {
  MentionHarvestAdapters,
  MentionHarvestResult,
} from "../retrieval/seed-mention-harvest.js";
import { harvestSeedMentions } from "../retrieval/seed-mention-harvest.js";
import type { LLMClient } from "../integrations/llm-client.js";
import { extractAttributedClaims } from "./attributed-claim-extraction.js";
import { buildSingletonFamilies } from "./attributed-claim-families.js";
import {
  runLlmFullDocumentClaimGrounding,
  buildSeedFullTextForLlm,
  type SeedClaimLlmGroundingOptions,
} from "./seed-claim-grounding-llm.js";

/** Per-family grounding trace persisted in the grounding-trace sidecar. */
export type FamilyGroundingTrace = {
  familyId: string;
  canonicalTrackedClaim: string;
  grounding: ClaimGrounding;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_PROBE_BUDGET = 20;

export type AttributionDiscoveryOptions = {
  probeBudget?: number;
  extractionModel?: string;
  groundingModel?: string;
  /** Max families to include in shortlist (by grounding status then mention count). */
  shortlistCap?: number;
};

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export type AttributionDiscoveryAdapters = {
  resolvePaperByDoi: (doi: string) => Promise<Result<ResolvedPaper>>;
  materializeParsedPaper: (
    paper: ResolvedPaper,
  ) => Promise<ParsedPaperMaterializeResult>;
  getCitingPapers: (openAlexId: string) => Promise<Result<ResolvedPaper[]>>;
  mentionHarvest: MentionHarvestAdapters;
  llmClient: LLMClient;
  groundingOptions: SeedClaimLlmGroundingOptions;
};

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

export type AttributionDiscoveryStep =
  | "resolve_paper"
  | "fetch_and_parse_full_text"
  | "gather_neighborhood"
  | "harvest_and_extract"
  | "ground_families"
  | "emit_shortlist";

export type AttributionDiscoveryEvent = {
  step: AttributionDiscoveryStep;
  status: "started" | "updated" | "completed";
  detail: string;
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type AttributionDiscoveryResult = {
  doi: string;
  resolvedPaper: ResolvedPaper | undefined;
  seedParsedDocument: ParsedPaperDocument | undefined;
  neighborhood: SeedNeighborhoodSnapshot;
  probeSelection: DiscoveryProbeSelection;
  mentions: HarvestedSeedMention[];
  harvestSummaries: PaperHarvestSummary[];
  extractionRecords: AttributedClaimExtractionRecord[];
  familyCandidates: AttributedClaimFamilyCandidate[];
  groundingTraces: FamilyGroundingTrace[];
  shortlistEntries: DiscoveryShortlistEntry[];
  /** Non-fatal errors accumulated during the run. */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(
  onEvent: ((e: AttributionDiscoveryEvent) => void) | undefined,
  step: AttributionDiscoveryStep,
  status: AttributionDiscoveryEvent["status"],
  detail: string,
): void {
  onEvent?.({ step, status, detail });
}

function buildNeighborhood(
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

function selectProbeSet(
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
    const hasFullText =
      p.fullTextHints.providerAvailability === "available";
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

function toSeedGrounding(
  grounding: ClaimGrounding,
): FamilyCandidateSeedGrounding {
  const spanTexts = grounding.supportSpans.map((s) => s.text);
  return {
    status: grounding.status,
    supportSpanText:
      spanTexts.length > 0 ? spanTexts.join(" … ") : undefined,
    groundingDetail: grounding.detailReason,
  };
}

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
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runAttributionDiscovery(
  doi: string,
  adapters: AttributionDiscoveryAdapters,
  options: AttributionDiscoveryOptions = {},
  onEvent?: (e: AttributionDiscoveryEvent) => void,
): Promise<AttributionDiscoveryResult> {
  const budget = options.probeBudget ?? DEFAULT_PROBE_BUDGET;
  const warnings: string[] = [];

  const emptyNeighborhood: SeedNeighborhoodSnapshot = {
    seedPaperId: "",
    doi,
    totalCitingPapers: 0,
    fullTextAvailableCount: 0,
    abstractOnlyCount: 0,
    unavailableCount: 0,
    generatedAt: new Date().toISOString(),
  };
  const emptyProbe: DiscoveryProbeSelection = {
    seedPaperId: "",
    doi,
    strategy: "all_auditable",
    papers: [],
    selectedCount: 0,
    excludedCount: 0,
    generatedAt: new Date().toISOString(),
  };

  const empty = (
    paper?: ResolvedPaper,
    neighborhood?: SeedNeighborhoodSnapshot,
    probe?: DiscoveryProbeSelection,
  ): AttributionDiscoveryResult => ({
    doi,
    resolvedPaper: paper,
    seedParsedDocument: undefined,
    neighborhood: neighborhood ?? emptyNeighborhood,
    probeSelection: probe ?? emptyProbe,
    mentions: [],
    harvestSummaries: [],
    extractionRecords: [],
    familyCandidates: [],
    groundingTraces: [],
    shortlistEntries: [],
    warnings,
  });

  // --- 1. Resolve seed paper ---
  emit(onEvent, "resolve_paper", "started", doi);
  const resolved = await adapters.resolvePaperByDoi(doi);
  if (!resolved.ok) {
    warnings.push(`Could not resolve DOI: ${resolved.error}`);
    emit(onEvent, "resolve_paper", "completed", `Failed: ${resolved.error}`);
    return empty();
  }
  const seedPaper = resolved.data;
  emit(onEvent, "resolve_paper", "completed", seedPaper.title);

  // --- 2. Materialize seed full text ---
  emit(onEvent, "fetch_and_parse_full_text", "started", seedPaper.title);
  const materialized = await adapters.materializeParsedPaper(seedPaper);
  let seedParsedDocument: ParsedPaperDocument | undefined;
  if (materialized.ok) {
    seedParsedDocument = materialized.data.parsedDocument;
    emit(
      onEvent,
      "fetch_and_parse_full_text",
      "completed",
      `${String(seedParsedDocument.blocks.length)} blocks parsed`,
    );
  } else {
    warnings.push(`Seed full text unavailable: ${materialized.error}`);
    emit(
      onEvent,
      "fetch_and_parse_full_text",
      "completed",
      `No full text: ${materialized.error}`,
    );
  }

  // --- 3. Gather neighborhood ---
  emit(onEvent, "gather_neighborhood", "started", "Fetching citing papers…");
  const citingResult = await adapters.getCitingPapers(seedPaper.id);
  if (!citingResult.ok || citingResult.data.length === 0) {
    const reason = citingResult.ok
      ? "No citing papers found"
      : citingResult.error;
    warnings.push(reason);
    emit(onEvent, "gather_neighborhood", "completed", reason);
    const nh = buildNeighborhood(doi, seedPaper.id, []);
    return empty(seedPaper, nh);
  }
  const citingPapers = citingResult.data;
  const neighborhood = buildNeighborhood(doi, seedPaper.id, citingPapers);
  const probeSelection = selectProbeSet(doi, seedPaper.id, citingPapers, budget);
  emit(
    onEvent,
    "gather_neighborhood",
    "completed",
    `${String(neighborhood.totalCitingPapers)} citing papers, ${String(probeSelection.selectedCount)} selected for probing`,
  );

  // --- 4. Harvest mentions + extract attributed claims ---
  emit(
    onEvent,
    "harvest_and_extract",
    "started",
    `Probing ${String(probeSelection.selectedCount)} papers…`,
  );

  const selectedPapers = citingPapers.filter((p) =>
    probeSelection.papers.some((e) => e.citingPaperId === p.id && e.selected),
  );

  const allMentions: HarvestedSeedMention[] = [];
  const allSummaries: PaperHarvestSummary[] = [];
  const allRecords: AttributedClaimExtractionRecord[] = [];

  for (let i = 0; i < selectedPapers.length; i++) {
    const citingPaper = selectedPapers[i]!;
    emit(
      onEvent,
      "harvest_and_extract",
      "updated",
      `[${String(i + 1)}/${String(selectedPapers.length)}] ${citingPaper.title.slice(0, 60)}`,
    );

    const harvest: MentionHarvestResult = await harvestSeedMentions(
      citingPaper,
      seedPaper,
      adapters.mentionHarvest,
    );
    allSummaries.push(harvest.summary);

    if (harvest.outcome !== "success" || harvest.mentions.length === 0) {
      continue;
    }
    allMentions.push(...harvest.mentions);

    const records = await extractAttributedClaims({
      seedPaper,
      citingPaperTitle: citingPaper.title,
      mentions: harvest.mentions,
      client: adapters.llmClient,
      ...(options.extractionModel
        ? { options: { model: options.extractionModel } }
        : {}),
    });
    allRecords.push(...records);
  }

  emit(
    onEvent,
    "harvest_and_extract",
    "completed",
    `${String(allMentions.length)} mentions harvested, ${String(allRecords.filter((r) => r.inScopeEmpiricalAttribution).length)} in-scope attributions`,
  );

  // --- 5. Build singleton families ---
  const families = buildSingletonFamilies({
    doi,
    records: allRecords,
    mentions: allMentions,
    harvestSummaries: allSummaries,
  });

  // --- 6. Ground families against seed ---
  const groundingTraces: FamilyGroundingTrace[] = [];

  if (seedParsedDocument && families.length > 0) {
    emit(
      onEvent,
      "ground_families",
      "started",
      `Grounding ${String(families.length)} candidate(s)…`,
    );

    const manuscript = buildSeedFullTextForLlm(seedParsedDocument);
    if (manuscript.length > 0) {
      for (let i = 0; i < families.length; i++) {
        const fam = families[i]!;
        emit(
          onEvent,
          "ground_families",
          "updated",
          `[${String(i + 1)}/${String(families.length)}] ${fam.canonicalTrackedClaim.slice(0, 60)}`,
        );

        const { grounding } = await runLlmFullDocumentClaimGrounding({
          seed: { doi, trackedClaim: fam.canonicalTrackedClaim },
          seedPaper,
          parsedDocument: seedParsedDocument,
          options: adapters.groundingOptions,
        });
        fam.seedGrounding = toSeedGrounding(grounding);
        groundingTraces.push({
          familyId: fam.familyId,
          canonicalTrackedClaim: fam.canonicalTrackedClaim,
          grounding,
        });
      }
    } else {
      for (const fam of families) {
        fam.seedGrounding = {
          status: "no_seed_fulltext",
          supportSpanText: undefined,
          groundingDetail: "Parsed document has no text blocks",
        };
      }
    }

    emit(
      onEvent,
      "ground_families",
      "completed",
      `${String(families.filter((f) => f.seedGrounding.status === "grounded").length)} grounded`,
    );
  } else if (families.length > 0) {
    emit(onEvent, "ground_families", "started", "Skipping — no seed full text");
    for (const fam of families) {
      fam.seedGrounding = {
        status: "no_seed_fulltext",
        supportSpanText: undefined,
        groundingDetail: "Seed full text not available for grounding",
      };
    }
    emit(onEvent, "ground_families", "completed", "Skipped");
  }

  // --- 7. Score + shortlist ---
  emit(onEvent, "emit_shortlist", "started", "Ranking families…");

  // Sort: grounded first, then by grounding status, then by confidence.
  const ranked = [...families].sort((a, b) => {
    const statusOrder = groundingStatusRank(a.seedGrounding.status) -
      groundingStatusRank(b.seedGrounding.status);
    if (statusOrder !== 0) return statusOrder;
    return b.memberMentionIds.length - a.memberMentionIds.length;
  });

  const cap = options.shortlistCap ?? 10;
  const shortlisted = ranked.slice(0, cap);
  for (const fam of families) {
    const isShortlisted = shortlisted.includes(fam);
    fam.shortlistEligible = isShortlisted;
    if (!isShortlisted) {
      fam.shortlistReason = "Excluded from shortlist by cap";
    }
  }

  const shortlistEntries = shortlisted.map(toShortlistEntry);

  emit(
    onEvent,
    "emit_shortlist",
    "completed",
    `${String(shortlistEntries.length)} families shortlisted from ${String(families.length)} candidates`,
  );

  return {
    doi,
    resolvedPaper: seedPaper,
    seedParsedDocument,
    neighborhood,
    probeSelection,
    mentions: allMentions,
    harvestSummaries: allSummaries,
    extractionRecords: allRecords,
    familyCandidates: families,
    groundingTraces,
    shortlistEntries,
    warnings,
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
