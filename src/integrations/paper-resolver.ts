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
