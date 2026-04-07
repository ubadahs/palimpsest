import { mkdirSync, writeFileSync } from "node:fs";
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
import { materializeParsedPaper } from "../../retrieval/parsed-paper.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
  writeJsonArtifact,
} from "../../shared/artifact-io.js";
import { nextRunStamp } from "../run-stamp.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const DEFAULT_TOP_N = 5;

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
// Markdown report
// ---------------------------------------------------------------------------

function toDiscoveryMarkdown(results: ClaimDiscoveryResult[]): string {
  const lines: string[] = ["# Claim Discovery Report", ""];

  for (const result of results) {
    const title = result.resolvedPaper?.title ?? result.doi;
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(`- **DOI:** ${result.doi}`);
    lines.push(`- **Status:** ${result.status}`);
    lines.push(`- **Detail:** ${result.statusDetail}`);
    if (result.llmModel) {
      lines.push(`- **Model:** ${result.llmModel}`);
    }
    if (result.llmEstimatedCostUsd != null) {
      lines.push(
        `- **Est. cost (extraction):** $${result.llmEstimatedCostUsd.toFixed(4)}`,
      );
    }
    lines.push(
      `- **Claims:** ${String(result.totalClaimCount)} total, ${String(result.findingCount)} findings`,
    );

    if (result.ranking) {
      const r = result.ranking;
      lines.push(
        `- **Ranking:** ${String(r.citingPapersAnalyzed)} citing papers analyzed (${r.rankingModel}, $${r.rankingEstimatedCostUsd.toFixed(4)})`,
      );
    }
    lines.push("");

    if (result.claims.length === 0) {
      lines.push("*No claims extracted.*");
      lines.push("");
      continue;
    }

    // If ranking exists, show the ranked summary first.
    if (result.ranking) {
      lines.push("### Ranked by citing-paper engagement");
      lines.push("");
      lines.push(
        "| Rank | # | Type | Direct | Indirect | Claim |",
      );
      lines.push("|------|---|------|--------|----------|-------|");

      const sorted = result.ranking.engagements;
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i]!;
        const truncated =
          e.claimText.length > 80
            ? `${e.claimText.slice(0, 77)}...`
            : e.claimText;
        lines.push(
          `| ${String(i + 1)} | ${String(e.claimIndex + 1)} | ${e.claimType} | ${String(e.directCount)} | ${String(e.indirectCount)} | ${truncated} |`,
        );
      }

      lines.push("");

      const withDirect = sorted.filter((e) => e.directCount > 0);
      if (withDirect.length > 0) {
        lines.push("### Claims with direct citing-paper engagement");
        lines.push("");
        for (const e of withDirect) {
          lines.push(
            `**#${String(e.claimIndex + 1)}** [${e.claimType}] — ${String(e.directCount)} direct, ${String(e.indirectCount)} indirect`,
          );
          lines.push(`> ${e.claimText}`);
          lines.push("");
          lines.push("Direct engagements:");
          for (const p of e.directPapers) {
            lines.push(`- ${p}`);
          }
          lines.push("");
        }
      }

      lines.push("---");
      lines.push("");
    }

    // Full claim list.
    lines.push("### All extracted claims");
    lines.push("");

    for (let i = 0; i < result.claims.length; i++) {
      const claim = result.claims[i]!;
      lines.push(
        `#### ${String(i + 1)}. [${claim.claimType}] ${claim.confidence === "medium" ? "(medium confidence) " : ""}`,
      );
      lines.push("");
      lines.push(`> ${claim.claimText}`);
      lines.push("");
      lines.push(`**Section:** ${claim.section}`);
      if (claim.citedReferences.length > 0) {
        lines.push(
          `**Cited references:** ${claim.citedReferences.join(", ")}`,
        );
      }
      lines.push("");
      lines.push("**Source:**");
      for (const span of claim.sourceSpans) {
        lines.push(`> ${span}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
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

      const results: ClaimDiscoveryResult[] = [];

      for (let i = 0; i < input.dois.length; i++) {
        const doi = input.dois[i]!;
        const label = `[${String(i + 1)}/${String(input.dois.length)}] ${doi}`;

        // Step 1: resolve
        progress.startStep("resolve_paper", { detail: label });
        const resolved = await resolvePaperByDoi(doi, {
          openAlexBaseUrl: config.providerBaseUrls.openAlex,
          semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
          openAlexEmail: config.openAlexEmail,
          semanticScholarApiKey: config.semanticScholarApiKey,
        });

        if (!resolved.ok) {
          progress.completeStep("resolve_paper", {
            detail: `Could not resolve ${doi}: ${resolved.error}`,
          });
          results.push({
            doi,
            resolvedPaper: undefined,
            status: "parse_failed",
            statusDetail: `Could not resolve DOI: ${resolved.error}`,
            claims: [],
            findingCount: 0,
            totalClaimCount: 0,
            llmModel: undefined,
            llmInputTokens: undefined,
            llmOutputTokens: undefined,
            llmEstimatedCostUsd: undefined,
            ranking: undefined,
            generatedAt: new Date().toISOString(),
          });
          continue;
        }
        progress.completeStep("resolve_paper", {
          detail: resolved.data.title,
        });

        // Step 2: fetch and parse
        progress.startStep("fetch_and_parse_full_text", { detail: label });
        const materialized = await materializeParsedPaper(
          resolved.data,
          config.providerBaseUrls.bioRxiv,
          fullTextAdapters,
          { db: database, cachePolicy },
        );

        if (!materialized.ok) {
          progress.completeStep("fetch_and_parse_full_text", {
            detail: `No full text: ${materialized.error}`,
          });
          results.push({
            doi,
            resolvedPaper: resolved.data,
            status: "no_fulltext",
            statusDetail: `Full text unavailable: ${materialized.error}`,
            claims: [],
            findingCount: 0,
            totalClaimCount: 0,
            llmModel: undefined,
            llmInputTokens: undefined,
            llmOutputTokens: undefined,
            llmEstimatedCostUsd: undefined,
            ranking: undefined,
            generatedAt: new Date().toISOString(),
          });
          continue;
        }
        progress.completeStep("fetch_and_parse_full_text", {
          detail: `${String(materialized.data.parsedDocument.blocks.length)} blocks parsed`,
        });

        // Step 3: LLM extraction
        progress.startStep("extract_claims", { detail: label });
        const result = await discoverClaims({
          paper: resolved.data,
          parsedDocument: materialized.data.parsedDocument,
          client,
          options: { model: args.model },
        });
        progress.completeStep("extract_claims", {
          detail: `${String(result.findingCount)} findings, ${String(result.totalClaimCount)} total claims`,
        });

        // Step 4: rank by citing-paper engagement (default on)
        if (args.rank && result.status === "completed" && result.claims.length > 0) {
          progress.startStep("rank_claims", {
            detail: `Ranking ${String(result.claims.length)} claims against citing papers...`,
          });

          const citingResult = await openalex.getCitingWorks(
            resolved.data.id,
            config.providerBaseUrls.openAlex,
            200,
            config.openAlexEmail,
          );

          if (citingResult.ok && citingResult.data.length > 0) {
            const ranking = await rankClaimsByEngagement({
              seedTitle: resolved.data.title,
              claims: result.claims,
              citingPapers: citingResult.data,
              client,
              onProgress: (done, total) => {
                progress.updateStep("rank_claims", {
                  detail: `Ranked ${String(done)}/${String(total)} citing papers`,
                });
              },
            });
            result.ranking = ranking;
            const withDirect = ranking.engagements.filter(
              (e) => e.directCount > 0,
            ).length;
            progress.completeStep("rank_claims", {
              detail: `${String(withDirect)} claims with direct citing-paper engagement`,
            });
          } else {
            progress.completeStep("rank_claims", {
              detail: citingResult.ok
                ? "No citing papers found — skipping ranking."
                : `Could not fetch citing papers: ${citingResult.error}`,
            });
          }
        }

        results.push(result);
      }

      // Step 5: write artifacts and emit shortlist
      progress.startStep("emit_shortlist", {
        detail: "Writing artifacts.",
      });

      const outputDir = resolve(process.cwd(), args.output);
      mkdirSync(outputDir, { recursive: true });

      const stamp = nextRunStamp(outputDir);
      const jsonPath = resolve(outputDir, `${stamp}_discovery-results.json`);
      const mdPath = resolve(outputDir, `${stamp}_discovery-report.md`);
      const shortlistPath = resolve(
        outputDir,
        `${stamp}_discovery-shortlist.json`,
      );

      writeJsonArtifact(jsonPath, results);
      writeFileSync(mdPath, toDiscoveryMarkdown(results), "utf8");

      // Build shortlist: top-N ranked findings per paper, ready for screen.
      const seeds: Array<{ doi: string; trackedClaim: string; notes: string }> =
        [];
      for (const result of results) {
        if (result.status !== "completed") continue;
        const doi = result.doi;

        if (result.ranking) {
          const topFindings = result.ranking.engagements
            .filter((e) => e.claimType === "finding" && e.directCount > 0)
            .slice(0, args.topN);

          for (const e of topFindings) {
            seeds.push({
              doi,
              trackedClaim: e.claimText,
              notes: `Auto-discovered; ${String(e.directCount)} direct, ${String(e.indirectCount)} indirect citing-paper engagements`,
            });
          }
        } else {
          // No ranking — take the first N findings by extraction order.
          const findings = result.claims
            .filter((c) => c.claimType === "finding")
            .slice(0, args.topN);
          for (const c of findings) {
            seeds.push({
              doi,
              trackedClaim: c.claimText,
              notes: "Auto-discovered (unranked)",
            });
          }
        }
      }

      writeJsonArtifact(shortlistPath, { seeds });

      const relatedArtifacts = [mdPath, shortlistPath];
      writeArtifactManifest(jsonPath, {
        artifactType: "discovery-results",
        generator: "discover",
        sourceArtifacts: [args.input],
        relatedArtifacts,
      });

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
