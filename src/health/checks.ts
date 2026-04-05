import { resolve } from "node:path";

import { loadEnvironmentLenient } from "../config/env.js";
import { createLocalReranker } from "../retrieval/local-reranker.js";

export type HealthState = "ok" | "error" | "not_configured";

export type HealthCheck = {
  status: HealthState;
  detail?: string;
};

export type EnvironmentHealthSummary = {
  nodeEnv: string;
  databasePath: string;
  providerBaseUrls: {
    openAlex: string;
    semanticScholar: string;
    bioRxiv: string;
    grobid: string;
  };
  localRerankerBaseUrl: string | undefined;
  anthropicConfigured: boolean;
  health: {
    database: HealthCheck;
    grobid: HealthCheck;
    anthropic: HealthCheck;
    reranker: HealthCheck;
  };
};

async function checkGrobid(baseUrl: string): Promise<HealthCheck> {
  try {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${normalizedBaseUrl}/api/isalive`, {
      headers: { "User-Agent": "citation-fidelity/0.1" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        status: "error",
        detail: `HTTP ${String(response.status)} from ${normalizedBaseUrl}`,
      };
    }
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkDatabase(path: string): Promise<HealthCheck> {
  try {
    const { openDatabase } = await import("../storage/database.js");
    const database = openDatabase(path);
    database.prepare("SELECT 1").get();
    database.close();
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getEnvironmentHealthSummary(
  cwd: string = process.cwd(),
): Promise<EnvironmentHealthSummary> {
  const environment = loadEnvironmentLenient(process.env, { cwd });
  const databasePath = resolve(cwd, environment.CITATION_FIDELITY_DB_PATH);
  const providerBaseUrls = {
    openAlex: environment.OPENALEX_BASE_URL,
    semanticScholar: environment.SEMANTIC_SCHOLAR_BASE_URL,
    bioRxiv: environment.BIORXIV_BASE_URL,
    grobid: environment.GROBID_BASE_URL ?? "",
  };
  const grobid = environment.GROBID_BASE_URL
    ? await checkGrobid(environment.GROBID_BASE_URL)
    : {
        status: "error" as const,
        detail: "GROBID_BASE_URL is not configured.",
      };
  const database = await checkDatabase(databasePath);
  const reranker = createLocalReranker(environment.LOCAL_RERANKER_BASE_URL);
  const rerankerHealth = reranker ? await reranker.healthCheck() : undefined;

  return {
    nodeEnv: environment.NODE_ENV,
    databasePath,
    providerBaseUrls,
    localRerankerBaseUrl: environment.LOCAL_RERANKER_BASE_URL,
    anthropicConfigured: Boolean(environment.ANTHROPIC_API_KEY),
    health: {
      database,
      grobid,
      anthropic: environment.ANTHROPIC_API_KEY
        ? { status: "ok" }
        : { status: "error", detail: "ANTHROPIC_API_KEY is not configured." },
      reranker: reranker
        ? rerankerHealth?.ok
          ? { status: "ok" }
          : {
              status: "error",
              detail: rerankerHealth?.error ?? "unknown error",
            }
        : { status: "not_configured" },
    },
  };
}
