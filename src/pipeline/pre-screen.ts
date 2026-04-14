import { classifyEdge } from "../domain/attribution-signal.js";
import { assessAuditability } from "../domain/auditability.js";
import { claimGroundingBlocksAnalysis } from "../domain/pre-screen.js";
import type {
  ClaimFamilyPreScreen,
  ClaimGrounding,
  DiscoveryHandoff,
  DiscoveryHandoffMap,
  FamilyUseProfileTag,
  M2Priority,
  PreScreenEdge,
  PreScreenGroundingTraceFile,
  PreScreenGroundingTraceRecord,
  PreScreenMetrics,
  ResolvedPaper,
  Result,
  SeedPaperInput,
} from "../domain/types.js";
import type { FamilyGroundingTrace } from "./discovery-family-probe.js";
import type { DiscoverySeedEntry } from "./discovery-stage.js";
import {
  PRE_SCREEN_GROUNDING_TRACE_SCHEMA_VERSION,
  normalizeSeedDoiForTraceKey,
} from "../domain/pre-screen-grounding-trace.js";
import type { LLMClient } from "../integrations/llm-client.js";
import { createLLMClient } from "../integrations/llm-client.js";
import { buildRetrievalQuery, rankDocumentsByBm25 } from "../retrieval/bm25.js";
import { deduplicatePapers } from "./dedup.js";
import {
  llmFilterClaimFamily,
  type ClaimFamilyCandidate,
} from "./llm-claim-family-filter.js";
import { runLlmFullDocumentClaimGrounding } from "./seed-claim-grounding-llm.js";
import type { SeedClaimGroundingAdapters } from "./seed-claim-grounding.js";
import { pMap } from "../shared/p-map.js";

// --- Adapter interface for dependency injection ---

export type PreScreenAdapters = {
  resolveByDoi: (doi: string) => Promise<Result<ResolvedPaper>>;
  getCitingPapers: (openAlexId: string) => Promise<Result<ResolvedPaper[]>>;
  findPublishedVersion?: (
    title: string,
    excludeId: string,
  ) => Promise<Result<ResolvedPaper>>;
  /** Required for claim grounding in the seed paper (fetch + parse full text). */
  seedClaimGrounding: SeedClaimGroundingAdapters;
};

export type PreScreenOptions = {
  minAuditableCoverage: number;
  minAuditableEdges: number;
  /** Full-manuscript LLM claim grounding (canonical). */
  llmGrounding: {
    anthropicApiKey: string;
    model?: string;
    useThinking?: boolean;
    llmClient?: LLMClient;
    enableExactCache?: boolean;
  };
  /** Options for the LLM claim-family filter step. */
  llmFilter?: {
    model?: string;
    concurrency?: number;
    llmClient?: LLMClient;
  };
  /** Max concurrent seed processing. Default 3. */
  seedConcurrency?: number;
  /**
   * Skip the BM25 + LLM claim-family filter and include all edges.
   * Use this for attribution-first discovery, where citer→claim associations
   * were already established from full-text analysis during discovery.
   */
  skipClaimFamilyFilter?: boolean;
};

export type PreScreenRunResult = {
  families: ClaimFamilyPreScreen[];
  groundingTrace: PreScreenGroundingTraceFile;
};

export type PreScreenProgressEvent = {
  step:
    | "resolve_seed_paper"
    | "ground_tracked_claim"
    | "gather_citing_papers"
    | "collapse_duplicates"
    | "filter_claim_family"
    | "assess_auditability"
    | "summarize_family_viability";
  status: "running" | "completed" | "skipped";
  detail?: string;
  current?: number;
  total?: number;
};

const DEFAULT_NUMERIC_OPTIONS = {
  minAuditableCoverage: 0.3,
  minAuditableEdges: 3,
} as const;

// --- Metrics: describes citation population composition ---

