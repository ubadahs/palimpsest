import { resolve } from "node:path";

import type { AppEnvironment } from "./env.js";

export type AppConfig = {
  nodeEnv: AppEnvironment["NODE_ENV"];
  databasePath: string;
  providerBaseUrls: {
    openAlex: string;
    semanticScholar: string;
    bioRxiv: string;
    grobid: string;
  };
  localRerankerBaseUrl: string | undefined;
  openAlexEmail: string | undefined;
  semanticScholarApiKey: string | undefined;
  anthropicApiKey: string | undefined;
};

export function createAppConfig(
  environment: AppEnvironment,
  cwd: string = process.cwd(),
): AppConfig {
  return {
    nodeEnv: environment.NODE_ENV,
    databasePath: resolve(cwd, environment.PALIMPSEST_DB_PATH),
    providerBaseUrls: {
      openAlex: environment.OPENALEX_BASE_URL,
      semanticScholar: environment.SEMANTIC_SCHOLAR_BASE_URL,
      bioRxiv: environment.BIORXIV_BASE_URL,
      grobid: environment.GROBID_BASE_URL,
    },
    localRerankerBaseUrl: environment.LOCAL_RERANKER_BASE_URL,
    openAlexEmail: environment.OPENALEX_EMAIL,
    semanticScholarApiKey: environment.SEMANTIC_SCHOLAR_API_KEY,
    anthropicApiKey: environment.ANTHROPIC_API_KEY,
  };
}
