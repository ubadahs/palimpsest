import type {
  EdgeExtractionResult,
  ExtractionOutcome,
  PreScreenEdge,
  ResolvedPaper,
} from "../domain/types.js";
import { fetchFullText, type FullTextFetchAdapters } from "./fulltext-fetch.js";
import {
  extractCitationMentions,
  findSeedReference,
  parseReferences,
} from "./jats-parser.js";
import {
  annotateMention,
  assessUsability,
  deduplicateMentions,
} from "./mention-analysis.js";
import { findCitationMentionsByRegex } from "./pdf-extractor.js";

export type ExtractionAdapters = {
  fullText: FullTextFetchAdapters;
  biorxivBaseUrl: string;
};

// --- Classify error strings into structured outcomes ---

function classifyFailure(error: string): ExtractionOutcome {
  if (/403/i.test(error)) return "fail_http_403";
  if (/pdf\s*parse/i.test(error) || /invalid\s*pdf/i.test(error))
    return "fail_pdf_parse_error";
  return "fail_unknown";
}

// --- Build a result object with consistent shape ---

function makeResult(
  base: Pick<
    EdgeExtractionResult,
    "citingPaperId" | "citedPaperId" | "citingPaperTitle"
  >,
  outcome: ExtractionOutcome,
  sourceType: EdgeExtractionResult["sourceType"],
  failureReason: string | undefined,
  rawMentions: ReturnType<typeof annotateMention>[] = [],
): EdgeExtractionResult {
  const annotated = rawMentions.map(annotateMention);
  const { unique, rawCount } = deduplicateMentions(annotated);

  const extractionSuccess =
    outcome === "success_structured" || outcome === "success_pdf";
  const usableForGrounding = extractionSuccess
    ? assessUsability(unique)
    : false;

  return {
    ...base,
    sourceType,
    extractionOutcome: outcome,
    extractionSuccess,
    usableForGrounding,
    rawMentionCount: rawCount,
    deduplicatedMentionCount: unique.length,
    mentions: unique,
    failureReason,
  };
}

export async function extractEdgeContext(
  edge: PreScreenEdge,
  citingPaper: ResolvedPaper,
  seedPaper: ResolvedPaper,
  adapters: ExtractionAdapters,
): Promise<EdgeExtractionResult> {
  const base = {
    citingPaperId: edge.citingPaperId,
    citedPaperId: edge.citedPaperId,
    citingPaperTitle: citingPaper.title,
  };

  if (citingPaper.fullTextStatus.status !== "available") {
    return makeResult(
      base,
      "skipped_not_auditable",
      "not_attempted",
      "Full text not available",
    );
  }

  const textResult = await fetchFullText(
    citingPaper,
    adapters.biorxivBaseUrl,
    adapters.fullText,
  );

  if (!textResult.ok) {
    return makeResult(
      base,
      classifyFailure(textResult.error),
      "not_attempted",
      textResult.error,
    );
  }

  const { content, format } = textResult.data;

  if (format === "jats_xml") {
    const refs = parseReferences(content);

    if (refs.length === 0) {
      return makeResult(
        base,
        "fail_ref_list_empty",
        "jats_xml",
        "Reference list parsed but empty",
      );
    }

    const seedRef = findSeedReference(refs, seedPaper.doi, seedPaper.title);

    if (!seedRef) {
      return makeResult(
        base,
        "fail_no_reference_match",
        "jats_xml",
        `Seed paper not found in reference list (${String(refs.length)} refs parsed)`,
      );
    }

    const mentions = extractCitationMentions(content, [seedRef.refId]);

    if (mentions.length === 0) {
      return makeResult(
        base,
        "fail_ref_found_but_no_in_text_xref",
        "jats_xml",
        "Seed ref found in reference list but no in-text xref mentions located",
      );
    }

    return makeResult(
      base,
      "success_structured",
      "jats_xml",
      undefined,
      mentions,
    );
  }

  // PDF path
  const seedYear = seedPaper.publicationYear?.toString();
  const mentions = findCitationMentionsByRegex(
    content,
    seedPaper.authors,
    seedYear,
  );

  if (mentions.length === 0) {
    return makeResult(
      base,
      "fail_unknown",
      "pdf_text",
      "No author+year citation patterns found in extracted PDF text",
    );
  }

  return makeResult(base, "success_pdf", "pdf_text", undefined, mentions);
}
