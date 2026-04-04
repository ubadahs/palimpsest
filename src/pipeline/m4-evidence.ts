import type {
  CitedPaperSource,
  FamilyClassificationResult,
  ParsedPaperDocument,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import type { ParsedPaperMaterialized } from "../retrieval/parsed-paper.js";

export type M4EvidenceAdapters = {
  resolveByDoi: (doi: string) => Promise<Result<ResolvedPaper>>;
  resolveByMetadata: (locator: {
    doi?: string;
    pmcid?: string;
    pmid?: string;
    title: string;
    authors: string[];
    publicationYear?: number;
  }) => Promise<Result<ResolvedPaper>>;
  materializeParsedPaper: (
    paper: ResolvedPaper,
  ) => Promise<Result<ParsedPaperMaterialized>>;
};

export type MaterializedCitedPaperSource = {
  citedPaperSource: CitedPaperSource;
  citedPaperParsedDocument: ParsedPaperDocument | undefined;
};

export async function resolveCitedPaperSource(
  classification: FamilyClassificationResult,
  adapters: M4EvidenceAdapters,
): Promise<MaterializedCitedPaperSource> {
  const seedPacket = classification.packets[0];
  const citedPaperLocator = seedPacket?.citedPaper;

  if (!citedPaperLocator) {
    return {
      citedPaperSource: {
        resolutionStatus: "resolution_failed",
        resolutionError:
          "Cited paper metadata is missing from the classification artifact",
        resolvedPaper: undefined,
        fetchStatus: "not_attempted",
        fetchError: undefined,
        fullTextFormat: undefined,
      },
      citedPaperParsedDocument: undefined,
    };
  }

  const metadataLocator = {
    title: citedPaperLocator.title,
    authors: citedPaperLocator.authors,
    ...(citedPaperLocator.doi ? { doi: citedPaperLocator.doi } : {}),
    ...(citedPaperLocator.pmcid ? { pmcid: citedPaperLocator.pmcid } : {}),
    ...(citedPaperLocator.pmid ? { pmid: citedPaperLocator.pmid } : {}),
    ...(citedPaperLocator.publicationYear
      ? { publicationYear: citedPaperLocator.publicationYear }
      : {}),
  };

  const resolvedResult = citedPaperLocator.doi
    ? await adapters.resolveByDoi(citedPaperLocator.doi)
    : await adapters.resolveByMetadata(metadataLocator);
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
      citedPaperParsedDocument: undefined,
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
      citedPaperParsedDocument: undefined,
    };
  }

  const parsedPaperResult =
    await adapters.materializeParsedPaper(resolvedPaper);
  if (!parsedPaperResult.ok) {
    return {
      citedPaperSource: {
        resolutionStatus: "resolved",
        resolutionError: undefined,
        resolvedPaper,
        fetchStatus: "fetch_failed",
        fetchError: parsedPaperResult.error,
        fullTextFormat: undefined,
      },
      citedPaperParsedDocument: undefined,
    };
  }

  return {
    citedPaperSource: {
      resolutionStatus: "resolved",
      resolutionError: undefined,
      resolvedPaper,
      fetchStatus: "retrieved",
      fetchError: undefined,
      fullTextFormat: parsedPaperResult.data.fullText.format,
    },
    citedPaperParsedDocument: parsedPaperResult.data.parsedDocument,
  };
}
