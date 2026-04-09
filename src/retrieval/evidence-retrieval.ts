import { randomUUID } from "node:crypto";

import type {
  CitedPaperSource,
  EdgeWithEvidence,
  EvaluationMode,
  EvaluationTask,
  EvidenceSpan,
  FamilyClassificationResult,
  FamilyEvidenceResult,
  ParsedPaperBlock,
  ParsedPaperDocument,
  TaskEvidenceRetrievalStatus,
  TaskWithEvidence,
} from "../domain/types.js";
import { getRubric } from "../classification/rubrics.js";
import { buildRetrievalQuery, rankDocumentsByBm25 } from "./bm25.js";
import type { LocalReranker } from "./local-reranker.js";
import type { LLMClient } from "../integrations/llm-client.js";
import { llmRerankBlocks } from "./llm-reranker.js";
import type { LLMRerankerOptions } from "./llm-reranker.js";
import { extractCitingWindow } from "../shared/citation-context-window.js";
import { pMap } from "../shared/p-map.js";

export type EvidenceRetrievalAdapters = {
  reranker?: LocalReranker;
  llmClient?: LLMClient;
  llmRerankerOptions?: LLMRerankerOptions;
  /** Max concurrent evidence retrieval tasks. Default 8. */
  concurrency?: number;
};

type RankedBlock = {
  block: ParsedPaperBlock;
  bm25Score: number;
  rerankScore?: number;
  matchMethod: EvidenceSpan["matchMethod"];
  relevanceScore: number;
};

function buildTaskQuery(
  task: EvaluationTask,
  citedPaperSource: CitedPaperSource,
  seedClaimBoost: string | undefined,
): string {
  const queryParts = [
    ...task.mentions.map((mention) => mention.rawContext),
    ...task.mentions.map((mention) => mention.citationMarker),
  ];

  const resolvedPaper = citedPaperSource.resolvedPaper;
  if (resolvedPaper?.title) {
    queryParts.push(resolvedPaper.title);
  }

  const boost = seedClaimBoost?.trim() || undefined;
  if (boost) {
    queryParts.push(boost);
  }

  return buildRetrievalQuery(queryParts);
}

async function rerankBlocksLocal(
  query: string,
  rankedBlocks: RankedBlock[],
  reranker: LocalReranker | undefined,
): Promise<RankedBlock[]> {
  if (!reranker || rankedBlocks.length === 0) {
    return rankedBlocks.slice(0, 5);
  }

  const rerankResult = await reranker.rerank(
    query,
    rankedBlocks.map((rankedBlock) => ({
      id: rankedBlock.block.blockId,
      text: rankedBlock.block.text,
    })),
    5,
  );

  if (!rerankResult.ok) {
    return rankedBlocks.slice(0, 5);
  }

  const byId = new Map<string, RankedBlock>();
  for (const rankedBlock of rankedBlocks) {
    byId.set(rankedBlock.block.blockId, rankedBlock);
  }

  const reranked: RankedBlock[] = [];
  for (const result of rerankResult.data.results) {
    const rankedBlock = byId.get(result.id);
    if (!rankedBlock) {
      continue;
    }

    reranked.push({
      ...rankedBlock,
      rerankScore: result.score,
      matchMethod: "bm25_reranked",
      relevanceScore: result.score,
    });
  }

  reranked.sort((left, right) => {
    const leftScore = left.rerankScore ?? 0;
    const rightScore = right.rerankScore ?? 0;
    if (leftScore === rightScore) {
      return right.bm25Score - left.bm25Score;
    }
    return rightScore - leftScore;
  });

  return reranked;
}

/**
 * LLM-based semantic reranking with sentence extraction.
 *
 * - Sends a focused citing-context window (sentences around the marker)
 *   instead of the full rawContext, so the seed claim doesn't dominate.
 * - Passes the evaluationMode so the LLM knows whether to look for methods,
 *   findings, background, etc.
 * - Preserves the BM25 #1 span as a floor: if the LLM drops a high-scoring
 *   BM25 hit, it's kept as a fallback (hybrid strategy).
 *
 * Falls back to local reranker or BM25 top-5 if the LLM call fails.
 */
