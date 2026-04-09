import type {
  EdgeExtractionResult,
  ExtractionOutcome,
  HarvestedSeedMention,
  MentionHarvestOutcome,
  PreScreenEdge,
  ResolvedPaper,
} from "../domain/types.js";
import type { ParsedCitationMention } from "../domain/parsing.js";
import type { ParsedPaperCacheOptions } from "./parsed-paper.js";
import { type FullTextFetchAdapters } from "./fulltext-fetch.js";
import {
  annotateMention,
  assessUsability,
  deduplicateMentions,
} from "./mention-analysis.js";
import { toCitationMention } from "./parsed-paper.js";
import {
  harvestSeedMentions,
  type MentionHarvestAdapters,
} from "./seed-mention-harvest.js";

export type ExtractionAdapters = {
  fullText: FullTextFetchAdapters;
  biorxivBaseUrl: string;
  cache?: ParsedPaperCacheOptions;
};

// Map MentionHarvestOutcome → ExtractionOutcome so callers of extractEdgeContext
// see the same outcome vocabulary as before. Only non-success outcomes need
// mapping — the success branch is handled inline after mention conversion.
function toFailureOutcome(
  harvestOutcome: MentionHarvestOutcome,
): ExtractionOutcome {
  switch (harvestOutcome) {
    case "no_fulltext":
      return "skipped_not_auditable";
    case "http_403":
      return "fail_http_403";
    case "parse_failed":
      return "fail_pdf_parse_error";
    case "ref_list_empty":
      return "fail_ref_list_empty";
    case "no_reference_match":
      return "fail_no_reference_match";
    case "ref_found_but_no_in_text_xref":
      return "fail_ref_found_but_no_in_text_xref";
    default:
      return "fail_unknown";
  }
}

export async function extractEdgeContext(
  edge: PreScreenEdge,
  citingPaper: ResolvedPaper,
  seedPaper: ResolvedPaper,
  adapters: ExtractionAdapters,
): Promise<EdgeExtractionResult> {
  const harvestAdapters: MentionHarvestAdapters = {
    fullText: adapters.fullText,
    biorxivBaseUrl: adapters.biorxivBaseUrl,
    ...(adapters.cache != null ? { cache: adapters.cache } : {}),
  };

  const harvest = await harvestSeedMentions(
    citingPaper,
    seedPaper,
    harvestAdapters,
  );

  const base = {
    citingPaperId: edge.citingPaperId,
    citedPaperId: edge.citedPaperId,
    citingPaperTitle: citingPaper.title,
    citingPaperAcquisition: harvest.acquisition,
  };

  if (harvest.outcome !== "success" || harvest.mentions.length === 0) {
    const outcome = toFailureOutcome(harvest.outcome);
    return {
      ...base,
      sourceType: "not_attempted",
      extractionOutcome: outcome,
      extractionSuccess: false,
      usableForGrounding: false,
      rawMentionCount: 0,
      deduplicatedMentionCount: 0,
      mentions: [],
      failureReason: harvest.failureReason,
    };
  }

  // Convert HarvestedSeedMention → ParsedCitationMention-compatible shape for
  // existing mention-analysis helpers, then build CitationMention objects.
  const sourceType = harvest.mentions[0]!.sourceType;
  const edgeSourceType: EdgeExtractionResult["sourceType"] =
    sourceType === "grobid_tei"
      ? "grobid_tei"
      : sourceType === "jats_xml"
        ? "jats_xml"
        : "pdf_text";

  // Reconstruct ParsedCitationMention-compatible objects from harvested mentions
  // so we can run them through the existing annotation/dedup pipeline.
  const rawMentions = harvest.mentions.map((m) =>
    toCitationMentionFromHarvested(m, edgeSourceType),
  );
  const annotated = rawMentions.map(annotateMention);
  const { unique, rawCount } = deduplicateMentions(annotated);
  const usableForGrounding = assessUsability(unique);

  const extractionOutcome: ExtractionOutcome =
    edgeSourceType === "grobid_tei"
      ? "success_grobid"
      : edgeSourceType === "jats_xml"
        ? "success_structured"
        : "success_pdf";

  return {
    ...base,
    sourceType: edgeSourceType,
    extractionOutcome,
    extractionSuccess: true,
    usableForGrounding,
    rawMentionCount: rawCount,
    deduplicatedMentionCount: unique.length,
    mentions: unique,
    failureReason: undefined,
  };
}

/**
 * Re-hydrate a `HarvestedSeedMention` into the shape that `toCitationMention`
 * and `annotateMention` expect. We cannot call `toCitationMention` directly
 * because `HarvestedSeedMention` does not preserve `mentionIndex` or bundle
 * fields — so we synthesise minimal defaults here.
 */
function toCitationMentionFromHarvested(
  mention: HarvestedSeedMention,
  sourceType: "jats_xml" | "grobid_tei" | "pdf_text",
) {
  const parsed: ParsedCitationMention = {
    mentionIndex: 0,
    rawContext: mention.rawContext,
    citationMarker: mention.citationMarker,
    sectionTitle: mention.sectionTitle,
    refId: undefined,
    charOffsetStart: undefined,
    charOffsetEnd: undefined,
    isBundledCitation: false,
    bundleSize: 1,
    bundleRefIds: [],
    bundlePattern: "single",
    sourceType,
    parser: sourceType,
  };
  return toCitationMention(parsed);
}
