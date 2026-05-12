import type {
  AdjudicationRecord,
  CitationRole,
  EvaluationMode,
  EvidenceSpan,
  TaskEvidenceRetrievalStatus,
  TransmissionModifiers,
} from "../domain/types.js";
import {
  annotateCitingContext,
  extractCitingWindow,
} from "../shared/citation-context-window.js";

export type AdjudicationPacket = {
  recordId: string;
  taskId: string;
  citationRole: CitationRole;
  evaluationMode: EvaluationMode;
  modifiers: TransmissionModifiers;
  citingPaperTitle: string;
  citedPaperTitle: string;
  groundedSeedClaimText?: string | undefined;
  rubricQuestion: string;
  citingSpanSection?: string | undefined;
  citingMarker: string;
  seedRefLabel?: string | undefined;
  markedCitingContext: string;
  evidenceSpans: EvidenceSpan[];
  evidenceRetrievalStatus: TaskEvidenceRetrievalStatus;
};

/**
 * Returns a warning note when retrieval did not produce full-text evidence,
 * so the adjudicator knows why the evidence block is empty or weak.
 */
export function retrievalStatusNote(
  status: TaskEvidenceRetrievalStatus,
): string {
  switch (status) {
    case "no_fulltext":
      return "Note: The cited paper's full text was not available — evidence is abstract-only or absent. Default to cannot_determine unless the abstract alone is sufficient to judge.";
    case "abstract_only_matches":
      return "Note: Only abstract-level passages were retrieved; body text was unavailable or yielded no matches. Abstract evidence is weaker — rate retrievalQuality as medium or low.";
    case "unresolved_cited_paper":
      return "Note: The cited paper metadata could not be resolved. No full-text evidence was retrieved. Verdict should be cannot_determine.";
    case "no_matches":
      return "Note: No matching passages were found in the cited paper. This may indicate a retrieval gap or a mismatch between the citation and the paper's content.";
    default:
      return "";
  }
}

export const EVIDENCE_LEGEND =
  "Evidence legend: llm_reranked = LLM-curated key sentences (score 0–100); bm25 / bm25_reranked = lexical keyword match.";

function renderEvidenceSpan(span: EvidenceSpan, index: number): string {
  // Only show score for llm_reranked — the 0–100 scale is meaningful;
  // BM25 scores are not comparable and would be noise.
  const scoreLabel =
    span.matchMethod === "llm_reranked"
      ? `, relevance ${String(span.relevanceScore)}/100`
      : "";
  const sectionLabel = span.sectionTitle
    ? ` (section: "${span.sectionTitle}")`
    : "";
  return `Evidence span ${String(index + 1)} [${span.matchMethod}${scoreLabel}]${sectionLabel}:\n"${span.text}"`;
}

export function renderEvidenceBlock(packet: AdjudicationPacket): string {
  const spansText =
    packet.evidenceSpans.length > 0
      ? EVIDENCE_LEGEND +
        "\n\n" +
        packet.evidenceSpans.slice(0, 3).map(renderEvidenceSpan).join("\n\n")
      : "No evidence spans retrieved.";

  const statusNote = retrievalStatusNote(packet.evidenceRetrievalStatus);
  return statusNote ? `${statusNote}\n\n${spansText}` : spansText;
}

function renderModifierString(modifiers: TransmissionModifiers): string {
  const rendered: string[] = [];
  if (modifiers.isBundled) {
    const size = modifiers.bundleSize;
    rendered.push(
      size != null && size > 1
        ? `bundled citation (${String(size)} references share this marker group)`
        : "bundled citation",
    );
  }
  if (modifiers.isReviewMediated) rendered.push("review-mediated");
  return rendered.length > 0 ? `\nModifiers: ${rendered.join(", ")}` : "";
}

function renderSeedClaimBlock(packet: AdjudicationPacket): string {
  return packet.groundedSeedClaimText
    ? `\nTracked seed claim (grounded in the cited/seed paper during pre-screen): "${packet.groundedSeedClaimText}"\nUse this as the analyst's anchor for what the citation family is about, while still judging the citing span on its own terms.\n`
    : "";
}

export function buildAdjudicationPacket(
  record: AdjudicationRecord,
): AdjudicationPacket {
  return {
    recordId: record.recordId,
    taskId: record.taskId,
    citationRole: record.citationRole,
    evaluationMode: record.evaluationMode,
    modifiers: record.modifiers,
    citingPaperTitle: record.citingPaperTitle,
    citedPaperTitle: record.citedPaperTitle,
    groundedSeedClaimText: record.groundedSeedClaimText,
    rubricQuestion: record.rubricQuestion,
    citingSpanSection: record.citingSpanSection,
    citingMarker: record.citingMarker,
    seedRefLabel: record.seedRefLabel,
    markedCitingContext: annotateCitingContext(
      extractCitingWindow(
        record.citingSpan,
        record.seedRefLabel ?? record.citingMarker,
        800,
      ),
      record.citingMarker,
      record.seedRefLabel,
    ),
    evidenceSpans: record.evidenceSpans,
    evidenceRetrievalStatus: record.evidenceRetrievalStatus,
  };
}

export function renderAdjudicationPacket(packet: AdjudicationPacket): string {
  const modifierStr = renderModifierString(packet.modifiers);
  const seedClaimBlock = renderSeedClaimBlock(packet);

  return `## Context

Citation role: ${packet.citationRole}
Evaluation mode: ${packet.evaluationMode}${modifierStr}
Citing paper: "${packet.citingPaperTitle}"
Cited paper: "${packet.citedPaperTitle}"
${seedClaimBlock}
## Rubric question

${packet.rubricQuestion}

## Citing context

Section: ${packet.citingSpanSection ?? "unknown"}
Citation marker for the paper under evaluation: "${packet.citingMarker}"

"${packet.markedCitingContext}"

Sentences wrapped in ▶ ... ◀ are the ones that directly cite the paper under evaluation. Unmarked sentences cite other papers and are provided as surrounding context only.

## Citation scope

- If ▶ ... ◀ markers are present: only evaluate claims within the marked sentences. Unmarked sentences reference different papers — they provide context but are NOT attributed to the cited paper.
- If no ▶ ... ◀ markers appear AND the citation marker "${packet.citingMarker}" is visible in the text: the entire context is attributed to the cited paper.
- If no ▶ ... ◀ markers appear AND the citation marker is NOT visible in the text: the context window may not contain the attributed sentence. Default to cannot_determine.

## Evidence from cited paper

${renderEvidenceBlock(packet)}`;
}
