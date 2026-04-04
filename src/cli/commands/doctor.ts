import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import {
  auditabilityStatusValues,
  citationFunctionValues,
  fidelityTopLabelValues,
} from "../../domain/taxonomy.js";
import { createLocalReranker } from "../../retrieval/local-reranker.js";

async function checkGrobid(baseUrl: string): Promise<{
  status: "ok" | "error";
  detail?: string;
}> {
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

export async function runDoctorCommand(): Promise<void> {
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const grobidHealth = await checkGrobid(config.providerBaseUrls.grobid);
  const reranker = createLocalReranker(config.localRerankerBaseUrl);
  const rerankerHealth = reranker ? await reranker.healthCheck() : undefined;

  const summary = {
    nodeEnv: config.nodeEnv,
    databasePath: config.databasePath,
    providerBaseUrls: config.providerBaseUrls,
    localRerankerBaseUrl: config.localRerankerBaseUrl,
    health: {
      grobid: grobidHealth,
      reranker: reranker
        ? rerankerHealth?.ok
          ? { status: "ok" as const }
          : {
              status: "error" as const,
              detail: rerankerHealth?.error ?? "unknown error",
            }
        : { status: "not_configured" as const },
    },
    taxonomy: {
      citationFunctions: citationFunctionValues.length,
      auditabilityStatuses: auditabilityStatusValues.length,
      fidelityTopLabels: fidelityTopLabelValues.length,
    },
  };

  console.info(JSON.stringify(summary, null, 2));

  if (grobidHealth.status !== "ok") {
    process.exitCode = 1;
  }
}
