import { isAuditableForPreScreen } from "../domain/auditability.js";
import type {
  ClaimFamilyPreScreen,
  EdgeExtractionResult,
  ExtractionOutcome,
  ExtractionSummary,
  FamilyExtractionResult,
} from "../domain/types.js";
import {
  extractEdgeContext,
  type ExtractionAdapters,
} from "../retrieval/citation-context.js";

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
): Promise<FamilyExtractionResult> {
  const seedPaper = family.resolvedSeedPaper;

  if (!seedPaper) {
    return {
      seed: family.seed,
      resolvedSeedPaper: undefined as never,
      edgeResults: [],
      summary: emptySummary(),
    };
  }

  const edgeResults: EdgeExtractionResult[] = [];
  let attemptCount = 0;

  for (const edge of family.edges) {
    const citingPaper = family.resolvedPapers[edge.citingPaperId];

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
    console.info(
      `  [${String(attemptCount)}] ${citingPaper.title.substring(0, 70)}...`,
    );

    const result = await extractEdgeContext(
      edge,
      citingPaper,
      seedPaper,
      adapters,
    );
    edgeResults.push(result);
  }

  return {
    seed: family.seed,
    resolvedSeedPaper: seedPaper,
    edgeResults,
    summary: computeSummary(family.edges.length, edgeResults),
  };
}
