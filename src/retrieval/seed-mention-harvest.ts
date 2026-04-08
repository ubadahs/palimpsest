/**
 * Shared seed-mention-harvest service (Phase 2 of discover redesign).
 *
 * Extracts all in-text mentions of a seed paper from a citing paper's full text.
 * Both the redesigned `discover` stage (probe probing) and the existing `extract`
 * stage use this as their canonical mention-harvest path.
 *
 * Callers that need the legacy `EdgeExtractionResult` shape can continue to use
 * `extractEdgeContext` in citation-context.ts, which now delegates here.
 */

import type {
  FullTextAcquisition,
  HarvestedSeedMention,
  MentionHarvestOutcome,
  PaperHarvestSummary,
  ResolvedPaper,
} from "../domain/types.js";
import type { ParsedPaperCacheOptions } from "./parsed-paper.js";
import type { FullTextFetchAdapters } from "./fulltext-fetch.js";
import {
  findReferenceByMetadata,
  materializeParsedPaper,
} from "./parsed-paper.js";

export type MentionHarvestAdapters = {
  fullText: FullTextFetchAdapters;
  biorxivBaseUrl: string;
  cache?: ParsedPaperCacheOptions;
};

export type MentionHarvestResult = {
  citingPaperId: string;
  citedPaperId: string;
  outcome: MentionHarvestOutcome;
  failureReason: string | undefined;
  mentions: HarvestedSeedMention[];
  acquisition: FullTextAcquisition | undefined;
  summary: PaperHarvestSummary;
};

// Map acquisition/parse errors to structured outcome codes.
function classifyFailureOutcome(error: string): MentionHarvestOutcome {
  if (/403/i.test(error)) return "http_403";
  if (
    /pdf\s*parse/i.test(error) ||
    /invalid\s*pdf/i.test(error) ||
    /html_instead_of_pdf/i.test(error) ||
    /invalid_pdf_payload/i.test(error) ||
    /grobid/i.test(error)
  )
    return "parse_failed";
  return "unknown_failure";
}

function makeResult(
  citingPaper: ResolvedPaper,
  seedPaperId: string,
  outcome: MentionHarvestOutcome,
  failureReason: string | undefined,
  mentions: HarvestedSeedMention[],
  acquisition: FullTextAcquisition | undefined,
): MentionHarvestResult {
  return {
    citingPaperId: citingPaper.id,
    citedPaperId: seedPaperId,
    outcome,
    failureReason,
    mentions,
    acquisition,
    summary: {
      citingPaperId: citingPaper.id,
      citingPaperTitle: citingPaper.title,
      harvestOutcome: outcome,
      mentionCount: mentions.length,
      failureReason,
    },
  };
}

/**
 * Harvest all in-text mentions of `seedPaper` from `citingPaper`'s full text.
 *
 * Returns a structured result regardless of failure mode — callers should
 * inspect `result.outcome` rather than catching exceptions.
 */
export async function harvestSeedMentions(
  citingPaper: ResolvedPaper,
  seedPaper: ResolvedPaper,
  adapters: MentionHarvestAdapters,
): Promise<MentionHarvestResult> {
  const seedPaperId = seedPaper.id;

  if (citingPaper.fullTextHints.providerAvailability !== "available") {
    return makeResult(
      citingPaper,
      seedPaperId,
      "no_fulltext",
      "Full text not available",
      [],
      undefined,
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
      citingPaper,
      seedPaperId,
      classifyFailureOutcome(parsedResult.error),
      parsedResult.error,
      [],
      parsedResult.acquisition,
    );
  }

  const { parsedDocument, acquisition } = parsedResult.data;
  const refs = parsedDocument.references;

  if (refs.length === 0) {
    return makeResult(
      citingPaper,
      seedPaperId,
      "ref_list_empty",
      "Reference list parsed but empty",
      [],
      acquisition,
    );
  }

  const seedRef = findReferenceByMetadata(refs, {
    title: seedPaper.title,
    ...(seedPaper.doi ? { doi: seedPaper.doi } : {}),
  });

  if (!seedRef) {
    return makeResult(
      citingPaper,
      seedPaperId,
      "no_reference_match",
      `Seed paper not found in reference list (${String(refs.length)} refs parsed)`,
      [],
      acquisition,
    );
  }

  const rawMentions = parsedDocument.mentions.filter(
    (m) => m.refId === seedRef.refId,
  );

  if (rawMentions.length === 0) {
    return makeResult(
      citingPaper,
      seedPaperId,
      "ref_found_but_no_in_text_xref",
      "Seed ref found in reference list but no in-text citation mentions located",
      [],
      acquisition,
    );
  }

  // Derive a stable sourceType string from the parsed document's parser kind.
  const sourceType: HarvestedSeedMention["sourceType"] =
    parsedDocument.parserKind === "grobid_tei"
      ? "grobid_tei"
      : parsedDocument.parserKind === "jats"
        ? "jats_xml"
        : "pdf_text";

  const acquisitionMethod = acquisition.selectedMethod ?? undefined;

  const mentions: HarvestedSeedMention[] = rawMentions.map((m) => ({
    mentionId: `${citingPaper.id}:${String(m.mentionIndex)}`,
    citingPaperId: citingPaper.id,
    citedPaperId: seedPaperId,
    citationMarker: m.citationMarker,
    rawContext: m.rawContext,
    sectionTitle: m.sectionTitle,
    sourceType,
    provenance: {
      citingPaperTitle: citingPaper.title,
      parserKind: parsedDocument.parserKind,
      acquisitionMethod: acquisitionMethod,
    },
    harvestOutcome: "success" as const,
  }));

  return makeResult(
    citingPaper,
    seedPaperId,
    "success",
    undefined,
    mentions,
    acquisition,
  );
}
