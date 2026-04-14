import { isAuditableForPreScreen } from "../domain/auditability.js";
import {
  claimFamilyBlocksDownstream,
  type ClaimFamilyPreScreen,
  type EdgeExtractionResult,
  type ExtractionOutcome,
  type ExtractionSummary,
  type FamilyExtractionResult,
  type PreScreenEdge,
} from "../domain/types.js";
import {
  extractEdgeContext,
  extractEdgeContextFromMentions,
  type ExtractionAdapters,
} from "../retrieval/citation-context.js";

export type M2ExtractionProgressEvent = {
  step:
    | "select_auditable_papers"
    | "fetch_and_parse_full_text"
    | "locate_citation_mentions"
    | "deduplicate_and_filter_mentions"
    | "summarize_grounding_contexts";
  status: "running" | "completed";
  detail?: string;
  current?: number;
  total?: number;
};

function emptySummary(): ExtractionSummary {
  return {
    totalEdges: 0,
    attemptedEdges: 0,
    successfulEdgesRaw: 0,
    successfulEdgesUsable: 0,
    rawMentionCount: 0,
    deduplicatedMentionCount: 0,
    usableMentionCount: 0,
    failureCountsByOutcome: {},
  };
}

function computeSummary(
  totalEdges: number,
  edgeResults: EdgeExtractionResult[],
): ExtractionSummary {
  let attempted = 0;
  let successRaw = 0;
  let successUsable = 0;
  let rawMentions = 0;
  let dedupedMentions = 0;
  let usableMentions = 0;
  const failures: Partial<Record<ExtractionOutcome, number>> = {};

  for (const e of edgeResults) {
    if (e.extractionOutcome !== "skipped_not_auditable") attempted++;

    if (e.extractionSuccess) {
      successRaw++;
      if (e.usableForGrounding === true) successUsable++;
    } else {
      const count = failures[e.extractionOutcome] ?? 0;
      failures[e.extractionOutcome] = count + 1;
    }

    rawMentions += e.rawMentionCount;
    dedupedMentions += e.deduplicatedMentionCount;

    if (e.usableForGrounding === true) {
      usableMentions += e.mentions.filter(
        (m) => m.contextType === "narrative_like" && m.confidence !== "low",
      ).length;
    }
  }

  return {
    totalEdges,
    attemptedEdges: attempted,
    successfulEdgesRaw: successRaw,
    successfulEdgesUsable: successUsable,
    rawMentionCount: rawMentions,
    deduplicatedMentionCount: dedupedMentions,
    usableMentionCount: usableMentions,
    failureCountsByOutcome: failures,
  };
}

