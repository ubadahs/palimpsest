import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  summarizeBenchmarkCandidates,
  type BenchmarkCandidateInput,
} from "../../benchmark/workflow.js";
import { benchmarkSummarySchema } from "../../benchmark/types.js";
import { calibrationSetSchema } from "../../domain/types.js";
import { toBenchmarkSummaryMarkdown } from "../../reporting/benchmark-summary-report.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
  writeJsonArtifact,
} from "../../shared/artifact-io.js";
import { nextRunStamp } from "../run-stamp.js";

type ParsedCandidateArg = {
  label: string;
  path: string;
};

type ParsedArgs = {
  base: string;
  candidates: ParsedCandidateArg[];
  output: string;
};

function parseCandidateArg(value: string): ParsedCandidateArg {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `Invalid --candidate value "${value}". Expected <label>=<path>.`,
    );
  }

  return {
    label: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  let base: string | undefined;
  const candidates: ParsedCandidateArg[] = [];
  let output = "data/benchmark";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base" && i + 1 < argv.length) {
      base = argv[i + 1]!;
      i++;
    } else if (arg === "--candidate" && i + 1 < argv.length) {
      candidates.push(parseCandidateArg(argv[i + 1]!));
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!base || candidates.length === 0) {
    console.error(
      "Usage: benchmark:summary --base <base.json> --candidate <label=path> [--candidate <label=path> ...] [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { base, candidates, output };
}

function resolveCandidateInputs(
  candidates: ParsedCandidateArg[],
): BenchmarkCandidateInput[] {
  const seenLabels = new Set<string>();

  return candidates.map((candidate) => {
    if (seenLabels.has(candidate.label)) {
      throw new Error(`Duplicate benchmark summary label: ${candidate.label}`);
    }
    seenLabels.add(candidate.label);

    const candidatePath = resolve(process.cwd(), candidate.path);
    return {
      label: candidate.label,
      path: candidatePath,
      set: loadJsonArtifact(
        candidatePath,
        calibrationSetSchema,
        `candidate adjudication set (${candidate.label})`,
      ),
    };
  });
}

export function runBenchmarkSummaryCommand(argv: string[]): void {
  const args = parseArgs(argv);

  try {
    const basePath = resolve(process.cwd(), args.base);
    const base = loadJsonArtifact(
      basePath,
      calibrationSetSchema,
      "base adjudication set",
    );
    const candidates = resolveCandidateInputs(args.candidates);

    const summary = benchmarkSummarySchema.parse(
      summarizeBenchmarkCandidates(basePath, base, candidates),
    );

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_benchmark-summary.json`);
    const mdPath = resolve(outputDir, `${stamp}_benchmark-summary.md`);

    writeJsonArtifact(jsonPath, summary);
    writeFileSync(mdPath, toBenchmarkSummaryMarkdown(summary), "utf8");

    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "benchmark-summary",
      generator: "benchmark:summary",
      sourceArtifacts: [
        basePath,
        ...candidates.map((candidate) => candidate.path),
      ],
      relatedArtifacts: [mdPath],
    });

    console.info("Benchmark summary written to:");
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Markdown: ${mdPath}`);
    console.info(`  Manifest: ${manifestPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
