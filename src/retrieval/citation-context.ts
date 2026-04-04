import type {
  EdgeExtractionResult,
  ExtractionOutcome,
  PreScreenEdge,
  ResolvedPaper,
} from "../domain/types.js";
import type { ParsedPaperCacheOptions } from "./parsed-paper.js";
import { type FullTextFetchAdapters } from "./fulltext-fetch.js";
import {
  annotateMention,
  assessUsability,
  deduplicateMentions,
} from "./mention-analysis.js";
import {
  findReferenceByMetadata,
  materializeParsedPaper,
  toCitationMention,
} from "./parsed-paper.js";

export type ExtractionAdapters = {
  fullText: FullTextFetchAdapters;
  biorxivBaseUrl: string;
  cache?: ParsedPaperCacheOptions;
};

// --- Classify error strings into structured outcomes ---

function classifyFailure(error: string): ExtractionOutcome {
  if (/403/i.test(error)) return "fail_http_403";
  if (/grobid/i.test(error)) return "fail_grobid_parse_error";
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
    outcome === "success_structured" ||
    outcome === "success_pdf" ||
    outcome === "success_grobid";
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

  const parsedResult = await materializeParsedPaper(
    citingPaper,
    adapters.biorxivBaseUrl,
    adapters.fullText,
    adapters.cache,
  );

  if (!parsedResult.ok) {
    return makeResult(
      base,
      classifyFailure(parsedResult.error),
      "not_attempted",
      parsedResult.error,
    );
  }

  const { parsedDocument } = parsedResult.data;
  const refs = parsedDocument.references;

  if (refs.length === 0) {
    return makeResult(
      base,
      "fail_ref_list_empty",
      parsedDocument.parserKind === "grobid_tei" ? "grobid_tei" : "jats_xml",
      "Reference list parsed but empty",
    );
  }

  const seedRef = findReferenceByMetadata(refs, {
    title: seedPaper.title,
    ...(seedPaper.doi ? { doi: seedPaper.doi } : {}),
  });

  const sourceType =
    parsedDocument.parserKind === "grobid_tei"
      ? "grobid_tei"
      : parsedDocument.parserKind === "jats"
        ? "jats_xml"
        : "pdf_text";

  if (!seedRef) {
    return makeResult(
      base,
      "fail_no_reference_match",
      sourceType,
      `Seed paper not found in reference list (${String(refs.length)} refs parsed)`,
    );
  }

  const mentions = parsedDocument.mentions
    .filter((mention) => mention.refId === seedRef.refId)
    .map(toCitationMention);

  if (mentions.length === 0) {
    return makeResult(
      base,
      "fail_ref_found_but_no_in_text_xref",
      sourceType,
      "Seed ref found in reference list but no in-text citation mentions located",
    );
  }

  return makeResult(
    base,
    sourceType === "grobid_tei"
      ? "success_grobid"
      : sourceType === "jats_xml"
        ? "success_structured"
        : "success_pdf",
    sourceType,
    undefined,
    mentions,
  );
}
