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

export type EvidenceRetrievalAdapters = {
  reranker?: LocalReranker;
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
): string {
  const queryParts = [
    ...task.mentions.map((mention) => mention.rawContext),
    ...task.mentions.map((mention) => mention.citationMarker),
  ];

  const resolvedPaper = citedPaperSource.resolvedPaper;
  if (resolvedPaper?.title) {
    queryParts.push(resolvedPaper.title);
  }

  return buildRetrievalQuery(queryParts);
}

async function rerankBlocks(
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
  reranker: LocalReranker | undefined,
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

  const query = buildTaskQuery(task, citedPaperSource);
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

  const reranked = await rerankBlocks(query, bm25Ranked, reranker);
  const spans = reranked.slice(0, 5).map(toEvidenceSpan);

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
  const blocks = parsedDocument?.blocks ?? [];
  const hasFullText = blocks.length > 0;

  const edges: EdgeWithEvidence[] = [];
  let totalTasks = 0;
  let tasksWithEvidence = 0;
  let tasksNoMatches = 0;
  let tasksAbstractOnlyMatches = 0;
  let tasksNoFulltext = 0;
  let tasksUnresolvedCitedPaper = 0;
  let tasksNotAttempted = 0;
  let totalSpans = 0;
  const tasksByMode: Partial<Record<EvaluationMode, number>> = {};

  for (const packet of classification.packets) {
    if (packet.tasks.length === 0) {
      continue;
    }

    const tasksWithEvidenceForPacket: TaskWithEvidence[] = [];

    for (const task of packet.tasks) {
      totalTasks++;
      tasksByMode[task.evaluationMode] =
        (tasksByMode[task.evaluationMode] ?? 0) + 1;

      if (isNotAttemptedMode(task)) {
        const result = await retrieveForTask(
          task,
          citedPaperSource,
          blocks,
          adapters.reranker,
        );
        tasksWithEvidenceForPacket.push(result);
        tasksNotAttempted++;
        continue;
      }

      let status: TaskEvidenceRetrievalStatus | undefined;
      if (citedPaperSource.resolutionStatus !== "resolved") {
        status = "unresolved_cited_paper";
      } else if (!hasFullText) {
        status = "no_fulltext";
      }

      if (status) {
        tasksWithEvidenceForPacket.push({
          ...task,
          rubricQuestion: getRubric(task.evaluationMode).question,
          citedPaperEvidenceSpans: [],
          evidenceRetrievalStatus: status,
        });
        if (status === "no_fulltext") {
          tasksNoFulltext++;
        } else {
          tasksUnresolvedCitedPaper++;
        }
        continue;
      }

      const result = await retrieveForTask(
        task,
        citedPaperSource,
        blocks,
        adapters.reranker,
      );
      tasksWithEvidenceForPacket.push(result);

      if (result.evidenceRetrievalStatus === "retrieved") {
        tasksWithEvidence++;
        totalSpans += result.citedPaperEvidenceSpans.length;
      } else if (result.evidenceRetrievalStatus === "no_matches") {
        tasksNoMatches++;
      } else if (result.evidenceRetrievalStatus === "abstract_only_matches") {
        tasksAbstractOnlyMatches++;
      }
    }

    edges.push({
      packetId: packet.packetId,
      citingPaperTitle: packet.citingPaper.title,
      citedPaperTitle: packet.citedPaper.title,
      extractionState: packet.extractionState,
      extractionOutcome: packet.extractionOutcome,
      isReviewMediated: packet.isReviewMediated,
      tasks: tasksWithEvidenceForPacket,
    });
  }

  return {
    seed: classification.seed,
    resolvedSeedPaperTitle: classification.resolvedSeedPaperTitle,
    studyMode: classification.studyMode,
    citedPaperFullTextAvailable: hasFullText,
    citedPaperSource,
    edges,
    summary: {
      totalTasks,
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