export async function runM2Extraction(
  family: ClaimFamilyPreScreen,
  adapters: ExtractionAdapters,
  onProgress?: (event: M2ExtractionProgressEvent) => void,
): Promise<FamilyExtractionResult> {
  const seedPaper = family.resolvedSeedPaper;

  if (!seedPaper) {
    return {
      seed: family.seed,
      resolvedSeedPaper: undefined as never,
      groundedSeedClaimText: undefined,
      edgeResults: [],
      summary: emptySummary(),
    };
  }

  function edgeExcludedByClaimGate(edge: PreScreenEdge): boolean {
    if (claimFamilyBlocksDownstream(family)) {
      return true;
    }
    return edge.inClaimFamily === false;
  }

  const auditableEdges = family.edges.filter((edge) => {
    if (edgeExcludedByClaimGate(edge)) {
      return false;
    }
    const citingPaper = family.resolvedPapers[edge.citingPaperId];
    return citingPaper && isAuditableForPreScreen(edge.auditabilityStatus);
  });
  onProgress?.({
    step: "select_auditable_papers",
    status: "running",
    detail: "Selecting citing papers with enough accessible full text.",
  });
  onProgress?.({
    step: "select_auditable_papers",
    status: "completed",
    detail: `${String(auditableEdges.length)} auditable papers selected from ${String(family.edges.length)} edges`,
  });

  const edgeResults: EdgeExtractionResult[] = [];
  let attemptCount = 0;
  onProgress?.({
    step: "fetch_and_parse_full_text",
    status: "running",
    detail: `${String(auditableEdges.length)} auditable citing papers to process`,
    ...(auditableEdges.length > 0
      ? { current: 0, total: auditableEdges.length }
      : {}),
  });

  for (const edge of family.edges) {
    const citingPaper = family.resolvedPapers[edge.citingPaperId];

    if (edgeExcludedByClaimGate(edge)) {
      edgeResults.push({
        citingPaperId: edge.citingPaperId,
        citedPaperId: edge.citedPaperId,
        citingPaperTitle: citingPaper?.title ?? edge.citingPaperId,
        sourceType: "not_attempted",
        extractionOutcome: "skipped_not_auditable",
        extractionSuccess: false,
        usableForGrounding: false,
        rawMentionCount: 0,
        deduplicatedMentionCount: 0,
        mentions: [],
        failureReason: claimFamilyBlocksDownstream(family)
          ? "Claim not grounded in seed paper — pre-screen blocked downstream stages"
          : "Outside claim-scoped citing family from pre-screen",
      });
      continue;
    }

    if (!citingPaper || !isAuditableForPreScreen(edge.auditabilityStatus)) {
      edgeResults.push({
        citingPaperId: edge.citingPaperId,
        citedPaperId: edge.citedPaperId,
        citingPaperTitle: citingPaper?.title ?? edge.citingPaperId,
        sourceType: "not_attempted",
        extractionOutcome: "skipped_not_auditable",
        extractionSuccess: false,
        usableForGrounding: false,
        rawMentionCount: 0,
        deduplicatedMentionCount: 0,
        mentions: [],
        failureReason: "Not auditable — skipped",
      });
      continue;
    }

    attemptCount++;
    onProgress?.({
      step: "fetch_and_parse_full_text",
      status: "running",
      detail: citingPaper.title.substring(0, 96),
      current: attemptCount,
      total: auditableEdges.length,
    });
    console.info(
      `  [${String(attemptCount)}] ${citingPaper.title.substring(0, 70)}...`,
    );

    const preHarvested = adapters.preHarvestedMentions?.get(edge.citingPaperId);
    const result =
      preHarvested !== undefined
        ? extractEdgeContextFromMentions(edge, citingPaper, preHarvested)
        : await extractEdgeContext(edge, citingPaper, seedPaper, adapters);
    edgeResults.push(result);
  }

  if (auditableEdges.length > 0) {
    onProgress?.({
      step: "fetch_and_parse_full_text",
      status: "completed",
      detail: `${String(auditableEdges.length)} auditable citing papers processed`,
      current: auditableEdges.length,
      total: auditableEdges.length,
    });
  }

  const summary = computeSummary(family.edges.length, edgeResults);
  onProgress?.({
    step: "locate_citation_mentions",
    status: "running",
    detail: "Locating citation mentions that point to the seed paper.",
  });
  onProgress?.({
    step: "locate_citation_mentions",
    status: "completed",
    detail: `${String(summary.rawMentionCount)} raw mentions located across ${String(summary.successfulEdgesRaw)} extracted edges`,
  });
  onProgress?.({
    step: "deduplicate_and_filter_mentions",
    status: "running",
    detail:
      "Deduplicating repeated mentions and filtering for grounding quality.",
  });
  onProgress?.({
    step: "deduplicate_and_filter_mentions",
    status: "completed",
    detail: `${String(summary.deduplicatedMentionCount)} deduplicated mentions, ${String(summary.usableMentionCount)} usable for grounding`,
  });
  onProgress?.({
    step: "summarize_grounding_contexts",
    status: "running",
    detail: "Summarizing usable grounding contexts.",
  });
  onProgress?.({
    step: "summarize_grounding_contexts",
    status: "completed",
    detail: `${String(summary.successfulEdgesUsable)} usable edges with ${String(summary.usableMentionCount)} usable mentions`,
  });

  const cg = family.claimGrounding;
  const groundedSeedClaimText =
    cg &&
    !claimFamilyBlocksDownstream(family) &&
    (cg.status === "grounded" || cg.status === "ambiguous")
      ? cg.normalizedClaim
      : undefined;

  return {
    seed: family.seed,
    resolvedSeedPaper: seedPaper,
    groundedSeedClaimText,
    edgeResults,
    summary,
  };
}
