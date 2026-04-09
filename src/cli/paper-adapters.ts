/**
 * Shared adapter construction for discover and pipeline commands.
 *
 * Both commands need identical closures over provider config to resolve papers,
 * materialize full text, and fetch citing works. This module eliminates the
 * duplication so the two commands stay in sync.
 */

import type { ResolvedPaper, Result } from "../domain/types.js";
import {
  resolvePaperByDoi,
  type ResolvePaperByDoiConfig,
} from "../integrations/paper-resolver.js";
import type {
  ParsedPaperCacheOptions,
  ParsedPaperMaterializeResult,
} from "../retrieval/parsed-paper.js";
import { materializeParsedPaper } from "../retrieval/parsed-paper.js";
import type { FullTextFetchAdapters } from "../retrieval/fulltext-fetch.js";
import * as openalex from "../integrations/openalex.js";

export type PaperAdapterConfig = {
  resolverConfig: ResolvePaperByDoiConfig;
  biorxivBaseUrl: string;
  openAlexBaseUrl: string;
  openAlexEmail: string | undefined;
  fullTextAdapters: FullTextFetchAdapters;
  cache?: ParsedPaperCacheOptions;
};

export type PaperAdapters = {
  resolvePaperByDoi: (doi: string) => Promise<Result<ResolvedPaper>>;
  materializeParsedPaper: (
    paper: ResolvedPaper,
  ) => Promise<ParsedPaperMaterializeResult>;
  getCitingPapers: (openAlexId: string) => Promise<Result<ResolvedPaper[]>>;
};

export function buildPaperAdapters(config: PaperAdapterConfig): PaperAdapters {
  return {
    resolvePaperByDoi: (doi) => resolvePaperByDoi(doi, config.resolverConfig),
    materializeParsedPaper: (paper) =>
      materializeParsedPaper(
        paper,
        config.biorxivBaseUrl,
        config.fullTextAdapters,
        config.cache,
      ),
    getCitingPapers: (openAlexId) =>
      openalex.getCitingWorks(
        openAlexId,
        config.openAlexBaseUrl,
        200,
        config.openAlexEmail,
      ),
  };
}
