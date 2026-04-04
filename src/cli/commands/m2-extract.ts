import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type { CachePolicy } from "../../domain/types.js";
import { preScreenResultsSchema } from "../../domain/types.js";
import { runM2Extraction } from "../../pipeline/m2-extract.js";
import {
  toM2InspectionArtifact,
  toM2Json,
  toM2Markdown,
} from "../../reporting/m2-extraction-report.js";
import { createDefaultAdapters } from "../../retrieval/fulltext-fetch.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
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
  let output = "data/m2-extraction";
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
      "Usage: m2-extract --pre-screen <path> --seed-doi <doi> [--output <dir>] [--force-refresh]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { preScreenPath, seedDoi, output, forceRefresh };
}

export async function runM2ExtractCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);
  const database = openDatabase(config.databasePath);

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

    console.info(`M2 extraction for: ${family.resolvedSeedPaper.title}`);
    console.info(`  ${String(family.edges.length)} edges to process\n`);

    const cachePolicy: CachePolicy = args.forceRefresh
      ? "force_refresh"
      : "prefer_cache";
    const adapters = {
      fullText: createDefaultAdapters(
        config.providerBaseUrls.grobid,
        config.openAlexEmail,
      ),
      biorxivBaseUrl: config.providerBaseUrls.bioRxiv,
      cache: {
        db: database,
        cachePolicy,
      },
    };

    const result = await runM2Extraction(family, adapters);

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_m2-extraction-results.json`);
    const mdPath = resolve(outputDir, `${stamp}_m2-extraction-report.md`);
    const inspectPath = resolve(outputDir, `${stamp}_m2-inspection.md`);

    writeFileSync(jsonPath, toM2Json(result), "utf8");
    writeFileSync(mdPath, toM2Markdown(result), "utf8");
    writeFileSync(inspectPath, toM2InspectionArtifact(result), "utf8");
    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "m2-extraction-results",
      generator: "m2-extract",
      sourceArtifacts: [args.preScreenPath],
      relatedArtifacts: [mdPath, inspectPath],
    });

    console.info(`\nResults written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Markdown: ${mdPath}`);
    console.info(`  Inspection: ${inspectPath}`);
    console.info(`  Manifest: ${manifestPath}`);

    const { summary } = result;
    console.info(
      `\n${String(summary.successfulEdgesRaw)} extracted (${String(summary.successfulEdgesUsable)} usable), ${String(summary.deduplicatedMentionCount)} mentions (${String(summary.usableMentionCount)} usable)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