function rate(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

function computeMetrics(
  edges: PreScreenEdge[],
  totalBeforeDedup: number,
): PreScreenMetrics {
  const unique = edges.length;
  let structured = 0;
  let pdf = 0;
  let partial = 0;
  let notAuditable = 0;
  let primaryLike = 0;
  let reviews = 0;
  let commentaries = 0;
  let letters = 0;
  let bookChapters = 0;
  let articles = 0;
  let preprints = 0;

  for (const edge of edges) {
    if (edge.auditabilityStatus === "auditable_structured") structured++;
    else if (edge.auditabilityStatus === "auditable_pdf") pdf++;
    else if (edge.auditabilityStatus === "partially_auditable") partial++;
    else notAuditable++;

    const c = edge.classification;
    if (c.isPrimaryLike) primaryLike++;
    if (c.isReview) reviews++;
    if (c.isCommentary) commentaries++;
    if (c.isLetter) letters++;
    if (c.isBookChapter) bookChapters++;
    if (c.isJournalArticle) articles++;
    if (c.isPreprint) preprints++;
  }

  return {
    totalEdges: totalBeforeDedup,
    uniqueEdges: unique,
    collapsedDuplicates: totalBeforeDedup - unique,
    auditableStructuredEdges: structured,
    auditablePdfEdges: pdf,
    partiallyAuditableEdges: partial,
    notAuditableEdges: notAuditable,
    auditableCoverage: rate(structured + pdf, unique),
    primaryLikeEdgeCount: primaryLike,
    primaryLikeEdgeRate: rate(primaryLike, unique),
    reviewEdgeCount: reviews,
    reviewEdgeRate: rate(reviews, unique),
    commentaryEdgeCount: commentaries,
    commentaryEdgeRate: rate(commentaries, unique),
    letterEdgeCount: letters,
    letterEdgeRate: rate(letters, unique),
    bookChapterEdgeCount: bookChapters,
    bookChapterEdgeRate: rate(bookChapters, unique),
    articleEdgeCount: articles,
    articleEdgeRate: rate(articles, unique),
    preprintEdgeCount: preprints,
    preprintEdgeRate: rate(preprints, unique),
  };
}

// --- Decision: based exclusively on auditable edge count and coverage ---

function makeDecision(
  metrics: PreScreenMetrics,
  seedResolved: boolean,
  options: { minAuditableCoverage: number; minAuditableEdges: number },
  claimGrounding?: ClaimGrounding,
): { decision: ClaimFamilyPreScreen["decision"]; reason: string } {
  if (!seedResolved) {
    return {
      decision: "deprioritize",
      reason: "Seed paper could not be resolved",
    };
  }

  if (claimGrounding && claimGroundingBlocksAnalysis(claimGrounding)) {
    return {
      decision: "deprioritize",
      reason: `Claim not grounded in seed paper (${claimGrounding.status}): ${claimGrounding.detailReason}`,
    };
  }

  if (metrics.uniqueEdges === 0) {
    return {
      decision: "deprioritize",
      reason:
        "No citing papers in the claim-scoped family (title/abstract do not match the grounded claim strongly enough), or no citing papers found",
    };
  }

  const totalAuditable =
    metrics.auditableStructuredEdges + metrics.auditablePdfEdges;

  if (totalAuditable < options.minAuditableEdges) {
    return {
      decision: "deprioritize",
      reason: `Only ${String(totalAuditable)} auditable edge(s), need at least ${String(options.minAuditableEdges)}`,
    };
  }

  if (metrics.auditableCoverage < options.minAuditableCoverage) {
    return {
      decision: "deprioritize",
      reason: `Auditable coverage ${(metrics.auditableCoverage * 100).toFixed(0)}% is below ${(options.minAuditableCoverage * 100).toFixed(0)}% threshold`,
    };
  }

  return {
    decision: "greenlight",
    reason: `${String(totalAuditable)} auditable edges (${String(metrics.auditableStructuredEdges)} structured, ${String(metrics.auditablePdfEdges)} PDF), ${(metrics.auditableCoverage * 100).toFixed(0)}% coverage, ${String(metrics.uniqueEdges)} unique (${String(metrics.collapsedDuplicates)} collapsed)`,
  };
}

// --- Family use profile: descriptive tags characterizing the neighborhood ---

const PROFILE_DISPLAY_ORDER: readonly FamilyUseProfileTag[] = [
  "small_family",
  "primary_empirical_heavy",
  "mixed_primary_review",
  "review_mediated",
  "duplicate_heavy",
  "low_access",
];

function computeFamilyUseProfile(
  metrics: PreScreenMetrics,
): FamilyUseProfileTag[] {
  const tags = new Set<FamilyUseProfileTag>();

  if (metrics.uniqueEdges > 0 && metrics.uniqueEdges <= 5) {
    tags.add("small_family");
  }

  if (metrics.uniqueEdges > 0 && metrics.primaryLikeEdgeRate >= 0.7) {
    tags.add("primary_empirical_heavy");
  } else if (
    metrics.uniqueEdges > 0 &&
    metrics.reviewEdgeRate >= 0.4 &&
    metrics.primaryLikeEdgeRate >= 0.2
  ) {
    tags.add("mixed_primary_review");
  } else if (metrics.uniqueEdges > 0 && metrics.reviewEdgeRate >= 0.5) {
    tags.add("review_mediated");
  }

  if (
    metrics.totalEdges > 0 &&
    metrics.collapsedDuplicates / metrics.totalEdges >= 0.2
  ) {
    tags.add("duplicate_heavy");
  }

  if (metrics.uniqueEdges > 0 && metrics.auditableCoverage < 0.5) {
    tags.add("low_access");
  }

  return PROFILE_DISPLAY_ORDER.filter((t) => tags.has(t));
}

function notAttemptedGrounding(
  seed: SeedPaperInput,
  detailReason: string,
): ClaimGrounding {
  const text = seed.trackedClaim.trim();
  return {
    status: "not_attempted",
    analystClaim: text,
    normalizedClaim: text,
    supportSpans: [],
    blocksDownstream: true,
    detailReason,
  };
}

/** Minimum BM25 score as a fraction of the best citing-paper score to stay in the claim family. */
const CLAIM_RELEVANCE_MIN_FRACTION = 0.22;

function annotateClaimFamilyMembership(
  edges: PreScreenEdge[],
  resolvedPapers: Record<string, ResolvedPaper>,
  claimQuery: string,
): void {
  type Doc = { edge: PreScreenEdge; text: string };
  const docs: Doc[] = [];
  for (const edge of edges) {
    const paper = resolvedPapers[edge.citingPaperId];
    if (!paper) {
      continue;
    }
    const text = buildRetrievalQuery([paper.title, paper.abstract ?? ""]);
    docs.push({ edge, text });
  }

  if (docs.length === 0) {
    return;
  }

  const ranked = rankDocumentsByBm25(
    claimQuery,
    docs,
    (d) => d.text,
    docs.length,
  );
  const scoreByEdgeId = new Map<string, number>();
  for (const r of ranked) {
    scoreByEdgeId.set(r.document.edge.citingPaperId, r.score);
  }

  let maxScore = 0;
  for (const d of docs) {
    const s = scoreByEdgeId.get(d.edge.citingPaperId) ?? 0;
    if (s > maxScore) {
      maxScore = s;
    }
  }

  const threshold = maxScore > 0 ? maxScore * CLAIM_RELEVANCE_MIN_FRACTION : 0;

  for (const d of docs) {
    const s = scoreByEdgeId.get(d.edge.citingPaperId) ?? 0;
    d.edge.claimRelevanceScore = s;
    d.edge.inClaimFamily = maxScore > 0 && s >= threshold;
  }
}

function mergeClaimFamilyMetrics(
  neighborhood: PreScreenMetrics,
  familyEdges: PreScreenEdge[],
): PreScreenMetrics {
  const inner = computeMetrics(familyEdges, familyEdges.length);
  return {
    ...inner,
    totalEdges: neighborhood.totalEdges,
    uniqueEdges: familyEdges.length,
    collapsedDuplicates: neighborhood.collapsedDuplicates,
  };
}

// --- M2 priority: advisory recommendation, does not affect greenlight ---

function computeM2Priority(
  metrics: PreScreenMetrics,
  decision: ClaimFamilyPreScreen["decision"],
): M2Priority {
  if (decision === "deprioritize") {
    return "not_now";
  }

  const auditable =
    metrics.auditableStructuredEdges + metrics.auditablePdfEdges;

  if (auditable >= 10 && metrics.primaryLikeEdgeRate >= 0.5) {
    return "first";
  }

  if (auditable >= 5) {
    return "later";
  }

  return "caution";
}

// --- Single seed processing ---

async function processOneSeed(
  seed: SeedPaperInput,
  adapters: PreScreenAdapters,
  paperCache: Map<string, ResolvedPaper>,
  options: PreScreenOptions,
  onProgress?: (event: PreScreenProgressEvent) => void,
): Promise<{
  family: ClaimFamilyPreScreen;
  traceRecord: PreScreenGroundingTraceRecord;
}> {
  const emptyMetrics = computeMetrics([], 0);

  onProgress?.({
    step: "resolve_seed_paper",
    status: "running",
    detail: `Resolving ${seed.doi}`,
  });
  const seedResult = await adapters.resolveByDoi(seed.doi);

  if (!seedResult.ok) {
    onProgress?.({
      step: "resolve_seed_paper",
      status: "completed",
      detail: `Seed could not be resolved: ${seedResult.error}`,
    });
    onProgress?.({
      step: "summarize_family_viability",
      status: "completed",
      detail:
        "Family deprioritized because the seed paper could not be resolved.",
    });
    const cg = notAttemptedGrounding(
      seed,
      `Seed could not be resolved: ${seedResult.error}`,
    );
    return {
      family: {
        seed,
        resolvedSeedPaper: undefined,
        edges: [],
        resolvedPapers: {},
        duplicateGroups: [],
        metrics: emptyMetrics,
        neighborhoodMetrics: emptyMetrics,
        seedFullTextAcquisition: undefined,
        claimGrounding: cg,
        familyUseProfile: [],
        m2Priority: "not_now",
        decision: "deprioritize",
        decisionReason: `Failed to resolve seed: ${seedResult.error}`,
      },
      traceRecord: {
        seed: { doi: seed.doi, trackedClaim: seed.trackedClaim },
        seedResolutionOk: false,
        seedResolutionError: seedResult.error,
        finalClaimGrounding: cg,
      },
    };
  }

  let seedPaper = seedResult.data;
  paperCache.set(seedPaper.id, seedPaper);
  onProgress?.({
    step: "resolve_seed_paper",
    status: "completed",
    detail: seedPaper.title,
  });

  onProgress?.({
    step: "ground_tracked_claim",
    status: "running",
    detail: "Grounding tracked claim via full-manuscript LLM.",
  });

  const materialized =
    await adapters.seedClaimGrounding.materializeSeedPaper(seedPaper);

  let claimGrounding: ClaimGrounding;
  let traceRecord: PreScreenGroundingTraceRecord;

  if (!materialized.ok) {
    const analystClaim = seed.trackedClaim.trim();
    claimGrounding = {
      status: "materialize_failed",
      analystClaim,
      normalizedClaim: analystClaim,
      supportSpans: [],
      blocksDownstream: true,
      detailReason: `Could not fetch or parse seed full text: ${materialized.error}`,
    };
    traceRecord = {
      seed: { doi: seed.doi, trackedClaim: seed.trackedClaim },
      seedResolutionOk: true,
      resolvedSeedPaperId: seedPaper.id,
      resolvedSeedTitle: seedPaper.title,
      materialization: materialized.acquisition,
      materializationError: materialized.error,
      finalClaimGrounding: claimGrounding,
    };
  } else {
    const llmOpts = {
      apiKey: options.llmGrounding.anthropicApiKey,
      ...(options.llmGrounding.model != null
        ? { model: options.llmGrounding.model }
        : {}),
      ...(options.llmGrounding.useThinking != null
        ? { useThinking: options.llmGrounding.useThinking }
        : {}),
      ...(options.llmGrounding.llmClient != null
        ? { llmClient: options.llmGrounding.llmClient }
        : {}),
      ...(options.llmGrounding.enableExactCache != null
        ? { enableExactCache: options.llmGrounding.enableExactCache }
        : {}),
    };
    const { grounding, llmCall } = await runLlmFullDocumentClaimGrounding({
      seed,
      seedPaper,
      parsedDocument: materialized.data.parsedDocument,
      options: llmOpts,
    });
    claimGrounding = grounding;
    traceRecord = {
      seed: { doi: seed.doi, trackedClaim: seed.trackedClaim },
      seedResolutionOk: true,
      resolvedSeedPaperId: seedPaper.id,
      resolvedSeedTitle: seedPaper.title,
      materialization: materialized.data.acquisition,
      llmCall,
      finalClaimGrounding: claimGrounding,
    };
  }

  onProgress?.({
    step: "ground_tracked_claim",
    status: "completed",
    detail: claimGrounding.detailReason,
  });

  // Early exit: if the claim cannot be grounded, skip the remaining steps
  // and deprioritize immediately — no point hitting OpenAlex or assessing edges.
  if (claimGroundingBlocksAnalysis(claimGrounding)) {
    const skipReason = "Skipped — claim not grounded in seed paper.";
    const skippedSteps = [
      "gather_citing_papers",
      "collapse_duplicates",
      "assess_auditability",
      "filter_claim_family",
      "summarize_family_viability",
    ] as const;
    for (const step of skippedSteps) {
      onProgress?.({ step, status: "skipped", detail: skipReason });
    }

    const { decision, reason } = makeDecision(
      emptyMetrics,
      true,
      options,
      claimGrounding,
    );
    return {
      family: {
        seed,
        resolvedSeedPaper: seedPaper,
        edges: [],
        resolvedPapers: { [seedPaper.id]: seedPaper },
        duplicateGroups: [],
        metrics: emptyMetrics,
        neighborhoodMetrics: emptyMetrics,
        seedFullTextAcquisition: traceRecord.materialization,
        claimGrounding,
        familyUseProfile: [],
        m2Priority: "not_now",
        decision,
        decisionReason: reason,
      },
      traceRecord,
    };
  }

  onProgress?.({
    step: "gather_citing_papers",
    status: "running",
    detail: "Gathering citing papers around the seed.",
  });
  let citingResult = await adapters.getCitingPapers(seedPaper.id);
  let citingPapers = citingResult.ok ? citingResult.data : [];

  if (citingPapers.length === 0 && adapters.findPublishedVersion) {
    const published = await adapters.findPublishedVersion(
      seedPaper.title,
      seedPaper.id,
    );
    if (published.ok) {
      seedPaper = published.data;
      paperCache.set(seedPaper.id, seedPaper);
      citingResult = await adapters.getCitingPapers(seedPaper.id);
      citingPapers = citingResult.ok ? citingResult.data : [];
    }
  }
  onProgress?.({
    step: "gather_citing_papers",
    status: "completed",
    detail: `${String(citingPapers.length)} citing papers gathered`,
  });

  const totalBeforeDedup = citingPapers.length;
  onProgress?.({
    step: "collapse_duplicates",
    status: "running",
    detail: "Collapsing duplicate paper records.",
  });
  const { uniquePapers, duplicateGroups } = deduplicatePapers(citingPapers);
  onProgress?.({
    step: "collapse_duplicates",
    status: "completed",
    detail: `${String(uniquePapers.length)} unique papers after collapsing ${String(duplicateGroups.length)} duplicate groups`,
  });

  const edges: PreScreenEdge[] = [];
  const resolvedPapers: Record<string, ResolvedPaper> = {
    [seedPaper.id]: seedPaper,
  };

  onProgress?.({
    step: "assess_auditability",
    status: "running",
    detail: "Checking auditability and paper types.",
  });
  for (const citing of uniquePapers) {
    paperCache.set(citing.id, citing);
    resolvedPapers[citing.id] = citing;

    const assessment = assessAuditability(citing);
    const classification = classifyEdge(citing);

    edges.push({
      citingPaperId: citing.id,
      citedPaperId: seedPaper.id,
      auditabilityStatus: assessment.status,
      auditabilityReason: assessment.reason,
      classification,
      paperType: citing.paperType,
      referencedWorksCount: citing.referencedWorksCount,
    });
  }

  for (const group of duplicateGroups) {
    for (const collapsedId of group.collapsedFromPaperIds) {
      const collapsedPaper = citingPapers.find((p) => p.id === collapsedId);
      if (collapsedPaper) {
        resolvedPapers[collapsedId] = collapsedPaper;
      }
    }
  }

  const neighborhoodMetrics = computeMetrics(edges, totalBeforeDedup);
  onProgress?.({
    step: "assess_auditability",
    status: "completed",
    detail: `${String(neighborhoodMetrics.auditableStructuredEdges + neighborhoodMetrics.auditablePdfEdges)} auditable edges across ${String(neighborhoodMetrics.uniqueEdges)} unique papers`,
  });

  onProgress?.({
    step: "filter_claim_family",
    status: "running",
    detail: "Scoping citing papers to the grounded claim.",
  });
  if (claimGroundingBlocksAnalysis(claimGrounding)) {
    for (const edge of edges) {
      edge.inClaimFamily = false;
      edge.claimRelevanceScore = 0;
    }
  } else if (options.skipClaimFamilyFilter) {
    // Attribution-first discovery already established citer→claim associations
    // from full-text analysis.  Re-filtering on title/abstract is strictly
    // weaker and drops valid edges.  Include all edges and let downstream
    // extraction/classification handle relevance.
    for (const edge of edges) {
      edge.inClaimFamily = true;
      edge.claimRelevanceScore = 1;
    }
    onProgress?.({
      step: "filter_claim_family",
      status: "completed",
      detail: `Claim-family filter skipped (attribution-first) — all ${String(edges.length)} edges included`,
    });
  } else {
    // Stage 1: BM25 pre-filter (cheap, removes obviously irrelevant papers).
    const claimQuery = buildRetrievalQuery([
      claimGrounding.normalizedClaim,
      seedPaper.title,
    ]);
    annotateClaimFamilyMembership(edges, resolvedPapers, claimQuery);

    // Stage 2: LLM filter on BM25 survivors (Haiku 4.5 + thinking).
    const bm25Survivors = edges.filter((e) => e.inClaimFamily === true);
    if (bm25Survivors.length > 0) {
      const candidates: ClaimFamilyCandidate[] = [];
      for (const edge of bm25Survivors) {
        const paper = resolvedPapers[edge.citingPaperId];
        if (paper) {
          candidates.push({
            citingPaperId: edge.citingPaperId,
            title: paper.title,
            abstract: paper.abstract ?? "",
          });
        }
      }

      onProgress?.({
        step: "filter_claim_family",
        status: "running",
        detail: `LLM filtering ${String(candidates.length)} BM25 survivors.`,
      });

      const llmClient =
        options.llmFilter?.llmClient ??
        createLLMClient({
          apiKey: options.llmGrounding.anthropicApiKey,
        });
      const llmResults = await llmFilterClaimFamily(
        llmClient,
        claimGrounding.normalizedClaim,
        seedPaper.title,
        candidates,
        {
          ...(options.llmFilter?.model != null
            ? { model: options.llmFilter.model }
            : {}),
          ...(options.llmFilter?.concurrency != null
            ? { concurrency: options.llmFilter.concurrency }
            : {}),
        },
      );

      const excluded = new Set(
        llmResults.filter((r) => !r.relevant).map((r) => r.citingPaperId),
      );
      for (const edge of bm25Survivors) {
        if (excluded.has(edge.citingPaperId)) {
          edge.inClaimFamily = false;
        }
      }
    }
  }

  const claimFamilyEdges = edges.filter((edge) => edge.inClaimFamily === true);
  onProgress?.({
    step: "filter_claim_family",
    status: "completed",
    detail: `${String(claimFamilyEdges.length)} of ${String(edges.length)} edges in claim-scoped family`,
  });

  const metrics = mergeClaimFamilyMetrics(
    neighborhoodMetrics,
    claimFamilyEdges,
  );
  const { decision, reason } = makeDecision(
    metrics,
    true,
    options,
    claimGrounding,
  );
  const familyUseProfile = computeFamilyUseProfile(metrics);
  const m2Priority = computeM2Priority(metrics, decision);
  onProgress?.({
    step: "summarize_family_viability",
    status: "running",
    detail: "Summarizing family viability.",
  });
  onProgress?.({
    step: "summarize_family_viability",
    status: "completed",
    detail: reason,
  });

  return {
    family: {
      seed,
      resolvedSeedPaper: seedPaper,
      edges,
      resolvedPapers,
      duplicateGroups,
      metrics,
      neighborhoodMetrics,
      seedFullTextAcquisition: traceRecord.materialization,
      claimGrounding,
      familyUseProfile,
      m2Priority,
      decision,
      decisionReason: reason,
    },
    traceRecord,
  };
}

// --- Global M2 priority ranking: exactly one "first" across all greenlit families ---

function m2Score(r: ClaimFamilyPreScreen): number {
  const auditable =
    r.metrics.auditableStructuredEdges + r.metrics.auditablePdfEdges;
  return auditable * r.metrics.primaryLikeEdgeRate;
}

function assignM2Priorities(results: ClaimFamilyPreScreen[]): void {
  let bestIdx = -1;
  let bestScore = -1;

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.decision !== "greenlight") continue;
    const score = m2Score(r);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.decision === "deprioritize") {
      r.m2Priority = "not_now";
    } else if (i === bestIdx) {
      r.m2Priority = "first";
    } else {
      const auditable =
        r.metrics.auditableStructuredEdges + r.metrics.auditablePdfEdges;
      r.m2Priority = auditable >= 5 ? "later" : "caution";
    }
  }
}

