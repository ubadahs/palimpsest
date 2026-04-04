import type { ResolvedPaper, Result } from "../domain/types.js";
import * as openalex from "./openalex.js";
import * as semanticScholar from "./semantic-scholar.js";

export type ResolvePaperByDoiConfig = {
  openAlexBaseUrl: string;
  semanticScholarBaseUrl: string;
  openAlexEmail: string | undefined;
  semanticScholarApiKey: string | undefined;
};

export async function resolvePaperByDoi(
  doi: string,
  config: ResolvePaperByDoiConfig,
): Promise<Result<ResolvedPaper>> {
  const openAlexResult = await openalex.resolveWorkByDoi(
    doi,
    config.openAlexBaseUrl,
    config.openAlexEmail,
  );

  if (openAlexResult.ok) {
    return openAlexResult;
  }

  return semanticScholar.resolvePaperByDoi(
    doi,
    config.semanticScholarBaseUrl,
    config.semanticScholarApiKey,
  );
}

export type PaperMetadataLocator = {
  doi?: string;
  pmcid?: string;
  pmid?: string;
  title: string;
  authors: string[];
  publicationYear?: number;
};

export async function resolvePaperByMetadata(
  locator: PaperMetadataLocator,
  config: ResolvePaperByDoiConfig,
): Promise<Result<ResolvedPaper>> {
  if (locator.doi) {
    return resolvePaperByDoi(locator.doi, config);
  }

  if (locator.pmid) {
    const openAlexPmidResult = await openalex.resolveWorkByPmid(
      locator.pmid,
      config.openAlexBaseUrl,
      config.openAlexEmail,
    );
    if (openAlexPmidResult.ok) {
      return openAlexPmidResult;
    }

    const semanticScholarPmidResult = await semanticScholar.resolvePaperByPmid(
      locator.pmid,
      config.semanticScholarBaseUrl,
      config.semanticScholarApiKey,
    );
    if (semanticScholarPmidResult.ok) {
      return semanticScholarPmidResult;
    }
  }

  if (locator.pmcid) {
    const openAlexPmcidResult = await openalex.resolveWorkByPmcid(
      locator.pmcid,
      config.openAlexBaseUrl,
      config.openAlexEmail,
    );
    if (openAlexPmcidResult.ok) {
      return openAlexPmcidResult;
    }

    const semanticScholarPmcidResult =
      await semanticScholar.resolvePaperByPmcid(
        locator.pmcid,
        config.semanticScholarBaseUrl,
        config.semanticScholarApiKey,
      );
    if (semanticScholarPmcidResult.ok) {
      return semanticScholarPmcidResult;
    }
  }

  const openAlexMetadataResult = await openalex.resolveWorkByMetadata(
    locator,
    config.openAlexBaseUrl,
    config.openAlexEmail,
  );
  if (openAlexMetadataResult.ok) {
    return openAlexMetadataResult;
  }

  return semanticScholar.resolvePaperByMetadata(
    locator,
    config.semanticScholarBaseUrl,
    config.semanticScholarApiKey,
  );
}
