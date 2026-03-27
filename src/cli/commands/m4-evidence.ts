import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { familyClassificationResultSchema } from "../../domain/types.js";
import { resolvePaperByDoi } from "../../integrations/paper-resolver.js";
import { resolveCitedPaperSource } from "../../pipeline/m4-evidence.js";
import {
  toEvidenceJson,
  toEvidenceMarkdown,
} from "../../reporting/evidence-report.js";
import { retrieveEvidence } from "../../retrieval/evidence-retrieval.js";
import {
  createDefaultAdapters,
  fetchFullText,
} from "../../retrieval/fulltext-fetch.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
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

  try {
    const classification = loadJsonArtifact(
      args.classificationPath,
      familyClassificationResultSchema,
      "m3 classification results",
    );

    const title = classification.resolvedSeedPaperTitle;
    console.info(`M4 evidence retrieval for: ${title}`);

    const adapters = createDefaultAdapters(config.openAlexEmail);
    const citedPaperMaterialized = await resolveCitedPaperSource(classification, {
      resolveByDoi: (doi) =>
        resolvePaperByDoi(doi, {
          openAlexBaseUrl: config.providerBaseUrls.openAlex,
          semanticScholarBaseUrl: config.providerBaseUrls.semanticScholar,
          openAlexEmail: config.openAlexEmail,
          semanticScholarApiKey: config.semanticScholarApiKey,
        }),
      fetchFullText: (paper) =>
        fetchFullText(paper, config.providerBaseUrls.bioRxiv, adapters),
    });

    if (citedPaperMaterialized.citedPaperSource.resolutionStatus !== "resolved") {
      console.info(
        `  Could not resolve cited paper: ${citedPaperMaterialized.citedPaperSource.resolutionError ?? "unknown error"}`,
      );
    } else if (
      citedPaperMaterialized.citedPaperSource.fetchStatus !== "retrieved"
    ) {
      console.info(
        `  Cited paper full text unavailable: ${citedPaperMaterialized.citedPaperSource.fetchError ?? citedPaperMaterialized.citedPaperSource.fetchStatus}`,
      );
    } else if (citedPaperMaterialized.citedPaperFullText) {
      console.info(
        `  Retrieved ${String(citedPaperMaterialized.citedPaperFullText.length)} chars (${citedPaperMaterialized.citedPaperSource.fullTextFormat})`,
      );
    }

    const evidenceResult = retrieveEvidence(
      classification,
      citedPaperMaterialized.citedPaperSource,
      citedPaperMaterialized.citedPaperFullText,
    );

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_evidence-results.json`);
    const mdPath = resolve(outputDir, `${stamp}_evidence-report.md`);

    writeFileSync(jsonPath, toEvidenceJson(evidenceResult), "utf8");
    writeFileSync(mdPath, toEvidenceMarkdown(evidenceResult), "utf8");
    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "m4-evidence-results",
      generator: "m4-evidence",
      sourceArtifacts: [args.classificationPath],
      relatedArtifacts: [mdPath],
    });

    console.info(`\nResults written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Markdown: ${mdPath}`);
    console.info(`  Manifest: ${manifestPath}`);

    const s = evidenceResult.summary;
    console.info(
      `\n${String(s.tasksWithEvidence)}/${String(s.totalTasks)} tasks matched evidence (${String(s.totalEvidenceSpans)} spans)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
