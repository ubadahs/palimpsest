import type {
  ClaimDiscoveryResult,
  ClaimRankingResult,
  DiscoveryHandoff,
  DiscoveryHandoffMap,
  FullTextAcquisition,
  HarvestedSeedMention,
  ParsedPaperDocument,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import { formatAcquisitionSummary } from "../retrieval/fulltext-fetch.js";
import type { ParsedPaperMaterializeResult } from "../retrieval/parsed-paper.js";
import {
  runAttributionDiscovery,
  type AttributionDiscoveryAdapters,
  type AttributionDiscoveryOptions,
  type AttributionDiscoveryResult,
  type FamilyGroundingTrace,
} from "./discovery-family-probe.js";

export type DiscoverySeedEntry = {
  doi: string;
  trackedClaim: string;
  notes?: string | undefined;
  /** Stable family identifier from attribution-first discovery. Used by the thin screen path. */
  familyId?: string | undefined;
};

export type DiscoveryStrategy = "legacy" | "attribution_first";

export type DiscoveryStageOptions = {
  dois: string[];
  topN: number;
  rank: boolean;
  model?: string | undefined;
  useThinking?: boolean | undefined;
  strategy?: DiscoveryStrategy;
  /** Required when strategy is "attribution_first". */
  attributionAdapters?: AttributionDiscoveryAdapters;
  attributionOptions?: AttributionDiscoveryOptions;
};

export type DiscoveryStageEvent = {
  step:
    | "resolve_paper"
    | "fetch_and_parse_full_text"
    | "extract_claims"
    | "rank_claims"
    // Attribution-first steps:
    | "gather_neighborhood"
    | "harvest_and_extract"
    | "ground_families"
    | "emit_shortlist";
  status: "started" | "updated" | "completed";
  detail: string;
  doi: string;
  index: number;
  total: number;
};

export type DiscoveryStageAdapters = {
  resolvePaperByDoi: (doi: string) => Promise<Result<ResolvedPaper>>;
  materializeParsedPaper: (
    paper: ResolvedPaper,
  ) => Promise<ParsedPaperMaterializeResult>;
  discoverClaims: (
    paper: ResolvedPaper,
    parsedDocument: ParsedPaperDocument,
    model?: string,
    useThinking?: boolean,
  ) => Promise<ClaimDiscoveryResult>;
  getCitingPapers: (openAlexId: string) => Promise<Result<ResolvedPaper[]>>;
  rankClaimsByEngagement: (
    seedTitle: string,
    claims: ClaimDiscoveryResult["claims"],
    citingPapers: ResolvedPaper[],
    onProgress?: (done: number, total: number) => void,
  ) => Promise<ClaimRankingResult>;
};

export type DiscoveryStageResult = {
  results: ClaimDiscoveryResult[];
  seeds: DiscoverySeedEntry[];
  /** Present when strategy is "attribution_first". */
  attributionDiscovery?: AttributionDiscoveryResult[];
  /**
   * Rich in-memory handoff for attribution-first runs.
   * Keyed by seed DOI. Contains resolved paper, seed full text, citing-paper
   * list, pre-harvested mentions, and per-family grounding traces.
   * Downstream stages (screen, extract) use this to avoid redundant I/O and
   * LLM calls. Undefined on legacy runs and on pipeline resume (when discover
   * already succeeded in a prior run and its handoff was not serialized).
   */
  handoffs?: DiscoveryHandoffMap;
};

function emit(
  onEvent: ((event: DiscoveryStageEvent) => void) | undefined,
  event: DiscoveryStageEvent,
): void {
  onEvent?.(event);
}

function makeResolutionFailureResult(
  doi: string,
  error: string,
): ClaimDiscoveryResult {
  return {
    doi,
    resolvedPaper: undefined,
    status: "parse_failed",
    statusDetail: `Could not resolve DOI: ${error}`,
    claims: [],
    findingCount: 0,
    totalClaimCount: 0,
    llmModel: undefined,
    llmInputTokens: undefined,
    llmOutputTokens: undefined,
    llmEstimatedCostUsd: undefined,
    ranking: undefined,
    fullTextAcquisition: undefined,
    generatedAt: new Date().toISOString(),
  };
}

function makeNoFullTextResult(
  doi: string,
  paper: ResolvedPaper,
  error: string,
  acquisition: FullTextAcquisition | undefined,
): ClaimDiscoveryResult {
  return {
    doi,
    resolvedPaper: paper,
    status: "no_fulltext",
    statusDetail: `Full text unavailable: ${error}`,
    claims: [],
    findingCount: 0,
    totalClaimCount: 0,
    llmModel: undefined,
    llmInputTokens: undefined,
    llmOutputTokens: undefined,
    llmEstimatedCostUsd: undefined,
    ranking: undefined,
    fullTextAcquisition: acquisition,
    generatedAt: new Date().toISOString(),
  };
}

export function buildDiscoverySeeds(
  results: ClaimDiscoveryResult[],
  topN: number,
): DiscoverySeedEntry[] {
  const seeds: DiscoverySeedEntry[] = [];

  for (const result of results) {
    if (result.status !== "completed") {
      continue;
    }

    if (result.ranking) {
      const topFindings = result.ranking.engagements
        .filter((engagement) => engagement.claimType === "finding")
        .filter((engagement) => engagement.directCount > 0)
        .slice(0, topN);

      for (const engagement of topFindings) {
        seeds.push({
          doi: result.doi,
          trackedClaim: engagement.claimText,
          notes: `Auto-discovered; ${String(engagement.directCount)} direct, ${String(engagement.indirectCount)} indirect citing-paper engagements`,
        });
      }
      continue;
    }

    const findings = result.claims
      .filter((claim) => claim.claimType === "finding")
      .slice(0, topN);
    for (const claim of findings) {
      seeds.push({
        doi: result.doi,
        trackedClaim: claim.claimText,
        notes: "Auto-discovered (unranked)",
      });
    }
  }

  return seeds;
}

export async function runDiscoveryStage(
  options: DiscoveryStageOptions,
  adapters: DiscoveryStageAdapters,
  onEvent?: (event: DiscoveryStageEvent) => void,
): Promise<DiscoveryStageResult> {
  if (options.strategy === "attribution_first") {
    return runAttributionFirstPath(options, onEvent);
  }

  const results: ClaimDiscoveryResult[] = [];
  const total = options.dois.length;

  for (let index = 0; index < options.dois.length; index++) {
    const doi = options.dois[index]!;
    const label = `[${String(index + 1)}/${String(total)}] ${doi}`;

    emit(onEvent, {
      step: "resolve_paper",
      status: "started",
      detail: label,
      doi,
      index,
      total,
    });
    const resolved = await adapters.resolvePaperByDoi(doi);
    if (!resolved.ok) {
      emit(onEvent, {
        step: "resolve_paper",
        status: "completed",
        detail: `Could not resolve ${doi}: ${resolved.error}`,
        doi,
        index,
        total,
      });
      results.push(makeResolutionFailureResult(doi, resolved.error));
      continue;
    }

    emit(onEvent, {
      step: "resolve_paper",
      status: "completed",
      detail: resolved.data.title,
      doi,
      index,
      total,
    });

    emit(onEvent, {
      step: "fetch_and_parse_full_text",
      status: "started",
      detail: label,
      doi,
      index,
      total,
    });
    const materialized = await adapters.materializeParsedPaper(resolved.data);
    if (!materialized.ok) {
      emit(onEvent, {
        step: "fetch_and_parse_full_text",
        status: "completed",
        detail: `No full text: ${materialized.error}`,
        doi,
        index,
        total,
      });
      results.push(
        makeNoFullTextResult(
          doi,
          resolved.data,
          materialized.error,
          materialized.acquisition,
        ),
      );
      continue;
    }

    emit(onEvent, {
      step: "fetch_and_parse_full_text",
      status: "completed",
      detail: `${String(materialized.data.parsedDocument.blocks.length)} blocks parsed via ${formatAcquisitionSummary(materialized.data.acquisition)}`,
      doi,
      index,
      total,
    });

    emit(onEvent, {
      step: "extract_claims",
      status: "started",
      detail: label,
      doi,
      index,
      total,
    });
    const discovered = await adapters.discoverClaims(
      resolved.data,
      materialized.data.parsedDocument,
      options.model,
      options.useThinking,
    );
    emit(onEvent, {
      step: "extract_claims",
      status: "completed",
      detail: `${String(discovered.findingCount)} findings, ${String(discovered.totalClaimCount)} total claims`,
      doi,
      index,
      total,
    });

    let result: ClaimDiscoveryResult = {
      ...discovered,
      fullTextAcquisition: materialized.data.acquisition,
    };

    if (
      options.rank &&
      result.status === "completed" &&
      result.claims.length > 0
    ) {
      emit(onEvent, {
        step: "rank_claims",
        status: "started",
        detail: `Ranking ${String(result.claims.length)} claims against citing papers...`,
        doi,
        index,
        total,
      });

      const citingResult = await adapters.getCitingPapers(resolved.data.id);
      if (citingResult.ok && citingResult.data.length > 0) {
        const ranking = await adapters.rankClaimsByEngagement(
          resolved.data.title,
          result.claims,
          citingResult.data,
          (done, rankTotal) => {
            emit(onEvent, {
              step: "rank_claims",
              status: "updated",
              detail: `Ranked ${String(done)}/${String(rankTotal)} citing papers`,
              doi,
              index,
              total,
            });
          },
        );
        const withDirect = ranking.engagements.filter(
          (engagement) => engagement.directCount > 0,
        ).length;
        result = {
          ...result,
          ranking,
        };
        emit(onEvent, {
          step: "rank_claims",
          status: "completed",
          detail: `${String(withDirect)} claims with direct citing-paper engagement`,
          doi,
          index,
          total,
        });
      } else {
        emit(onEvent, {
          step: "rank_claims",
          status: "completed",
          detail: citingResult.ok
            ? "No citing papers found — skipping ranking."
            : `Could not fetch citing papers: ${citingResult.error}`,
          doi,
          index,
          total,
        });
      }
    }

    results.push(result);
  }

  return {
    results,
    seeds: buildDiscoverySeeds(results, options.topN),
  };
}

// ---------------------------------------------------------------------------
// Attribution-first strategy
// ---------------------------------------------------------------------------

async function runAttributionFirstPath(
  options: DiscoveryStageOptions,
  onEvent?: (event: DiscoveryStageEvent) => void,
): Promise<DiscoveryStageResult> {
  if (!options.attributionAdapters) {
    throw new Error(
      "attributionAdapters are required when strategy is 'attribution_first'",
    );
  }

  const total = options.dois.length;
  const allAttributionResults: AttributionDiscoveryResult[] = [];
  const allSeeds: DiscoverySeedEntry[] = [];

  for (let index = 0; index < options.dois.length; index++) {
    const doi = options.dois[index]!;

    const result = await runAttributionDiscovery(
      doi,
      options.attributionAdapters,
      options.attributionOptions,
      (event) => {
        emit(onEvent, {
          step: event.step as DiscoveryStageEvent["step"],
          status: event.status,
          detail: event.detail,
          doi,
          index,
          total,
        });
      },
    );

    allAttributionResults.push(result);
    for (const entry of result.shortlistEntries) {
      allSeeds.push({
        doi: entry.doi,
        trackedClaim: entry.trackedClaim,
        notes: entry.notes,
        familyId: entry.familyId,
      });
    }
  }

  const handoffs = buildHandoffs(allAttributionResults);

  return {
    results: [],
    seeds: allSeeds,
    attributionDiscovery: allAttributionResults,
    handoffs,
  };
}

function buildHandoffs(
  results: AttributionDiscoveryResult[],
): DiscoveryHandoffMap {
  const map: DiscoveryHandoffMap = new Map();

  for (const result of results) {
    if (!result.resolvedPaper) continue;

    // Group mentions by citing-paper ID (only probed papers have mentions).
    const mentionsByPaperId = new Map<string, HarvestedSeedMention[]>();
    for (const mention of result.mentions) {
      const existing = mentionsByPaperId.get(mention.citingPaperId);
      if (existing) {
        existing.push(mention);
      } else {
        mentionsByPaperId.set(mention.citingPaperId, [mention]);
      }
    }

    // Index grounding traces by familyId.
    const groundingByFamilyId = new Map<string, FamilyGroundingTrace>();
    for (const trace of result.groundingTraces) {
      groundingByFamilyId.set(trace.familyId, trace);
    }

    const handoff: DiscoveryHandoff = {
      doi: result.doi,
      resolvedPaper: result.resolvedPaper,
      citingPapersRaw: result.citingPapers,
      mentionsByPaperId,
      groundingByFamilyId,
    };

    map.set(result.doi, handoff);
  }

  return map;
}
