import { randomUUID } from "node:crypto";

import { DOMParser } from "@xmldom/xmldom";

import type {
  ClassifiedMention,
  EdgeWithEvidence,
  EvaluationMode,
  EvaluationTask,
  EvidenceSpan,
  FamilyClassificationResult,
  FamilyEvidenceResult,
  TaskWithEvidence,
} from "../domain/types.js";
import { getRubric } from "../classification/rubrics.js";

// --- Text chunking ---

type TextChunk = {
  text: string;
  sectionTitle: string | undefined;
  startOffset: number;
  endOffset: number;
};

function extractTextFromXml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const body = doc.getElementsByTagName("body").item(0);
  if (!body) return "";
  return (body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isXml(text: string): boolean {
  return (
    text.trimStart().startsWith("<?xml") || text.trimStart().startsWith("<")
  );
}

function chunkByParagraphs(fullText: string): TextChunk[] {
  const plainText = isXml(fullText) ? extractTextFromXml(fullText) : fullText;
  const chunks: TextChunk[] = [];

  const sentences = plainText.split(/(?<=[.!?])\s+/);
  let currentChunk = "";
  let chunkStart = 0;
  let offset = 0;

  for (const sentence of sentences) {
    if (
      currentChunk.length + sentence.length > 800 &&
      currentChunk.length > 100
    ) {
      chunks.push({
        text: currentChunk.trim(),
        sectionTitle: undefined,
        startOffset: chunkStart,
        endOffset: offset,
      });
      currentChunk = "";
      chunkStart = offset;
    }
    currentChunk += (currentChunk ? " " : "") + sentence;
    offset += sentence.length + 1;
  }

  if (currentChunk.trim().length >= 30) {
    chunks.push({
      text: currentChunk.trim(),
      sectionTitle: undefined,
      startOffset: chunkStart,
      endOffset: offset,
    });
  }

  return chunks;
}

// --- Keyword extraction from citing context ---

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "our",
  "they",
  "their",
  "not",
  "also",
  "et",
  "al",
  "fig",
  "figure",
  "table",
  "as",
  "such",
]);

function extractKeyTerms(text: string): string[] {
  const words = text.toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) ?? [];
  const unique = [...new Set(words.filter((w) => !STOP_WORDS.has(w)))];
  return unique.slice(0, 30);
}

function extractEntities(text: string): string[] {
  const entities: string[] = [];

  const geneProtein = text.match(
    /\b(?:Rab\d+|ACAP\d*|Par\d+[a-z]?|HNF4[αα]|Sox\d+|MARK\d+|Rab35|ICAM-\d+)\b/gi,
  );
  if (geneProtein) entities.push(...geneProtein.map((e) => e.toLowerCase()));

  const structures = text.match(
    /\b(?:bile\s+canalicul[ia]|apical\s+bulkhead|lumen|cyst|hepatocyte|hepatoblast|epithelial|polarity)\b/gi,
  );
  if (structures) entities.push(...structures.map((e) => e.toLowerCase()));

  return [...new Set(entities)];
}

// --- Scoring ---

function scoreChunk(
  chunk: TextChunk,
  keyTerms: string[],
  entities: string[],
): { score: number; method: EvidenceSpan["matchMethod"] } {
  const chunkLower = chunk.text.toLowerCase();

  let entityHits = 0;
  for (const e of entities) {
    if (chunkLower.includes(e)) entityHits++;
  }

  let keywordHits = 0;
  for (const k of keyTerms) {
    if (chunkLower.includes(k)) keywordHits++;
  }

  if (entityHits >= 2 && keywordHits >= 3) {
    return { score: entityHits * 3 + keywordHits, method: "entity_overlap" };
  }
  if (keywordHits >= 4) {
    return { score: keywordHits, method: "keyword_overlap" };
  }
  if (entityHits >= 1 && keywordHits >= 2) {
    return { score: entityHits * 2 + keywordHits, method: "claim_term" };
  }

  return { score: 0, method: "keyword_overlap" };
}