// ---------------------------------------------------------------------------
// Thin screen path — attribution-first handoff
// ---------------------------------------------------------------------------

/**
 * Reconstitute a family's grounding trace from the handoff when we have no
 * familyId (legacy seeds mixed into an attribution-first run). Matches by
 * canonical claim text; returns the first match or undefined.
 */
function findGroundingByTrackedClaim(
  handoff: DiscoveryHandoff,
  trackedClaim: string,
): FamilyGroundingTrace | undefined {
  for (const trace of handoff.groundingByFamilyId.values()) {
    if (trace.canonicalTrackedClaim === trackedClaim) {
      return trace;
    }
  }
  return undefined;
}

/**
 * Process one seed using the in-memory discovery handoff.
 *
 * No network calls, no LLM calls. Reuses:
 *   - Resolved paper from handoff
 *   - Citing-paper list from handoff (up to 200, larger than screen's 50)
 *   - Per-family grounding from handoff
 */
function processOneSeedFromHandoff(
  seed: DiscoverySeedEntry,
  handoffs: DiscoveryHandoffMap,
  options: { minAuditableCoverage: number; minAuditableEdges: number },
  onProgress?: (event: PreScreenProgressEvent) => void,
): {
  family: ClaimFamilyPreScreen;
  traceRecord: PreScreenGroundingTraceRecord;
} {
  const emptyMetrics = computeMetrics([], 0);

  onProgress?.({
    step: "resolve_seed_paper",
    status: "running",
    detail: `Looking up handoff for ${seed.doi}`,
  });

  const handoff = handoffs.get(seed.doi);

  if (!handoff) {
    onProgress?.({
      step: "resolve_seed_paper",
      status: "completed",
      detail: `No discovery handoff for ${seed.doi} — deprioritizing`,
    });
    onProgress?.({
      step: "summarize_family_viability",
      status: "completed",
      detail: "Family deprioritized: no discovery handoff available.",
    });
    const cg: ClaimGrounding = {
      status: "not_attempted",
      analystClaim: seed.trackedClaim,
      normalizedClaim: seed.trackedClaim,
      supportSpans: [],
      blocksDownstream: true,
      detailReason: `No discovery handoff for seed DOI: ${seed.doi}`,
    };
    const { decision, reason } = makeDecision(emptyMetrics, false, options, cg);
    return {
      family: {
        seed,
        resolvedSeedPaper: undefined,
        edges: [],
        resolvedPapers: {},
        duplicateGroups: [],
        metrics: emptyMetrics,
        neighborhoodMetrics: emptyMetrics,
        seedFullTextAcquisition: undefined,
        claimGrounding: cg,
        familyUseProfile: [],
        m2Priority: "not_now",
        decision,
        decisionReason: reason,
      },
      traceRecord: {
        seed: { doi: seed.doi, trackedClaim: seed.trackedClaim },
        seedResolutionOk: false,
        seedResolutionError: `No discovery handoff for DOI: ${seed.doi}`,
        finalClaimGrounding: cg,
      },
    };
  }

  onProgress?.({
    step: "resolve_seed_paper",
    status: "completed",
    detail: handoff.resolvedPaper.title,
  });

  // Reconstitute ClaimGrounding from the family's grounding trace stored in the
  // handoff. Falls back to non-blocking "not_attempted" when grounding info is
  // absent (e.g. seed full text was unavailable during discovery) — the claim
  // was discovered from citing-paper evidence, so we do not block on it.
  const trace: FamilyGroundingTrace | undefined = seed.familyId
    ? handoff.groundingByFamilyId.get(seed.familyId)
    : findGroundingByTrackedClaim(handoff, seed.trackedClaim);

  const claimGrounding: ClaimGrounding = trace
    ? trace.grounding
    : {
        status: "not_attempted",
        analystClaim: seed.trackedClaim,
        normalizedClaim: seed.trackedClaim,
        supportSpans: [],
        blocksDownstream: false,
        detailReason:
          "Grounding trace not found in discovery handoff. Claim was discovered from citing-paper evidence; proceeding without seed grounding.",
      };

  onProgress?.({
    step: "ground_tracked_claim",
    status: "skipped",
    detail: "Reusing discovery grounding (thin screen path).",
  });

  // If grounding explicitly blocks downstream, short-circuit without
  // building edges — same semantics as the full screen path.
  if (claimGroundingBlocksAnalysis(claimGrounding)) {
    const skipReason = "Skipped — claim not grounded in seed paper.";
    for (const step of [
      "gather_citing_papers",
      "collapse_duplicates",
      "assess_auditability",
      "filter_claim_family",
    ] as const) {
      onProgress?.({ step, status: "skipped", detail: skipReason });
    }
    const { decision, reason } = makeDecision(
      emptyMetrics,
      true,
      options,
      claimGrounding,
    );
    onProgress?.({
      step: "summarize_family_viability",
      status: "completed",
      detail: reason,
    });
    return {
      family: {
        seed,
        resolvedSeedPaper: handoff.resolvedPaper,
        edges: [],
        resolvedPapers: { [handoff.resolvedPaper.id]: handoff.resolvedPaper },
        duplicateGroups: [],
        metrics: emptyMetrics,
        neighborhoodMetrics: emptyMetrics,
        seedFullTextAcquisition: undefined,
        claimGrounding,
        familyUseProfile: [],
        m2Priority: "not_now",
        decision,
        decisionReason: reason,
      },
      traceRecord: {
        seed: { doi: seed.doi, trackedClaim: seed.trackedClaim },
        seedResolutionOk: true,
        resolvedSeedPaperId: handoff.resolvedPaper.id,
        resolvedSeedTitle: handoff.resolvedPaper.title,
        finalClaimGrounding: claimGrounding,
      },
    };
  }

  // Use the citing-paper list from the handoff — avoids a second OpenAlex call
  // and covers more of the neighborhood (discovery fetches up to 200 vs screen's 50).
  onProgress?.({
    step: "gather_citing_papers",
    status: "running",
    detail: "Using pre-fetched citing papers from discovery handoff.",
  });
  const citingPapers = handoff.citingPapersRaw;
  const totalBeforeDedup = citingPapers.length;
  onProgress?.({
    step: "gather_citing_papers",
    status: "completed",
    detail: `${String(totalBeforeDedup)} citing papers from discovery handoff`,
  });

  onProgress?.({
    step: "collapse_duplicates",
    status: "running",
    detail: "Collapsing duplicate paper records.",
  });
  const { uniquePapers, duplicateGroups } = deduplicatePapers(citingPapers);
  onProgress?.({
    step: "collapse_duplicates",
    status: "completed",
    detail: `${String(uniquePapers.length)} unique papers after collapsing ${String(duplicateGroups.length)} duplicate groups`,
  });

  const resolvedPapers: Record<string, ResolvedPaper> = {
    [handoff.resolvedPaper.id]: handoff.resolvedPaper,
  };
  const edges: PreScreenEdge[] = [];

  onProgress?.({
    step: "assess_auditability",
    status: "running",
    detail: "Checking auditability and paper types.",
  });
  for (const citing of uniquePapers) {
    resolvedPapers[citing.id] = citing;
    const assessment = assessAuditability(citing);
    const classification = classifyEdge(citing);
    edges.push({
      citingPaperId: citing.id,
      citedPaperId: handoff.resolvedPaper.id,
      auditabilityStatus: assessment.status,
      auditabilityReason: assessment.reason,
      classification,
      paperType: citing.paperType,
      referencedWorksCount: citing.referencedWorksCount,
      // Attribution-first: citer→claim associations were established from
      // full-text analysis during discovery. All citing papers are in the
      // claim family; skip BM25+LLM filter.
      inClaimFamily: true,
      claimRelevanceScore: 1,
    });
  }

  for (const group of duplicateGroups) {
    for (const collapsedId of group.collapsedFromPaperIds) {
      const collapsedPaper = citingPapers.find((p) => p.id === collapsedId);
      if (collapsedPaper) {
        resolvedPapers[collapsedId] = collapsedPaper;
      }
    }
  }

  const neighborhoodMetrics = computeMetrics(edges, totalBeforeDedup);
  onProgress?.({
    step: "assess_auditability",
    status: "completed",
    detail: `${String(neighborhoodMetrics.auditableStructuredEdges + neighborhoodMetrics.auditablePdfEdges)} auditable edges across ${String(neighborhoodMetrics.uniqueEdges)} unique papers`,
  });

  onProgress?.({
    step: "filter_claim_family",
    status: "skipped",
    detail: `Claim-family filter skipped (attribution-first) — all ${String(edges.length)} edges included`,
  });

  const claimFamilyEdges = edges;
  const metrics = mergeClaimFamilyMetrics(
    neighborhoodMetrics,
    claimFamilyEdges,
  );
  const { decision, reason } = makeDecision(
    metrics,
    true,
    options,
    claimGrounding,
  );
  const familyUseProfile = computeFamilyUseProfile(metrics);
  const m2Priority = computeM2Priority(metrics, decision);

  onProgress?.({
    step: "summarize_family_viability",
    status: "running",
    detail: "Summarizing family viability.",
  });
  onProgress?.({
    step: "summarize_family_viability",
    status: "completed",
    detail: reason,
  });

  return {
    family: {
      seed,
      resolvedSeedPaper: handoff.resolvedPaper,
      edges,
      resolvedPapers,
      duplicateGroups,
      metrics,
      neighborhoodMetrics,
      seedFullTextAcquisition: undefined,
      claimGrounding,
      familyUseProfile,
      m2Priority,
      decision,
      decisionReason: reason,
    },
    traceRecord: {
      seed: { doi: seed.doi, trackedClaim: seed.trackedClaim },
      seedResolutionOk: true,
      resolvedSeedPaperId: handoff.resolvedPaper.id,
      resolvedSeedTitle: handoff.resolvedPaper.title,
      // No LLM call in the thin screen path.
      finalClaimGrounding: claimGrounding,
    },
  };
}

