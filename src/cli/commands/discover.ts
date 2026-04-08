import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type { CachePolicy, ClaimDiscoveryResult } from "../../domain/types.js";
import { discoveryInputSchema } from "../../domain/discovery.js";
import { createLLMClient } from "../../integrations/llm-client.js";
import { discoverClaims } from "../../pipeline/claim-discovery.js";
import { rankClaimsByEngagement } from "../../pipeline/claim-ranking.js";
import { createDefaultAdapters } from "../../retrieval/fulltext-fetch.js";
import type { DiscoveryStrategy } from "../../pipeline/discovery-stage.js";
import { runDiscoveryStage } from "../../pipeline/discovery-stage.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import {
  writeAttributionDiscoveryArtifacts,
  writeDiscoveryArtifacts,
} from "../stage-artifact-writers.js";
import { buildPaperAdapters } from "../paper-adapters.js";
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
  strategy: DiscoveryStrategy;
  probeBudget: number;
  shortlistCap: number;
} {
  let input: string | undefined;
  let output = "data/discover";
  let model: string | undefined;
  let rank = true;
  let topN = DEFAULT_TOP_N;
  let strategy: DiscoveryStrategy = "legacy";
  let probeBudget = 20;
  let shortlistCap = 10;

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
    } else if (arg === "--strategy" && i + 1 < argv.length) {
      const val = argv[i + 1]!;
      if (val === "attribution_first" || val === "legacy") {
        strategy = val;
      } else {
        console.error(
          `Invalid --strategy value "${val}". Use "legacy" or "attribution_first".`,
        );
        process.exitCode = 1;
        throw new Error("Invalid --strategy");
      }
      i++;
    } else if (arg === "--probe-budget" && i + 1 < argv.length) {
      probeBudget = Math.max(1, parseInt(argv[i + 1]!, 10) || 20);
      i++;
    } else if (arg === "--shortlist-cap" && i + 1 < argv.length) {
      shortlistCap = Math.max(1, parseInt(argv[i + 1]!, 10) || 10);
      i++;
    }
  }

  if (!input) {
    console.error("Missing required --input <path> argument");
    process.exitCode = 1;
    throw new Error("Missing --input");
  }

  return { input, output, model, rank, topN, strategy, probeBudget, shortlistCap };
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

    const strategyLabel =
      args.strategy === "attribution_first"
        ? " (attribution-first)"
        : args.rank
          ? " (with ranking)"
          : "";
    console.info(
      `Discovering claims for ${String(input.dois.length)} paper(s)...${strategyLabel}`,
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

      const paperAdapters = buildPaperAdapters({
        resolverConfig: {
          openAlexBaseUrl: config.providerBaseUrls.openAlex,
          semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
          openAlexEmail: config.openAlexEmail,
          semanticScholarApiKey: config.semanticScholarApiKey,
        },
        biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
        openAlexBaseUrl: config.providerBaseUrls.openAlex,
        openAlexEmail: config.openAlexEmail,
        fullTextAdapters,
        cache: { db: database, cachePolicy },
      });

      const stageResult = await runDiscoveryStage(
        {
          dois: input.dois,
          topN: args.topN,
          rank: args.rank,
          model: args.model,
          strategy: args.strategy,
          ...(args.strategy === "attribution_first"
            ? {
                attributionAdapters: {
                  ...paperAdapters,
                  mentionHarvest: {
                    fullText: fullTextAdapters,
                    biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
                    cache: { db: database, cachePolicy },
                  },
                  llmClient: client,
                  groundingOptions: {
                    apiKey: config.anthropicApiKey,
                    llmClient: client,
                  },
                },
                attributionOptions: {
                  probeBudget: args.probeBudget,
                  shortlistCap: args.shortlistCap,
                },
              }
            : {}),
        },
        {
          ...paperAdapters,
          discoverClaims: (paper, parsedDocument, model) =>
            discoverClaims({
              paper,
              parsedDocument,
              client,
              ...(model ? { options: { model } } : {}),
            }),
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

      // Write artifacts
      progress.startStep("emit_shortlist", { detail: "Writing artifacts." });

      const outputDir = resolve(process.cwd(), args.output);
      mkdirSync(outputDir, { recursive: true });
      const stamp = nextRunStamp(outputDir);

      const artifacts =
        args.strategy === "attribution_first" &&
        stageResult.attributionDiscovery
          ? writeAttributionDiscoveryArtifacts({
              outputRoot: outputDir,
              stamp,
              results: stageResult.attributionDiscovery,
              seeds: stageResult.seeds,
              sourceArtifacts: [args.input],
            })
          : writeDiscoveryArtifacts({
              outputRoot: outputDir,
              stamp,
              results: stageResult.results,
              seeds: stageResult.seeds,
              sourceArtifacts: [args.input],
            });
      console.info(`\nResults written to:`);
      console.info(`  JSON: ${artifacts.jsonPath}`);
      console.info(`  Markdown: ${artifacts.mdPath}`);
      console.info(`  Shortlist: ${artifacts.shortlistPath}`);

      if (stageResult.seeds.length === 0) {
        const detail =
          args.strategy === "attribution_first"
            ? "No families shortlisted — check harvest and extraction sidecars."
            : buildNoSeedsDetail(stageResult.results);
        progress.failStep("emit_shortlist", { detail });
        console.error(`\n${detail}`);
        process.exitCode = 1;
        return;
      }

      progress.completeStep("emit_shortlist", {
        detail: `${String(stageResult.seeds.length)} seed(s) in shortlist`,
      });

      // Summary
      if (args.strategy === "attribution_first") {
        const attrResults = stageResult.attributionDiscovery ?? [];
        const totalMentions = attrResults.reduce(
          (n, r) => n + r.mentions.length,
          0,
        );
        const totalFamilies = attrResults.reduce(
          (n, r) => n + r.familyCandidates.length,
          0,
        );
        console.info(
          `\n${String(totalMentions)} mentions harvested, ${String(totalFamilies)} family candidates, ${String(stageResult.seeds.length)} shortlisted`,
        );
      } else {
        const totalFindings = stageResult.results.reduce(
          (s, r) => s + r.findingCount,
          0,
        );
        const totalClaims = stageResult.results.reduce(
          (s, r) => s + r.totalClaimCount,
          0,
        );
        const completed = stageResult.results.filter(
          (r) => r.status === "completed",
        ).length;
        console.info(
          `\n${String(completed)}/${String(stageResult.results.length)} papers processed, ${String(totalClaims)} claims (${String(totalFindings)} findings), ${String(stageResult.seeds.length)} seeds in shortlist`,
        );
      }

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