// --- Per-task evidence retrieval ---

function retrieveForTask(
  task: EvaluationTask,
  chunks: TextChunk[],
): TaskWithEvidence {
  const rubric = getRubric(task.evaluationMode);

  if (
    rubric.mode === "skip_low_information" ||
    rubric.mode === "manual_review_extraction_limited"
  ) {
    return {
      ...task,
      rubricQuestion: rubric.question,
      citedPaperEvidenceSpans: [],
      evidenceRetrievalStatus: "not_attempted",
    };
  }

  const combinedContext = task.mentions
    .map((m: ClassifiedMention) => m.rawContext)
    .join(" ");

  const keyTerms = extractKeyTerms(combinedContext);
  const entities = extractEntities(combinedContext);

  const scored = chunks
    .map((chunk) => {
      const { score, method } = scoreChunk(chunk, keyTerms, entities);
      return { chunk, score, method };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const spans: EvidenceSpan[] = scored.map((s) => ({
    spanId: randomUUID(),
    text: s.chunk.text.substring(0, 600),
    sectionTitle: s.chunk.sectionTitle,
    matchMethod: s.method,
    relevanceScore: s.score,
    charOffsetStart: s.chunk.startOffset,
    charOffsetEnd: s.chunk.endOffset,
  }));

  return {
    ...task,
    rubricQuestion: rubric.question,
    citedPaperEvidenceSpans: spans,
    evidenceRetrievalStatus: spans.length > 0 ? "retrieved" : "no_matches",
  };
}

// --- Public API ---

export function retrieveEvidence(
  classification: FamilyClassificationResult,
  citedPaperFullText: string | undefined,
): FamilyEvidenceResult {
  const chunks = citedPaperFullText
    ? chunkByParagraphs(citedPaperFullText)
    : [];
  const hasFullText = chunks.length > 0;

  const edges: EdgeWithEvidence[] = [];
  let totalTasks = 0;
  let tasksWithEvidence = 0;
  let tasksNoMatches = 0;
  let tasksNoFulltext = 0;
  let totalSpans = 0;
  const tasksByMode: Partial<Record<EvaluationMode, number>> = {};

  for (const packet of classification.packets) {
    if (packet.tasks.length === 0) continue;

    const tasksWithEv: TaskWithEvidence[] = [];

    for (const task of packet.tasks) {
      totalTasks++;
      const count = tasksByMode[task.evaluationMode] ?? 0;
      tasksByMode[task.evaluationMode] = count + 1;

      if (!hasFullText) {
        tasksWithEv.push({
          ...task,
          rubricQuestion: getRubric(task.evaluationMode).question,
          citedPaperEvidenceSpans: [],
          evidenceRetrievalStatus: "no_fulltext",
        });
        tasksNoFulltext++;
        continue;
      }

      const result = retrieveForTask(task, chunks);
      tasksWithEv.push(result);

      if (result.evidenceRetrievalStatus === "retrieved") {
        tasksWithEvidence++;
        totalSpans += result.citedPaperEvidenceSpans.length;
      } else if (result.evidenceRetrievalStatus === "no_matches") {
        tasksNoMatches++;
      }
    }

    edges.push({
      packetId: packet.packetId,
      citingPaperTitle: packet.citingPaper.title,
      citedPaperTitle: packet.citedPaper.title,
      extractionState: packet.extractionState,
      isReviewMediated: packet.isReviewMediated,
      tasks: tasksWithEv,
    });
  }

  return {
    seed: classification.seed,
    resolvedSeedPaperTitle: classification.resolvedSeedPaperTitle,
    studyMode: classification.studyMode,
    citedPaperFullTextAvailable: hasFullText,
    edges,
    summary: {
      totalTasks,
      tasksWithEvidence,
      tasksNoFulltext,
      tasksNoMatches,
      totalEvidenceSpans: totalSpans,
      tasksByMode,
    },
  };
}
