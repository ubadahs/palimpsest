import type { ScopeCitationStatement } from "../contract/artifacts/scope-statements.js";
import {
  citationObservationParserMatches,
  type ParsedCitationMention,
  type ParsedPaperReference,
} from "../domain/parsing.js";
import type { ProvenanceStore } from "../pipeline/provenance-store.js";
import { sentenceAtOffset } from "../shared/citation-context-window.js";
import { decodeCitingPaperParse } from "./parsed-source.js";

export type FirstHopParagraphCitation = {
  marker: string;
  markerSpan: NonNullable<ParsedCitationMention["markerSpan"]>;
  sentence: string | undefined;
  references: (Pick<
    ParsedPaperReference,
    "authorSurnames" | "year" | "title" | "journal" | "doi"
  > & { id: string })[];
};

export type ReadFirstHopParagraphCitations = (
  statement: Pick<
    ScopeCitationStatement,
    "sourceVersion" | "citingPaperId" | "citationContext"
  >,
) => FirstHopParagraphCitation[];

/** Load exact citation markers and references in the first-hop paragraph.
 * Each marker can credit a different premise to a different work. */
export function createFirstHopParagraphCitationReader(
  store: Pick<ProvenanceStore, "load">,
): ReadFirstHopParagraphCitations {
  const parses = new Map<string, ReturnType<typeof decodeCitingPaperParse>>();
  return ({ sourceVersion, citingPaperId, citationContext }) => {
    const artifact = sourceVersion.artifacts.find(
      ({ role }) => role === "citing-paper-parse",
    );
    if (!artifact) return [];
    let parsed = parses.get(artifact.artifactId);
    if (!parsed) {
      parsed = decodeCitingPaperParse(store.load(artifact).body);
      parses.set(artifact.artifactId, parsed);
    }
    const { document, paperId, sourceTextHash } = parsed;
    if (
      paperId !== citingPaperId ||
      sourceTextHash !== sourceVersion.sourceTextHash ||
      document.parserVersion !== sourceVersion.parserVersion ||
      !citationObservationParserMatches(
        sourceVersion.parser,
        document.parserKind,
      )
    )
      return [];

    const blocks = document.blocks.filter(
      ({ text }) => text === citationContext,
    );
    if (blocks.length !== 1) return [];
    const blockId = blocks[0]!.blockId;
    const references = new Map(
      document.references.map((ref) => [ref.refId, ref]),
    );
    return document.mentions.flatMap(
      ({
        blockId: mentionBlockId,
        rawContext,
        citationMarker,
        locationQuality,
        markerSpan,
        targetRefIds,
      }) => {
        if (
          mentionBlockId !== blockId ||
          rawContext !== citationContext ||
          locationQuality !== "exact_dom" ||
          !markerSpan ||
          rawContext.slice(
            markerSpan.charOffsetStart,
            markerSpan.charOffsetEnd,
          ) !== citationMarker
        )
          return [];
        return [
          {
            marker: citationMarker,
            markerSpan,
            sentence: sentenceAtOffset(rawContext, markerSpan.charOffsetStart),
            references: targetRefIds.flatMap((id) => {
              const ref = references.get(id);
              if (!ref) return [];
              return [
                {
                  id,
                  authorSurnames: ref.authorSurnames,
                  year: ref.year,
                  title: ref.title,
                  journal: ref.journal,
                  doi: ref.doi,
                },
              ];
            }),
          },
        ];
      },
    );
  };
}

type ParentCitationEvidence = {
  context: string;
  marker: string;
  markerSpan?: ScopeCitationStatement["markerSpan"];
  sourceLocator?: ScopeCitationStatement["sourceLocator"];
  citationGroupOrdinal?: number;
};

export function locateHistoryCitationBlock(
  blocks: readonly { blockId: string; text: string }[],
  citation: ParentCitationEvidence,
): string | undefined {
  const { context, marker, markerSpan, sourceLocator, citationGroupOrdinal } =
    citation;
  if (
    !marker ||
    !markerSpan ||
    context.slice(markerSpan.charOffsetStart, markerSpan.charOffsetEnd) !==
      marker
  )
    return undefined;

  // The parser can assign the first matching block ID when the same paragraph
  // text occurs twice. Require uniqueness even when a block locator is present.
  const matches = blocks.filter((block) => block.text === context);
  if (matches.length !== 1) return undefined;

  const { blockId } = matches[0]!;
  if (
    sourceLocator?.kind === "block_id" &&
    sourceLocator.value !== `${blockId}#cg-${String(citationGroupOrdinal)}`
  )
    return undefined;

  return blockId;
}
