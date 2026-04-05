import { classifyEdge } from "../domain/attribution-signal.js";
import { assessAuditability } from "../domain/auditability.js";
import type {
  ClaimFamilyPreScreen,
  FamilyUseProfileTag,
  M2Priority,
  PreScreenEdge,
  PreScreenMetrics,
  ResolvedPaper,
  Result,
  SeedPaperInput,
} from "../domain/types.js";
import { deduplicatePapers } from "./dedup.js";

// --- Adapter interface for dependency injection ---

export type PreScreenAdapters = {
  resolveByDoi: (doi: string) => Promise<Result<ResolvedPaper>>;
  getCitingPapers: (openAlexId: string) => Promise<Result<ResolvedPaper[]>>;
  findPublishedVersion?: (
    title: string,
    excludeId: string,
  ) => Promise<Result<ResolvedPaper>>;
};

export type PreScreenOptions = {
  minAuditableCoverage: number;
  minAuditableEdges: number;
};

export type PreScreenProgressEvent = {
  step:
    | "resolve_seed_paper"
    | "gather_citing_papers"
    | "collapse_duplicates"
    | "assess_auditability"
    | "summarize_family_viability";
  status: "running" | "completed";
  detail?: string;
  current?: number;
  total?: number;
};

const DEFAULT_OPTIONS: PreScreenOptions = {
  minAuditableCoverage: 0.3,
  minAuditableEdges: 3,
};

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
  options: PreScreenOptions,
): { decision: ClaimFamilyPreScreen["decision"]; reason: string } {
  if (!seedResolved) {
    return {
      decision: "deprioritize",
      reason: "Seed paper could not be resolved",
    };
  }

  if (metrics.uniqueEdges === 0) {
    return { decision: "deprioritize", reason: "No citing papers found" };
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
): Promise<ClaimFamilyPreScreen> {
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
      detail: "Family deprioritized because the seed paper could not be resolved.",
    });
    return {
      seed,
      resolvedSeedPaper: undefined,
      edges: [],
      resolvedPapers: {},
      duplicateGroups: [],
      metrics: emptyMetrics,
      familyUseProfile: [],
      m2Priority: "not_now",
      decision: "deprioritize",
      decisionReason: `Failed to resolve seed: ${seedResult.error}`,
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

  const metrics = computeMetrics(edges, totalBeforeDedup);
  onProgress?.({
    step: "assess_auditability",
    status: "completed",
    detail: `${String(metrics.auditableStructuredEdges + metrics.auditablePdfEdges)} auditable edges across ${String(metrics.uniqueEdges)} unique papers`,
  });
  const { decision, reason } = makeDecision(metrics, true, options);
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
    seed,
    resolvedSeedPaper: seedPaper,
    edges,
    resolvedPapers,
    duplicateGroups,
    metrics,
    familyUseProfile,
    m2Priority,
    decision,
    decisionReason: reason,
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

// --- Main entry point ---

export async function runPreScreen(
  seeds: SeedPaperInput[],
  adapters: PreScreenAdapters,
  options: Partial<PreScreenOptions> = {},
  onProgress?: (event: PreScreenProgressEvent) => void,
): Promise<ClaimFamilyPreScreen[]> {
  const mergedOptions: PreScreenOptions = { ...DEFAULT_OPTIONS, ...options };
  const paperCache = new Map<string, ResolvedPaper>();

  const results: ClaimFamilyPreScreen[] = [];
  for (const seed of seeds) {
    results.push(
      await processOneSeed(seed, adapters, paperCache, mergedOptions, onProgress),
    );
  }

  assignM2Priorities(results);

  return results;
}