// --- Main entry point ---

export async function runPreScreen(
  seeds: SeedPaperInput[],
  adapters: PreScreenAdapters,
  options: Partial<PreScreenOptions> = {},
  onProgress?: (event: PreScreenProgressEvent) => void,
): Promise<PreScreenRunResult> {
  const apiKey = options.llmGrounding?.anthropicApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "runPreScreen requires options.llmGrounding.anthropicApiKey (non-empty).",
    );
  }
  const mergedOptions: PreScreenOptions = {
    minAuditableCoverage:
      options.minAuditableCoverage ??
      DEFAULT_NUMERIC_OPTIONS.minAuditableCoverage,
    minAuditableEdges:
      options.minAuditableEdges ?? DEFAULT_NUMERIC_OPTIONS.minAuditableEdges,
    llmGrounding: {
      anthropicApiKey: apiKey,
      ...(options.llmGrounding?.model != null
        ? { model: options.llmGrounding.model }
        : {}),
      ...(options.llmGrounding?.useThinking != null
        ? { useThinking: options.llmGrounding.useThinking }
        : {}),
      ...(options.llmGrounding?.llmClient != null
        ? { llmClient: options.llmGrounding.llmClient }
        : {}),
      ...(options.llmGrounding?.enableExactCache != null
        ? { enableExactCache: options.llmGrounding.enableExactCache }
        : {}),
    },
    ...(options.llmFilter != null ? { llmFilter: options.llmFilter } : {}),
    ...(options.seedConcurrency != null
      ? { seedConcurrency: options.seedConcurrency }
      : {}),
    ...(options.skipClaimFamilyFilter != null
      ? { skipClaimFamilyFilter: options.skipClaimFamilyFilter }
      : {}),
  };
  const paperCache = new Map<string, ResolvedPaper>();
  const concurrency = mergedOptions.seedConcurrency ?? 3;

  const seedResults = await pMap(
    seeds,
    async (seed) =>
      processOneSeed(seed, adapters, paperCache, mergedOptions, onProgress),
    { concurrency },
  );

  const results: ClaimFamilyPreScreen[] = [];
  const records: PreScreenGroundingTraceFile["records"] = [];
  for (const { family, traceRecord } of seedResults) {
    results.push(family);
    records.push({
      seedDoiKey: normalizeSeedDoiForTraceKey(family.seed.doi),
      record: traceRecord,
    });
  }

  assignM2Priorities(results);

  return {
    families: results,
    groundingTrace: {
      artifactKind: "pre-screen-grounding-trace",
      schemaVersion: PRE_SCREEN_GROUNDING_TRACE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      records,
    },
  };
}