async function rerankBlocksLLM(
  task: EvaluationTask,
  rankedBlocks: RankedBlock[],
  llmClient: LLMClient,
  llmOptions: LLMRerankerOptions | undefined,
  seedClaimBoost: string | undefined,
  localReranker: LocalReranker | undefined,
  query: string,
): Promise<RankedBlock[]> {
  if (rankedBlocks.length === 0) {
    return [];
  }

  const bestMention = task.mentions[0];
  const rawContext = bestMention?.rawContext ?? "";
  const marker = bestMention?.citationMarker ?? "";

  // Tight window around the citation marker — not the full paragraph.
  const citingContext = extractCitingWindow(rawContext, marker);
  const claimSummary =
    seedClaimBoost ?? rawContext ?? "citation fidelity check";

  const result = await llmRerankBlocks(
    llmClient,
    {
      citingContext,
      claimSummary,
      evaluationMode: task.evaluationMode,
      candidates: rankedBlocks.map((rb) => ({
        blockId: rb.block.blockId,
        text: rb.block.text,
        sectionTitle: rb.block.sectionTitle,
      })),
    },
    llmOptions,
  );

  if (!result.ok) {
    return rerankBlocksLocal(query, rankedBlocks, localReranker);
  }

  const byId = new Map<string, RankedBlock>();
  for (const rb of rankedBlocks) {
    byId.set(rb.block.blockId, rb);
  }

  const reranked: RankedBlock[] = [];
  const llmBlockIds = new Set<string>();

  for (const item of result.data.results) {
    const rb = byId.get(item.blockId);
    if (!rb) continue;

    llmBlockIds.add(item.blockId);
    reranked.push({
      ...rb,
      block: { ...rb.block, text: item.extractedSentences },
      rerankScore: item.relevanceScore,
      matchMethod: "llm_reranked",
      relevanceScore: item.relevanceScore,
    });
  }

  // Hybrid: if the BM25 #1 span was dropped by the LLM, keep it as a
  // fallback so that lexical-match wins (like exact method names) aren't lost.
  const bm25Top = rankedBlocks[0];
  if (bm25Top && !llmBlockIds.has(bm25Top.block.blockId)) {
    reranked.push(bm25Top);
  }

  return reranked;
}

function toEvidenceSpan(rankedBlock: RankedBlock): EvidenceSpan {
  const span: EvidenceSpan = {
    spanId: randomUUID(),
    text: rankedBlock.block.text.substring(0, 600),
    sectionTitle: rankedBlock.block.sectionTitle,
    blockKind: rankedBlock.block.blockKind,
    matchMethod: rankedBlock.matchMethod,
    relevanceScore: rankedBlock.relevanceScore,
    bm25Score: rankedBlock.bm25Score,
    charOffsetStart: rankedBlock.block.charOffsetStart,
    charOffsetEnd: rankedBlock.block.charOffsetEnd,
  };

  if (rankedBlock.rerankScore != null) {
    span.rerankScore = rankedBlock.rerankScore;
  }

  return span;
}

function isNotAttemptedMode(task: EvaluationTask): boolean {
  return (
    task.evaluationMode === "skip_low_information" ||
    task.evaluationMode === "manual_review_extraction_limited"
  );
}

async function retrieveForTask(
  task: EvaluationTask,
  citedPaperSource: CitedPaperSource,
  blocks: ParsedPaperBlock[],
  adapters: EvidenceRetrievalAdapters,
  seedClaimBoost: string | undefined,
): Promise<TaskWithEvidence> {
  const rubric = getRubric(task.evaluationMode);

  if (isNotAttemptedMode(task)) {
    return {
      ...task,
      rubricQuestion: rubric.question,
      citedPaperEvidenceSpans: [],
      evidenceRetrievalStatus: "not_attempted",
    };
  }

  const query = buildTaskQuery(task, citedPaperSource, seedClaimBoost);
  const bm25Ranked = rankDocumentsByBm25(
    query,
    blocks,
    (block) => block.text,
    20,
  ).map((rankedDocument) => ({
    block: rankedDocument.document,
    bm25Score: rankedDocument.score,
    matchMethod: "bm25" as const,
    relevanceScore: rankedDocument.score,
  }));

  if (bm25Ranked.length === 0) {
    return {
      ...task,
      rubricQuestion: rubric.question,
      citedPaperEvidenceSpans: [],
      evidenceRetrievalStatus: "no_matches",
    };
  }

  if (
    bm25Ranked.every(
      (rankedBlock) => rankedBlock.block.blockKind === "abstract",
    )
  ) {
    return {
      ...task,
      rubricQuestion: rubric.question,
      citedPaperEvidenceSpans: [],
      evidenceRetrievalStatus: "abstract_only_matches",
    };
  }

  // Use LLM reranker when available, else fall back to local reranker / BM25.
  const reranked = adapters.llmClient
    ? await rerankBlocksLLM(
        task,
        bm25Ranked,
        adapters.llmClient,
        adapters.llmRerankerOptions,
        seedClaimBoost,
        adapters.reranker,
        query,
      )
    : await rerankBlocksLocal(query, bm25Ranked, adapters.reranker);

  const spans = reranked.slice(0, adapters.llmRerankerOptions?.topN ?? 5).map(toEvidenceSpan);

  return {
    ...task,
    rubricQuestion: rubric.question,
    citedPaperEvidenceSpans: spans,
    evidenceRetrievalStatus: spans.length > 0 ? "retrieved" : "no_matches",
  };
}

