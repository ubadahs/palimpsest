import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type { CachePolicy, ClaimDiscoveryResult } from "../../domain/types.js";
import { discoveryInputSchema } from "../../domain/discovery.js";
import { resolvePaperByDoi } from "../../integrations/paper-resolver.js";
import { createLLMClient } from "../../integrations/llm-client.js";
import * as openalex from "../../integrations/openalex.js";
import { discoverClaims } from "../../pipeline/claim-discovery.js";
import { rankClaimsByEngagement } from "../../pipeline/claim-ranking.js";
import { createDefaultAdapters } from "../../retrieval/fulltext-fetch.js";
import { runDiscoveryStage } from "../../pipeline/discovery-stage.js";
import { materializeParsedPaper } from "../../retrieval/parsed-paper.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import { writeDiscoveryArtifacts } from "../stage-artifact-writers.js";
import { nextRunStamp } from "../run-stamp.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const DEFAULT_TOP_N = 5;

function buildNoSeedsDetail(results: ClaimDiscoveryResult[]): string {
  const reasons = results
    .filter((result) => result.status !== "completed")
    .map((result) => `${result.doi}: ${result.statusDetail}`);
  if (reasons.length === 1) {
    return `No seeds produced: ${reasons[0]!}`;
  }
  if (reasons.length > 1) {
    return `No seeds produced.\n${reasons.map((reason) => `  ${reason}`).join("\n")}`;
  }

  const totalFindings = results.reduce(
    (count, result) => count + result.findingCount,
    0,
  );
  if (totalFindings > 0) {
    return "No ranked findings had direct citing-paper engagement.";
  }

  return "No empirical findings extracted from any paper.";
}

function parseArgs(argv: string[]): {
  input: string;
  output: string;
  model: string | undefined;
  rank: boolean;
  topN: number;
} {
  let input: string | undefined;
  let output = "data/discover";
  let model: string | undefined;
  let rank = true;
  let topN = DEFAULT_TOP_N;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && i + 1 < argv.length) {
      input = argv[i + 1];
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    } else if (arg === "--model" && i + 1 < argv.length) {
      model = argv[i + 1]!;
      i++;
    } else if (arg === "--no-rank") {
      rank = false;
    } else if (arg === "--top" && i + 1 < argv.length) {
      topN = Math.max(1, parseInt(argv[i + 1]!, 10) || DEFAULT_TOP_N);
      i++;
    }
  }

  if (!input) {
    console.error("Missing required --input <path> argument");
    process.exitCode = 1;
    throw new Error("Missing --input");
  }

  return { input, output, model, rank, topN };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function runDiscoverCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("discover");

  try {
    const input = loadJsonArtifact(
      args.input,
      discoveryInputSchema,
      "discovery input",
    );
    console.info(
      `Discovering claims for ${String(input.dois.length)} paper(s)...${args.rank ? " (with ranking)" : ""}`,
    );

    if (!config.anthropicApiKey?.trim()) {
      console.error(
        "discover requires ANTHROPIC_API_KEY for LLM claim extraction.",
      );
      process.exitCode = 1;
      return;
    }

    const database = openDatabase(config.databasePath);
    try {
      runMigrations(database);
      const cachePolicy: CachePolicy = "prefer_cache";
      const fullTextAdapters = createDefaultAdapters(
        config.providerBaseUrls.grobid,
        config.openAlexEmail,
      );
      const client = createLLMClient({
        apiKey: config.anthropicApiKey,
        defaultModel: args.model ?? "claude-opus-4-6",
      });

      const { results, seeds } = await runDiscoveryStage(
        {
          dois: input.dois,
          topN: args.topN,
          rank: args.rank,
          model: args.model,
        },
        {
          resolvePaperByDoi: (doi) =>
            resolvePaperByDoi(doi, {
              openAlexBaseUrl: config.providerBaseUrls.openAlex,
              semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
              openAlexEmail: config.openAlexEmail,
              semanticScholarApiKey: config.semanticScholarApiKey,
            }),
          materializeParsedPaper: (paper) =>
            materializeParsedPaper(
              paper,
              config.providerBaseUrls.bioRxiv,
              fullTextAdapters,
              { db: database, cachePolicy },
            ),
          discoverClaims: (paper, parsedDocument, model) =>
            discoverClaims({
              paper,
              parsedDocument,
              client,
              ...(model ? { options: { model } } : {}),
            }),
          getCitingPapers: (openAlexId) =>
            openalex.getCitingWorks(
              openAlexId,
              config.providerBaseUrls.openAlex,
              200,
              config.openAlexEmail,
            ),
          rankClaimsByEngagement: (
            seedTitle,
            claims,
            citingPapers,
            onProgress,
          ) =>
            rankClaimsByEngagement({
              seedTitle,
              claims,
              citingPapers,
              client,
              ...(onProgress ? { onProgress } : {}),
            }),
        },
        (event) => {
          if (event.status === "started") {
            progress.startStep(event.step, { detail: event.detail });
            return;
          }
          if (event.status === "updated") {
            progress.updateStep(event.step, { detail: event.detail });
            return;
          }
          progress.completeStep(event.step, { detail: event.detail });
        },
      );

      // Step 5: write artifacts and emit shortlist
      progress.startStep("emit_shortlist", {
        detail: "Writing artifacts.",
      });

      const outputDir = resolve(process.cwd(), args.output);
      mkdirSync(outputDir, { recursive: true });

      const stamp = nextRunStamp(outputDir);
      const { jsonPath, mdPath, shortlistPath } = writeDiscoveryArtifacts({
        outputRoot: outputDir,
        stamp,
        results,
        seeds,
        sourceArtifacts: [args.input],
      });

      if (seeds.length === 0) {
        const detail = buildNoSeedsDetail(results);
        progress.failStep("emit_shortlist", { detail });
        console.error(`\n${detail}`);
        process.exitCode = 1;
        return;
      }

      progress.completeStep("emit_shortlist", {
        detail: `${String(seeds.length)} seed(s) in shortlist`,
      });

      console.info(`\nResults written to:`);
      console.info(`  JSON: ${jsonPath}`);
      console.info(`  Markdown: ${mdPath}`);
      console.info(`  Shortlist: ${shortlistPath}`);

      const totalFindings = results.reduce((s, r) => s + r.findingCount, 0);
      const totalClaims = results.reduce((s, r) => s + r.totalClaimCount, 0);
      const completed = results.filter((r) => r.status === "completed").length;
      console.info(
        `\n${String(completed)}/${String(results.length)} papers processed, ${String(totalClaims)} claims (${String(totalFindings)} findings), ${String(seeds.length)} seeds in shortlist`,
      );

      const ledger = client.getLedger();
      if (ledger.totalCalls > 0) {
        console.info(
          `\nLLM (this run): ${ledger.totalCalls} calls, ~${ledger.totalEstimatedCostUsd.toFixed(4)} USD`,
        );
      }
    } finally {
      database.close();
    }
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
