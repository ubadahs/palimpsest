import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { diffCalibrationSets } from "../../benchmark/workflow.js";
import { benchmarkDiffResultSchema } from "../../benchmark/types.js";
import { calibrationSetSchema } from "../../domain/types.js";
import { toBenchmarkDiffMarkdown } from "../../reporting/benchmark-diff-report.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  base: string;
  candidate: string;
  output: string;
} {
  let base: string | undefined;
  let candidate: string | undefined;
  let output = "data/benchmark";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base" && i + 1 < argv.length) {
      base = argv[i + 1]!;
      i++;
    } else if (arg === "--candidate" && i + 1 < argv.length) {
      candidate = argv[i + 1]!;
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!base || !candidate) {
    console.error(
      "Usage: benchmark:diff --base <base.json> --candidate <candidate.json> [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { base, candidate, output };
}

export function runBenchmarkDiffCommand(argv: string[]): void {
  const args = parseArgs(argv);

  try {
    const base = loadJsonArtifact(
      args.base,
      calibrationSetSchema,
      "base adjudication set",
    );
    const candidate = loadJsonArtifact(
      args.candidate,
      calibrationSetSchema,
      "candidate adjudication set",
    );

    const diff = benchmarkDiffResultSchema.parse(
      diffCalibrationSets(base, candidate),
    );

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_benchmark-diff.json`);
    const mdPath = resolve(outputDir, `${stamp}_benchmark-diff.md`);

    writeFileSync(jsonPath, JSON.stringify(diff, null, 2), "utf8");
    writeFileSync(mdPath, toBenchmarkDiffMarkdown(diff), "utf8");

    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "benchmark-diff",
      generator: "benchmark:diff",
      sourceArtifacts: [args.base, args.candidate],
      relatedArtifacts: [mdPath],
    });

    console.info(`Benchmark diff written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Markdown: ${mdPath}`);
    console.info(`  Manifest: ${manifestPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
