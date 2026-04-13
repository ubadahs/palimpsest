import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type { CachePolicy } from "../../domain/types.js";
import {
  claimFamilyBlocksDownstream,
  preScreenResultsSchema,
} from "../../domain/types.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { runM2Extraction } from "../../pipeline/extract.js";
import { createFullTextAdapters } from "../paper-adapters.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import { writeExtractionArtifacts } from "../stage-artifact-writers.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  preScreenPath: string;
  seedDoi: string;
  output: string;
  forceRefresh: boolean;
} {
  let preScreenPath: string | undefined;
  let seedDoi: string | undefined;
  let output = "data/extraction";
  let forceRefresh = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pre-screen" && i + 1 < argv.length) {
      preScreenPath = argv[i + 1];
      i++;
    } else if (arg === "--seed-doi" && i + 1 < argv.length) {
      seedDoi = argv[i + 1];
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    } else if (arg === "--force-refresh") {
      forceRefresh = true;
    }
  }

  if (!preScreenPath || !seedDoi) {
    console.error(
      "Usage: extract --pre-screen <path> --seed-doi <doi> [--output <dir>] [--force-refresh]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { preScreenPath, seedDoi, output, forceRefresh };
}

export async function runExtractCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const database = openDatabase(config.databasePath);
  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("extract");

  try {
    runMigrations(database);

    const families = loadJsonArtifact(
      args.preScreenPath,
      preScreenResultsSchema,
      "pre-screen results",
    );

    const family = families.find(
      (f) => f.seed.doi.toLowerCase() === args.seedDoi.toLowerCase(),
    );

    if (!family) {
      console.error(
        `Seed DOI "${args.seedDoi}" not found in pre-screen results.`,
      );
      console.error("Available DOIs:");
      for (const candidate of families) {
        console.error(`  ${candidate.seed.doi}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!family.resolvedSeedPaper) {
      console.error(
        "Seed paper was not resolved during pre-screen — cannot extract.",
      );
      process.exitCode = 1;
      return;
    }

    if (claimFamilyBlocksDownstream(family)) {
      console.error(
        "Screening claim grounding blocks later stages for this family. Revise the tracked claim or fix seed full text, then re-run screen.",
      );
      console.error(
        `  Status: ${family.claimGrounding?.status ?? "unknown"} — ${family.claimGrounding?.detailReason ?? ""}`,
      );
      process.exitCode = 1;
      return;
    }

    console.info(`Extraction for: ${family.resolvedSeedPaper.title}`);
    console.info(`  ${String(family.edges.length)} edges to process\n`);

    const cachePolicy: CachePolicy = args.forceRefresh
      ? "force_refresh"
      : "prefer_cache";
    const adapters = {
      fullText: createFullTextAdapters(config),
      biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
      cache: {
        db: database,
        cachePolicy,
      },
    };

    const result = await runM2Extraction(family, adapters, (event) => {
      const payload = {
        ...(event.detail ? { detail: event.detail } : {}),
        ...(event.current != null && event.total != null
          ? { current: event.current, total: event.total }
          : {}),
      };
      if (event.status === "running") {
        progress.startStep(event.step, payload);
      } else {
        progress.completeStep(event.step, payload);
      }
    });

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const { jsonPath, mdPath, inspectionPath, manifestPath } =
      writeExtractionArtifacts({
        outputRoot: outputDir,
        stamp,
        result,
        sourceArtifacts: [args.preScreenPath],
      });

    console.info(`\nResults written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Markdown: ${mdPath}`);
    console.info(`  Inspection: ${inspectionPath}`);
    console.info(`  Manifest: ${manifestPath}`);

    const { summary } = result;
    console.info(
      `\n${String(summary.successfulEdgesRaw)} extracted (${String(summary.successfulEdgesUsable)} usable), ${String(summary.deduplicatedMentionCount)} mentions (${String(summary.usableMentionCount)} usable)`,
    );
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