// ---------------------------------------------------------------------------
// Thin screen entry point — attribution-first handoff
// ---------------------------------------------------------------------------

/**
 * Pre-screen using in-memory discovery handoffs from an attribution-first run.
 *
 * Eliminates the three most expensive screen operations:
 *   - DOI resolution (paper already resolved during discovery)
 *   - OpenAlex citing-paper fetch (handoff carries up to 200 papers)
 *   - LLM claim grounding (grounding ran during discovery; reused here)
 *
 * All auditability assessment, decision logic, and M2 prioritisation run
 * exactly as in the full screen path. The claim-family filter is skipped:
 * attribution-first discovery already established citer→claim associations
 * via full-text analysis.
 */
export function runPreScreenFromHandoff(
  seeds: DiscoverySeedEntry[],
  handoffs: DiscoveryHandoffMap,
  options: { minAuditableCoverage?: number; minAuditableEdges?: number },
  onProgress?: (event: PreScreenProgressEvent) => void,
): Promise<PreScreenRunResult> {
  const resolvedOptions = {
    minAuditableCoverage:
      options.minAuditableCoverage ??
      DEFAULT_NUMERIC_OPTIONS.minAuditableCoverage,
    minAuditableEdges:
      options.minAuditableEdges ?? DEFAULT_NUMERIC_OPTIONS.minAuditableEdges,
  };

  const results: ClaimFamilyPreScreen[] = [];
  const records: PreScreenGroundingTraceFile["records"] = [];

  for (const seed of seeds) {
    const { family, traceRecord } = processOneSeedFromHandoff(
      seed,
      handoffs,
      resolvedOptions,
      onProgress,
    );
    results.push(family);
    records.push({
      seedDoiKey: normalizeSeedDoiForTraceKey(seed.doi),
      record: traceRecord,
    });
  }

  assignM2Priorities(results);

  return Promise.resolve({
    families: results,
    groundingTrace: {
      artifactKind: "pre-screen-grounding-trace",
      schemaVersion: PRE_SCREEN_GROUNDING_TRACE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      records,
    },
  });
}
