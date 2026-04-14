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
import {
  buildSingletonFamilies,
  collapseExactDuplicateTrackedClaimFamilies,
  dedupeAttributedClaimFamilies,
  selectDiverseShortlistFamilies,
} from "./attributed-claim-families.js";
import { pMap } from "../shared/p-map.js";
import {
  runLlmFullDocumentClaimGrounding,
  buildSeedFullTextForLlm,
  type SeedClaimLlmGroundingOptions,
} from "./seed-claim-grounding-llm.js";
import {
  consolidateFamilyCandidates,
  type FamilyCandidateConsolidationResult,
} from "./family-consolidation.js";

/** Per-family grounding trace persisted in the grounding-trace sidecar. */
export type FamilyGroundingTrace = {
  familyId: string;
  canonicalTrackedClaim: string;
  grounding: ClaimGrounding;
  /** Present when an LLM grounding call ran; includes Anthropic cache token fields when reported. */
  llmUsage?: {
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_PROBE_BUDGET = 20;

const DEFAULT_HARVEST_CONCURRENCY = 8;
const DEFAULT_GROUNDING_CONCURRENCY = 5;

export type AttributionDiscoveryOptions = {
  probeBudget?: number;
  extractionModel?: string;
  extractionThinking?: boolean;
  groundingModel?: string;
  groundingThinking?: boolean;
  /** Max families to include in shortlist (by grounding status then mention count). */
  shortlistCap?: number;
  /** Parallel citing-paper harvest + extraction (bounded). */
  harvestConcurrency?: number;
  /** Parallel per-family seed grounding LLM calls (bounded). */
  groundingConcurrency?: number;
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
  | "consolidate_families"
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
  /**
   * Full citing-paper list fetched from OpenAlex (up to the discovery fetch
   * limit). Present on successful runs; empty array when the neighborhood fetch
   * failed or returned no results. Used by the rich handoff to pass the
   * neighborhood to screen without a second OpenAlex call.
   */
  citingPapers: ResolvedPaper[];
  mentions: HarvestedSeedMention[];
  harvestSummaries: PaperHarvestSummary[];
  extractionRecords: AttributedClaimExtractionRecord[];
  familyCandidates: AttributedClaimFamilyCandidate[];
  groundingTraces: FamilyGroundingTrace[];
  shortlistEntries: DiscoveryShortlistEntry[];
  /** Consolidation provenance — present when >1 families existed before shortlisting. */
  consolidation?: FamilyCandidateConsolidationResult | undefined;
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

function toSeedGrounding(
  grounding: ClaimGrounding,
): FamilyCandidateSeedGrounding {
  const spanTexts = grounding.supportSpans.map((s) => s.text);
  return {
    status: grounding.status,
    normalizedClaim: grounding.normalizedClaim,
    supportSpanText: spanTexts.length > 0 ? spanTexts.join(" … ") : undefined,
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
    dedupeGroupId: family.dedupe.dedupeGroupId,
    dedupeStatus: family.dedupe.dedupeStatus,
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
    citing: ResolvedPaper[] = [],
  ): AttributionDiscoveryResult => ({
    doi,
    resolvedPaper: paper,
    seedParsedDocument: undefined,
    neighborhood: neighborhood ?? emptyNeighborhood,
    probeSelection: probe ?? emptyProbe,
    citingPapers: citing,
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
    return empty(seedPaper, nh, undefined, []);
  }
  const citingPapers = citingResult.data;
  const neighborhood = buildNeighborhood(doi, seedPaper.id, citingPapers);
  const probeSelection = selectProbeSet(
    doi,
    seedPaper.id,
    citingPapers,
    budget,
  );
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

  const harvestConcurrency =
    options.harvestConcurrency ?? DEFAULT_HARVEST_CONCURRENCY;
  const probeTotal = selectedPapers.length;
  let harvestCompleted = 0;

  const harvestChunks = await pMap(
    selectedPapers,
    async (citingPaper) => {
      const harvest: MentionHarvestResult = await harvestSeedMentions(
        citingPaper,
        seedPaper,
        adapters.mentionHarvest,
      );

      let records: AttributedClaimExtractionRecord[] = [];
      if (harvest.outcome === "success" && harvest.mentions.length > 0) {
        records = await extractAttributedClaims({
          seedPaper,
          citingPaperTitle: citingPaper.title,
          mentions: harvest.mentions,
          client: adapters.llmClient,
          options: {
            ...(options.extractionModel
              ? { model: options.extractionModel }
              : {}),
            useThinking: options.extractionThinking ?? false,
            enableExactCache: true,
          },
        });
      }

      harvestCompleted += 1;
      emit(
        onEvent,
        "harvest_and_extract",
        "updated",
        `[${String(harvestCompleted)}/${String(probeTotal)}] ${citingPaper.title.slice(0, 60)}`,
      );

      return { harvest, records };
    },
    { concurrency: harvestConcurrency },
  );

  for (const { harvest, records } of harvestChunks) {
    allSummaries.push(harvest.summary);
    if (harvest.outcome !== "success" || harvest.mentions.length === 0) {
      continue;
    }
    allMentions.push(...harvest.mentions);
    allRecords.push(...records);
  }

  emit(
    onEvent,
    "harvest_and_extract",
    "completed",
    `${String(allMentions.length)} mentions harvested, ${String(allRecords.filter((r) => r.inScopeEmpiricalAttribution).length)} in-scope attributions`,
  );

  // --- 5. Build singleton families ---
  const singletonFamilies = buildSingletonFamilies({
    doi,
    records: allRecords,
    mentions: allMentions,
    harvestSummaries: allSummaries,
  });
  let families = collapseExactDuplicateTrackedClaimFamilies(singletonFamilies);

  // --- 6. Ground families against seed ---
  let groundingTraces: FamilyGroundingTrace[] = [];

  if (seedParsedDocument && families.length > 0) {
    emit(
      onEvent,
      "ground_families",
      "started",
      `Grounding ${String(families.length)} candidate(s)…`,
    );

    const manuscript = buildSeedFullTextForLlm(seedParsedDocument);
    if (manuscript.length > 0) {
      const groundingConcurrency =
        options.groundingConcurrency ?? DEFAULT_GROUNDING_CONCURRENCY;
      const groundTotal = families.length;
      let groundCompleted = 0;

      const traces = await pMap(
        families,
        async (fam) => {
          const { grounding, llmCall } = await runLlmFullDocumentClaimGrounding(
            {
              seed: { doi, trackedClaim: fam.canonicalTrackedClaim },
              seedPaper,
              parsedDocument: seedParsedDocument,
              options: adapters.groundingOptions,
            },
          );
          fam.seedGrounding = toSeedGrounding(grounding);

          groundCompleted += 1;
          emit(
            onEvent,
            "ground_families",
            "updated",
            `[${String(groundCompleted)}/${String(groundTotal)}] ${fam.canonicalTrackedClaim.slice(0, 60)}`,
          );

          return {
            familyId: fam.familyId,
            canonicalTrackedClaim: fam.canonicalTrackedClaim,
            grounding,
            ...(llmCall != null &&
            (llmCall.inputTokens != null ||
              typeof llmCall.cacheReadTokens === "number" ||
              typeof llmCall.cacheWriteTokens === "number")
              ? {
                  llmUsage: {
                    ...(llmCall.inputTokens != null
                      ? { inputTokens: llmCall.inputTokens }
                      : {}),
                    ...(typeof llmCall.cacheReadTokens === "number"
                      ? { cacheReadTokens: llmCall.cacheReadTokens }
                      : {}),
                    ...(typeof llmCall.cacheWriteTokens === "number"
                      ? { cacheWriteTokens: llmCall.cacheWriteTokens }
                      : {}),
                  },
                }
              : {}),
          } satisfies FamilyGroundingTrace;
        },
        { concurrency: groundingConcurrency },
      );

      traces.sort((a, b) => a.familyId.localeCompare(b.familyId));
      groundingTraces.push(...traces);
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

  families = dedupeAttributedClaimFamilies(families);

  // --- 7. Semantic consolidation (before shortlist cap) ---
  let consolidation: FamilyCandidateConsolidationResult | undefined;
  if (families.length > 1) {
    emit(
      onEvent,
      "consolidate_families",
      "started",
      `Consolidating ${String(families.length)} candidate(s)…`,
    );
    consolidation = await consolidateFamilyCandidates(
      families,
      groundingTraces,
      adapters.llmClient,
    );
    families = consolidation.consolidatedCandidates;
    groundingTraces = consolidation.consolidatedTraces;

    emit(
      onEvent,
      "consolidate_families",
      "completed",
      consolidation.eliminatedCount > 0
        ? `${String(consolidation.originalCandidates.length)} → ${String(families.length)} families (${String(consolidation.eliminatedCount)} merged)`
        : `${String(families.length)} families — all semantically distinct`,
    );
  }

  // --- 8. Score + shortlist ---
  emit(onEvent, "emit_shortlist", "started", "Ranking families…");

  // Sort: grounded first, then by grounding status, then by confidence.
  const ranked = [...families].sort((a, b) => {
    const statusOrder =
      groundingStatusRank(a.seedGrounding.status) -
      groundingStatusRank(b.seedGrounding.status);
    if (statusOrder !== 0) return statusOrder;
    return b.memberMentionIds.length - a.memberMentionIds.length;
  });

  const cap = options.shortlistCap ?? 5;
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

  const shortlistEntries = shortlisted.map(toShortlistEntry);

  emit(
    onEvent,
    "emit_shortlist",
    "completed",
    `${String(shortlistEntries.length)} families shortlisted from ${String(families.length)} candidates (${String(singletonFamilies.length - families.length)} duplicates merged)`,
  );

  return {
    doi,
    resolvedPaper: seedPaper,
    seedParsedDocument,
    neighborhood,
    probeSelection,
    citingPapers,
    mentions: allMentions,
    harvestSummaries: allSummaries,
    extractionRecords: allRecords,
    familyCandidates: families,
    groundingTraces,
    shortlistEntries,
    consolidation,
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
