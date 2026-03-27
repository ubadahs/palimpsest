import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import type { FamilyClassificationResult } from "../../domain/types.js";
import {
  toEvidenceJson,
  toEvidenceMarkdown,
} from "../../reporting/evidence-report.js";
import { retrieveEvidence } from "../../retrieval/evidence-retrieval.js";
import {
  createDefaultAdapters,
  fetchFullText,
} from "../../retrieval/fulltext-fetch.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  classificationPath: string;
  output: string;
} {
  let classificationPath: string | undefined;
  let output = "data/m4-evidence";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--classification" && i + 1 < argv.length) {
      classificationPath = argv[i + 1];
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!classificationPath) {
    console.error(
      "Usage: m4-evidence --classification <path> [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { classificationPath, output };
}

export async function runM4EvidenceCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);

  const classification = JSON.parse(
    readFileSync(args.classificationPath, "utf8"),
  ) as FamilyClassificationResult;

  const title = classification.resolvedSeedPaperTitle;
  console.info(`M4 evidence retrieval for: ${title}`);

  const seedPacket = classification.packets.find((p) => p.citedPaper.doi);
  const citedPaperDoi = seedPacket?.citedPaper.doi;
  const citedPaperTitle = seedPacket?.citedPaper.title ?? "";

  let citedPaperFullText: string | undefined;

  if (citedPaperDoi) {
    console.info(`  Fetching cited paper full text (DOI: ${citedPaperDoi})...`);

    const adapters = createDefaultAdapters(config.openAlexEmail);
    const fakeResolvedPaper = {
      id: citedPaperDoi,
      doi: citedPaperDoi,
      title: citedPaperTitle,
      authors: [] as string[],
      abstract: undefined,
      source: "openalex" as const,
      openAccessUrl: undefined,
      fullTextStatus: { status: "available" as const, source: "pmc_xml" },
      paperType: undefined,
      referencedWorksCount: undefined,
      publicationYear: undefined,
    };

    const result = await fetchFullText(
      fakeResolvedPaper,
      config.providerBaseUrls.bioRxiv,
      adapters,
    );

    if (result.ok) {
      citedPaperFullText = result.data.content;
      console.info(
        `  Retrieved ${String(citedPaperFullText.length)} chars (${result.data.format})`,
      );
    } else {
      console.info(`  Could not fetch cited paper: ${result.error}`);
    }
  }

  const evidenceResult = retrieveEvidence(classification, citedPaperFullText);

  const outputDir = resolve(process.cwd(), args.output);
  mkdirSync(outputDir, { recursive: true });

  const stamp = nextRunStamp(outputDir);
  const jsonPath = resolve(outputDir, `${stamp}_evidence-results.json`);
  const mdPath = resolve(outputDir, `${stamp}_evidence-report.md`);

  writeFileSync(jsonPath, toEvidenceJson(evidenceResult), "utf8");
  writeFileSync(mdPath, toEvidenceMarkdown(evidenceResult), "utf8");

  console.info(`\nResults written to:`);
  console.info(`  JSON: ${jsonPath}`);
  console.info(`  Markdown: ${mdPath}`);

  const s = evidenceResult.summary;
  console.info(
    `\n${String(s.tasksWithEvidence)}/${String(s.totalTasks)} tasks matched evidence (${String(s.totalEvidenceSpans)} spans)`,
  );
}
