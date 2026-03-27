import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyCalibrationDeltas } from "../../benchmark/workflow.js";
import { adjudicationDeltaSetSchema } from "../../benchmark/types.js";
import { calibrationSetSchema } from "../../domain/types.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  base: string;
  delta: string;
  output: string;
} {
  let base: string | undefined;
  let delta: string | undefined;
  let output = "data/benchmark";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base" && i + 1 < argv.length) {
      base = argv[i + 1]!;
      i++;
    } else if (arg === "--delta" && i + 1 < argv.length) {
      delta = argv[i + 1]!;
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!base || !delta) {
    console.error(
      "Usage: benchmark:apply --base <base.json> --delta <delta.json> [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { base, delta, output };
}

export function runBenchmarkApplyCommand(argv: string[]): void {
  const args = parseArgs(argv);

  try {
    const base = loadJsonArtifact(
      args.base,
      calibrationSetSchema,
      "base adjudication set",
    );
    const deltaSet = loadJsonArtifact(
      args.delta,
      adjudicationDeltaSetSchema,
      "adjudication delta set",
    );

    const applied = applyCalibrationDeltas(base, deltaSet);

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_benchmark-applied.json`);
    writeFileSync(jsonPath, JSON.stringify(applied, null, 2), "utf8");

    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "benchmark-applied",
      generator: "benchmark:apply",
      sourceArtifacts: [args.base, args.delta],
    });

    console.info(`Applied benchmark dataset written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Manifest: ${manifestPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