export async function retrieveEvidence(
  classification: FamilyClassificationResult,
  citedPaperSource: CitedPaperSource,
  parsedDocument: ParsedPaperDocument | undefined,
  adapters: EvidenceRetrievalAdapters = {},
): Promise<FamilyEvidenceResult> {
  const seedClaimBoost =
    classification.groundedSeedClaimText?.trim() ||
    classification.seed.trackedClaim.trim();

  const blocks = parsedDocument?.blocks ?? [];
  const hasFullText = blocks.length > 0;

  // Flatten all tasks across packets so we can run them through pMap.
  type FlatTask = { packetIndex: number; task: EvaluationTask };
  const flatTasks: FlatTask[] = [];
  for (let pi = 0; pi < classification.packets.length; pi++) {
    for (const task of classification.packets[pi]!.tasks) {
      flatTasks.push({ packetIndex: pi, task });
    }
  }

  // Resolve each task — skip modes and missing-fulltext are handled inline
  // (no LLM call needed), so concurrency only matters for actual retrieval.
  const concurrency = adapters.concurrency ?? 8;

  const resolvedTasks = await pMap(
    flatTasks,
    async ({ task }) => {
      if (isNotAttemptedMode(task)) {
        return retrieveForTask(task, citedPaperSource, blocks, adapters, seedClaimBoost);
      }

      let status: TaskEvidenceRetrievalStatus | undefined;
      if (citedPaperSource.resolutionStatus !== "resolved") {
        status = "unresolved_cited_paper";
      } else if (!hasFullText) {
        status = "no_fulltext";
      }

      if (status) {
        return {
          ...task,
          rubricQuestion: getRubric(task.evaluationMode).question,
          citedPaperEvidenceSpans: [],
          evidenceRetrievalStatus: status,
        } satisfies TaskWithEvidence;
      }

      return retrieveForTask(task, citedPaperSource, blocks, adapters, seedClaimBoost);
    },
    { concurrency },
  );

  // Reassemble into per-packet edges and accumulate summary counters.
  const tasksByPacket = new Map<number, TaskWithEvidence[]>();
  const tasksByMode: Partial<Record<EvaluationMode, number>> = {};
  let tasksWithEvidence = 0;
  let tasksNoMatches = 0;
  let tasksAbstractOnlyMatches = 0;
  let tasksNoFulltext = 0;
  let tasksUnresolvedCitedPaper = 0;
  let tasksNotAttempted = 0;
  let totalSpans = 0;

  for (let i = 0; i < resolvedTasks.length; i++) {
    const result = resolvedTasks[i]!;
    const { packetIndex, task } = flatTasks[i]!;

    tasksByMode[task.evaluationMode] =
      (tasksByMode[task.evaluationMode] ?? 0) + 1;

    if (!tasksByPacket.has(packetIndex)) {
      tasksByPacket.set(packetIndex, []);
    }
    tasksByPacket.get(packetIndex)!.push(result);

    switch (result.evidenceRetrievalStatus) {
      case "retrieved":
        tasksWithEvidence++;
        totalSpans += result.citedPaperEvidenceSpans.length;
        break;
      case "no_matches":
        tasksNoMatches++;
        break;
      case "abstract_only_matches":
        tasksAbstractOnlyMatches++;
        break;
      case "no_fulltext":
        tasksNoFulltext++;
        break;
      case "unresolved_cited_paper":
        tasksUnresolvedCitedPaper++;
        break;
      case "not_attempted":
        tasksNotAttempted++;
        break;
    }
  }

  const edges: EdgeWithEvidence[] = [];
  for (let pi = 0; pi < classification.packets.length; pi++) {
    const packet = classification.packets[pi]!;
    const tasks = tasksByPacket.get(pi);
    if (!tasks || tasks.length === 0) continue;

    edges.push({
      packetId: packet.packetId,
      citingPaperTitle: packet.citingPaper.title,
      citedPaperTitle: packet.citedPaper.title,
      extractionState: packet.extractionState,
      extractionOutcome: packet.extractionOutcome,
      isReviewMediated: packet.isReviewMediated,
      tasks,
    });
  }

  return {
    seed: classification.seed,
    resolvedSeedPaperTitle: classification.resolvedSeedPaperTitle,
    studyMode: classification.studyMode,
    groundedSeedClaimText: classification.groundedSeedClaimText,
    citedPaperFullTextAvailable: hasFullText,
    citedPaperSource,
    edges,
    summary: {
      totalTasks: flatTasks.length,
      tasksWithEvidence,
      tasksNoFulltext,
      tasksUnresolvedCitedPaper,
      tasksNoMatches,
      tasksAbstractOnlyMatches,
      tasksNotAttempted,
      totalEvidenceSpans: totalSpans,
      tasksByMode,
    },
  };
}
