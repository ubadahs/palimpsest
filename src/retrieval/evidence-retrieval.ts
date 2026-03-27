import { randomUUID } from "node:crypto";

import { DOMParser } from "@xmldom/xmldom";

import type {
  ClassifiedMention,
  CitedPaperSource,
  EdgeWithEvidence,
  EvaluationMode,
  EvaluationTask,
  EvidenceSpan,
  FamilyClassificationResult,
  FamilyEvidenceResult,
  TaskEvidenceRetrievalStatus,
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

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isXml(text: string): boolean {
  return (
    text.trimStart().startsWith("<?xml") || text.trimStart().startsWith("<")
  );
}

function appendChunk(
  chunks: TextChunk[],
  text: string,
  sectionTitle: string | undefined,
  offsetRef: { value: number },
): void {
  const normalized = normalizeText(text);
  if (normalized.length < 30) {
    return;
  }

  const startOffset = offsetRef.value;
  const endOffset = startOffset + normalized.length;
  chunks.push({
    text: normalized,
    sectionTitle,
    startOffset,
    endOffset,
  });
  offsetRef.value = endOffset + 2;
}

function getDirectChildElements(parent: Element, tagName: string): Element[] {
  const children: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes.item(i);
    if (node?.nodeType === 1 && (node as Element).tagName === tagName) {
      children.push(node as Element);
    }
  }
  return children;
}

function getFirstDirectChild(parent: Element, tagName: string): Element | undefined {
  return getDirectChildElements(parent, tagName)[0];
}

function walkSection(
  section: Element,
  inheritedTitle: string | undefined,
  chunks: TextChunk[],
  offsetRef: { value: number },
): void {
  const sectionTitle =
    normalizeText(getFirstDirectChild(section, "title")?.textContent ?? "") ||
    inheritedTitle;

  for (let i = 0; i < section.childNodes.length; i++) {
    const node = section.childNodes.item(i);
    if (node?.nodeType !== 1) {
      continue;
    }

    const element = node as Element;
    if (element.tagName === "sec") {
      walkSection(element, sectionTitle, chunks, offsetRef);
      continue;
    }

    if (element.tagName === "p") {
      appendChunk(chunks, element.textContent ?? "", sectionTitle, offsetRef);
      continue;
    }

    if (element.tagName === "fig" || element.tagName === "table-wrap") {
      const captionText = normalizeText(
        getFirstDirectChild(element, "caption")?.textContent ?? "",
      );
      if (captionText) {
        const captionSection = sectionTitle
          ? `${sectionTitle} / Figure caption`
          : "Figure caption";
        appendChunk(chunks, captionText, captionSection, offsetRef);
      }
    }
  }
}

function chunkXmlParagraphs(fullText: string): TextChunk[] {
  const doc = new DOMParser().parseFromString(fullText, "text/xml");
  const chunks: TextChunk[] = [];
  const offsetRef = { value: 0 };

  const abstracts = doc.getElementsByTagName("abstract");
  for (let i = 0; i < abstracts.length; i++) {
    const abstract = abstracts.item(i);
    if (!abstract) continue;
    appendChunk(chunks, abstract.textContent ?? "", "Abstract", offsetRef);
  }

  const body = doc.getElementsByTagName("body").item(0);
  if (!body || body.nodeType !== 1) {
    return chunks;
  }

  for (let i = 0; i < body.childNodes.length; i++) {
    const node = body.childNodes.item(i);
    if (node?.nodeType !== 1) {
      continue;
    }

    const element = node as Element;
    if (element.tagName === "sec") {
      walkSection(element, undefined, chunks, offsetRef);
      continue;
    }

    if (element.tagName === "p") {
      appendChunk(chunks, element.textContent ?? "", undefined, offsetRef);
    }
  }

  return chunks;
}

function chunkPlainText(fullText: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const paragraphs = fullText
    .split(/\n{2,}/)
    .map(normalizeText)
    .filter((paragraph) => paragraph.length >= 30);
  const sourceParagraphs =
    paragraphs.length > 0
      ? paragraphs
      : fullText
          .split(/(?<=[.!?])\s+/)
          .map(normalizeText)
          .filter((paragraph) => paragraph.length >= 30);

  let offset = 0;
  for (const paragraph of sourceParagraphs) {
    if (paragraph.length <= 1000) {
      chunks.push({
        text: paragraph,
        sectionTitle: undefined,
        startOffset: offset,
        endOffset: offset + paragraph.length,
      });
      offset += paragraph.length + 2;
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let current = "";
    let chunkStart = offset;

    for (const sentence of sentences) {
      if (current.length > 0 && current.length + sentence.length > 800) {
        chunks.push({
          text: current,
          sectionTitle: undefined,
          startOffset: chunkStart,
          endOffset: chunkStart + current.length,
        });
        chunkStart = chunkStart + current.length + 2;
        current = sentence;
      } else {
        current += current ? ` ${sentence}` : sentence;
      }
    }

    if (current.length > 0) {
      chunks.push({
        text: current,
        sectionTitle: undefined,
        startOffset: chunkStart,
        endOffset: chunkStart + current.length,
      });
      offset = chunkStart + current.length + 2;
    }
  }

  return chunks;
}

function chunkByParagraphs(fullText: string): TextChunk[] {
  return isXml(fullText) ? chunkXmlParagraphs(fullText) : chunkPlainText(fullText);
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
  const sectionLower = chunk.sectionTitle?.toLowerCase() ?? "";

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

  const sectionHits = keyTerms.filter((term) => sectionLower.includes(term)).length;
  if (sectionHits >= 1) {
    return { score: sectionHits, method: "section_title" };
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

function isNotAttemptedMode(task: EvaluationTask): boolean {
  return (
    task.evaluationMode === "skip_low_information" ||
    task.evaluationMode === "manual_review_extraction_limited"
  );
}

// --- Public API ---

export function retrieveEvidence(
  classification: FamilyClassificationResult,
  citedPaperSource: CitedPaperSource,
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
  let tasksUnresolvedCitedPaper = 0;
  let tasksNotAttempted = 0;
  let totalSpans = 0;
  const tasksByMode: Partial<Record<EvaluationMode, number>> = {};

  for (const packet of classification.packets) {
    if (packet.tasks.length === 0) continue;

    const tasksWithEv: TaskWithEvidence[] = [];

    for (const task of packet.tasks) {
      totalTasks++;
      const count = tasksByMode[task.evaluationMode] ?? 0;
      tasksByMode[task.evaluationMode] = count + 1;

      if (isNotAttemptedMode(task)) {
        const result = retrieveForTask(task, chunks);
        tasksWithEv.push(result);
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
        tasksWithEv.push({
          ...task,
          rubricQuestion: getRubric(task.evaluationMode).question,
          citedPaperEvidenceSpans: [],
          evidenceRetrievalStatus: status,
        });
        if (status === "no_fulltext") {
          tasksNoFulltext++;
        } else if (status === "unresolved_cited_paper") {
          tasksUnresolvedCitedPaper++;
        }
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
      extractionOutcome: packet.extractionOutcome,
      isReviewMediated: packet.isReviewMediated,
      tasks: tasksWithEv,
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
      tasksNotAttempted,
      totalEvidenceSpans: totalSpans,
      tasksByMode,
    },
  };
}
