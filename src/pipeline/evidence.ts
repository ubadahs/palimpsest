import type {
  CitedPaperSource,
  FamilyClassificationResult,
  ParsedPaperDocument,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import type { ParsedPaperMaterializeResult } from "../retrieval/parsed-paper.js";

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
  ) => Promise<ParsedPaperMaterializeResult>;
};

export type MaterializedCitedPaperSource = {
  citedPaperSource: CitedPaperSource;
  citedPaperParsedDocument: ParsedPaperDocument | undefined;
};

export type M4ResolveProgressEvent = {
  step: "resolve_cited_paper" | "fetch_and_parse_cited_full_text";
  status: "running" | "completed";
  detail?: string;
};

export async function resolveCitedPaperSource(
  classification: FamilyClassificationResult,
  adapters: M4EvidenceAdapters,
  onProgress?: (event: M4ResolveProgressEvent) => void,
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
        acquisition: undefined,
      },
      citedPaperParsedDocument: undefined,
    };
  }

  onProgress?.({
    step: "resolve_cited_paper",
    status: "running",
    detail: citedPaperLocator.title,
  });
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
    onProgress?.({
      step: "resolve_cited_paper",
      status: "completed",
      detail: `Resolution failed: ${resolvedResult.error}`,
    });
    return {
      citedPaperSource: {
        resolutionStatus: "resolution_failed",
        resolutionError: resolvedResult.error,
        resolvedPaper: undefined,
        fetchStatus: "not_attempted",
        fetchError: undefined,
        fullTextFormat: undefined,
        acquisition: undefined,
      },
      citedPaperParsedDocument: undefined,
    };
  }

  const resolvedPaper = resolvedResult.data;
  onProgress?.({
    step: "resolve_cited_paper",
    status: "completed",
    detail: resolvedPaper.title,
  });
  if (resolvedPaper.fullTextHints.providerAvailability !== "available") {
    const reason =
      resolvedPaper.fullTextHints.providerAvailability === "abstract_only"
        ? "Only abstract text is available"
        : (resolvedPaper.fullTextHints.providerReason ??
          "No open-access full text available");

    onProgress?.({
      step: "fetch_and_parse_cited_full_text",
      status: "completed",
      detail: `Full text unavailable: ${reason}`,
    });
    return {
      citedPaperSource: {
        resolutionStatus: "resolved",
        resolutionError: undefined,
        resolvedPaper,
        fetchStatus: "no_fulltext",
        fetchError: reason,
        fullTextFormat: undefined,
        acquisition: undefined,
      },
      citedPaperParsedDocument: undefined,
    };
  }

  onProgress?.({
    step: "fetch_and_parse_cited_full_text",
    status: "running",
    detail: "Fetching and parsing cited full text.",
  });
  const parsedPaperResult =
    await adapters.materializeParsedPaper(resolvedPaper);
  if (!parsedPaperResult.ok) {
    onProgress?.({
      step: "fetch_and_parse_cited_full_text",
      status: "completed",
      detail: `Parsing failed: ${parsedPaperResult.error}`,
    });
    return {
      citedPaperSource: {
        resolutionStatus: "resolved",
        resolutionError: undefined,
        resolvedPaper,
        fetchStatus: "fetch_failed",
        fetchError: parsedPaperResult.error,
        fullTextFormat: undefined,
        acquisition: parsedPaperResult.acquisition,
      },
      citedPaperParsedDocument: undefined,
    };
  }

  onProgress?.({
    step: "fetch_and_parse_cited_full_text",
    status: "completed",
    detail: `${String(parsedPaperResult.data.parsedDocument.blocks.length)} parsed blocks ready for retrieval`,
  });

  return {
    citedPaperSource: {
      resolutionStatus: "resolved",
      resolutionError: undefined,
      resolvedPaper,
      fetchStatus: "retrieved",
      fetchError: undefined,
      fullTextFormat: parsedPaperResult.data.fullText.format,
      acquisition: parsedPaperResult.data.acquisition,
    },
    citedPaperParsedDocument: parsedPaperResult.data.parsedDocument,
  };
}
