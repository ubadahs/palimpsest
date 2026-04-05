import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  familyExtractionResultSchema,
  preScreenResultsSchema,
  type EdgeClassification,
  type PreScreenEdge,
  type StudyMode,
} from "../../domain/types.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { buildPackets } from "../../classification/build-packets.js";
import {
  toClassificationJson,
  toClassificationMarkdown,
} from "../../reporting/classification-report.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  extractionPath: string;
  preScreenPath: string;
  studyMode: StudyMode;
  output: string;
} {
  let extractionPath: string | undefined;
  let preScreenPath: string | undefined;
  let studyMode: StudyMode = "all_functions_census";
  let output = "data/m3-classification";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--extraction" && i + 1 < argv.length) {
      extractionPath = argv[i + 1];
      i++;
    } else if (arg === "--pre-screen" && i + 1 < argv.length) {
      preScreenPath = argv[i + 1];
      i++;
    } else if (arg === "--study-mode" && i + 1 < argv.length) {
      studyMode = argv[i + 1] as StudyMode;
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!extractionPath || !preScreenPath) {
    console.error(
      "Usage: m3-classify --extraction <path> --pre-screen <path> [--study-mode <mode>] [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { extractionPath, preScreenPath, studyMode, output };
}

export function runM3ClassifyCommand(argv: string[]): void {
  const args = parseArgs(argv);
  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("m3-classify");

  try {
    progress.startStep("load_extracted_mentions", {
      detail: "Loading extraction and pre-screen artifacts.",
    });
    const extraction = loadJsonArtifact(
      args.extractionPath,
      familyExtractionResultSchema,
      "m2 extraction results",
    );

    const preScreenFamilies = loadJsonArtifact(
      args.preScreenPath,
      preScreenResultsSchema,
      "pre-screen results",
    );
    progress.completeStep("load_extracted_mentions", {
      detail: `${String(extraction.edgeResults.length)} extracted edges loaded`,
    });

    const family = preScreenFamilies.find(
      (f) => f.seed.doi.toLowerCase() === extraction.seed.doi.toLowerCase(),
    );

    const edgeClassifications: Record<string, EdgeClassification> = {};
    const preScreenEdges: Record<string, PreScreenEdge> = {};
    if (family) {
      for (const edge of family.edges) {
        edgeClassifications[edge.citingPaperId] = edge.classification;
        preScreenEdges[edge.citingPaperId] = edge;
      }
    }

    const title = extraction.resolvedSeedPaper?.title ?? extraction.seed.doi;
    console.info(`M3 classification for: ${title}`);
    console.info(`  Study mode: ${args.studyMode}`);

    progress.startStep("classify_citation_roles", {
      detail: "Classifying citation roles from extracted mentions.",
    });
    const result = buildPackets(
      extraction,
      args.studyMode,
      edgeClassifications,
      preScreenEdges,
    );
    progress.completeStep("classify_citation_roles", {
      detail: `${String(result.summary.literatureStructure.totalMentions)} mentions classified`,
    });
    progress.startStep("derive_evaluation_modes", {
      detail: "Deriving evaluation modes from citation roles and modifiers.",
    });
    progress.completeStep("derive_evaluation_modes", {
      detail: `${String(result.summary.literatureStructure.totalTasks)} evaluation tasks derived`,
    });
    progress.startStep("assemble_task_packets", {
      detail: "Assembling task packets for downstream evidence retrieval.",
    });
    progress.completeStep("assemble_task_packets", {
      detail: `${String(result.packets.length)} packets assembled`,
    });
    progress.startStep("summarize_literature_structure", {
      detail: "Summarizing task structure and manual-review cases.",
    });
    progress.completeStep("summarize_literature_structure", {
      detail: `${String(result.summary.literatureStructure.manualReviewTaskCount)} manual-review tasks identified`,
    });

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_classification-results.json`);
    const mdPath = resolve(outputDir, `${stamp}_classification-report.md`);

    writeFileSync(jsonPath, toClassificationJson(result), "utf8");
    writeFileSync(mdPath, toClassificationMarkdown(result), "utf8");
    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "m3-classification-results",
      generator: "m3-classify",
      sourceArtifacts: [args.extractionPath, args.preScreenPath],
      relatedArtifacts: [mdPath],
    });

    console.info(`\nResults written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Markdown: ${mdPath}`);
    console.info(`  Manifest: ${manifestPath}`);

    const es = result.summary.extractionState;
    const ls = result.summary.literatureStructure;
    console.info(
      `\nExtraction: ${String(es.extracted)} extracted, ${String(es.failed)} failed, ${String(es.skipped)} skipped`,
    );
    console.info(
      `Structure: ${String(ls.totalTasks)} tasks from ${String(ls.edgesWithMentions)} edges (${String(ls.totalMentions)} mentions)`,
    );
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
