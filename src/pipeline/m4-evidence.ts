import type {
  CitedPaperSource,
  FamilyClassificationResult,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import type { FullTextContent } from "../retrieval/fulltext-fetch.js";

export type M4EvidenceAdapters = {
  resolveByDoi: (doi: string) => Promise<Result<ResolvedPaper>>;
  fetchFullText: (paper: ResolvedPaper) => Promise<Result<FullTextContent>>;
};

export type MaterializedCitedPaperSource = {
  citedPaperSource: CitedPaperSource;
  citedPaperFullText: string | undefined;
};

export async function resolveCitedPaperSource(
  classification: FamilyClassificationResult,
  adapters: M4EvidenceAdapters,
): Promise<MaterializedCitedPaperSource> {
  const seedPacket = classification.packets.find((packet) => packet.citedPaper.doi);
  const citedPaperDoi = seedPacket?.citedPaper.doi;

  if (!citedPaperDoi) {
    return {
      citedPaperSource: {
        resolutionStatus: "missing_doi",
        resolutionError: "Cited paper DOI is missing from the classification artifact",
        resolvedPaper: undefined,
        fetchStatus: "not_attempted",
        fetchError: undefined,
        fullTextFormat: undefined,
      },
      citedPaperFullText: undefined,
    };
  }

  const resolvedResult = await adapters.resolveByDoi(citedPaperDoi);
  if (!resolvedResult.ok) {
    return {
      citedPaperSource: {
        resolutionStatus: "resolution_failed",
        resolutionError: resolvedResult.error,
        resolvedPaper: undefined,
        fetchStatus: "not_attempted",
        fetchError: undefined,
        fullTextFormat: undefined,
      },
      citedPaperFullText: undefined,
    };
  }

  const resolvedPaper = resolvedResult.data;
  if (resolvedPaper.fullTextStatus.status !== "available") {
    const reason =
      resolvedPaper.fullTextStatus.status === "unavailable"
        ? resolvedPaper.fullTextStatus.reason
        : "Only abstract text is available";

    return {
      citedPaperSource: {
        resolutionStatus: "resolved",
        resolutionError: undefined,
        resolvedPaper,
        fetchStatus: "no_fulltext",
        fetchError: reason,
        fullTextFormat: undefined,
      },
      citedPaperFullText: undefined,
    };
  }

  const fullTextResult = await adapters.fetchFullText(resolvedPaper);
  if (!fullTextResult.ok) {
    return {
      citedPaperSource: {
        resolutionStatus: "resolved",
        resolutionError: undefined,
        resolvedPaper,
        fetchStatus: "fetch_failed",
        fetchError: fullTextResult.error,
        fullTextFormat: undefined,
      },
      citedPaperFullText: undefined,
    };
  }

  return {
    citedPaperSource: {
      resolutionStatus: "resolved",
      resolutionError: undefined,
      resolvedPaper,
      fetchStatus: "retrieved",
      fetchError: undefined,
      fullTextFormat: fullTextResult.data.format,
    },
    citedPaperFullText: fullTextResult.data.content,
  };
}
