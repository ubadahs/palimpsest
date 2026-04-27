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
  DiscoveryProbeSelection,
  DiscoveryShortlistEntry,
  HarvestedSeedMention,
  PaperHarvestSummary,
  ParsedPaperDocument,
  ResolvedPaper,
  Result,
  SeedNeighborhoodSnapshot,
} from "../domain/types.js";
import type { ParsedPaperMaterializeResult } from "../retrieval/parsed-paper.js";
import type { MentionHarvestAdapters } from "../retrieval/seed-mention-harvest.js";
import type { LLMClient } from "../integrations/llm-client.js";
import {
  buildSingletonFamilies,
  collapseExactDuplicateTrackedClaimFamilies,
  dedupeAttributedClaimFamilies,
} from "./attributed-claim-families.js";
import type { SeedClaimLlmGroundingOptions } from "./seed-claim-grounding-llm.js";
import {
  consolidateFamilyCandidates,
  type FamilyCandidateConsolidationResult,
} from "./family-consolidation.js";
import {
  buildNeighborhood,
  DEFAULT_PROBE_BUDGET,
  selectProbeSet,
} from "./discovery/probe-selection.js";
import {
  DEFAULT_HARVEST_CONCURRENCY,
  harvestAndExtractAttributions,
} from "./discovery/mention-harvest.js";
import {
  DEFAULT_GROUNDING_CONCURRENCY,
  groundFamiliesAgainstSeed,
} from "./discovery/family-grounding.js";
import { rankAndSelectShortlist } from "./discovery/shortlist-ranking.js";

import type { FamilyGroundingTrace } from "../domain/family-grounding-trace.js";
export type { FamilyGroundingTrace } from "../domain/family-grounding-trace.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

  const harvestConcurrency =
    options.harvestConcurrency ?? DEFAULT_HARVEST_CONCURRENCY;

  const harvestResult = await harvestAndExtractAttributions({
    seedPaper,
    selectedPapers,
    mentionHarvest: adapters.mentionHarvest,
    llmClient: adapters.llmClient,
    ...(options.extractionModel
      ? { extractionModel: options.extractionModel }
      : {}),
    ...(options.extractionThinking != null
      ? { extractionThinking: options.extractionThinking }
      : {}),
    harvestConcurrency,
    onPaperCompleted: (completed, total, title) =>
      emit(
        onEvent,
        "harvest_and_extract",
        "updated",
        `[${String(completed)}/${String(total)}] ${title.slice(0, 60)}`,
      ),
  });

  const allMentions = harvestResult.mentions;
  const allSummaries = harvestResult.harvestSummaries;
  const allRecords = harvestResult.extractionRecords;

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

    const groundingConcurrency =
      options.groundingConcurrency ?? DEFAULT_GROUNDING_CONCURRENCY;
    const traces = await groundFamiliesAgainstSeed({
      doi,
      seedPaper,
      seedParsedDocument,
      families,
      groundingOptions: adapters.groundingOptions,
      groundingConcurrency,
      onFamilyGrounded: (completed, total, claim) =>
        emit(
          onEvent,
          "ground_families",
          "updated",
          `[${String(completed)}/${String(total)}] ${claim.slice(0, 60)}`,
        ),
    });
    groundingTraces.push(...traces);

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

  const cap = options.shortlistCap ?? 5;
  const shortlistEntries = rankAndSelectShortlist(families, cap);

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
