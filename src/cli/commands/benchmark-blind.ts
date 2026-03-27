import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { calibrationSetSchema } from "../../domain/types.js";
import { createBlindCalibrationSet } from "../../benchmark/workflow.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): { input: string; output: string } {
  let input: string | undefined;
  let output = "data/benchmark";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && i + 1 < argv.length) {
      input = argv[i + 1]!;
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!input) {
    console.error(
      "Usage: benchmark:blind --input <calibration.json> [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { input, output };
}

export function runBenchmarkBlindCommand(argv: string[]): void {
  const args = parseArgs(argv);

  try {
    const calibration = loadJsonArtifact(
      args.input,
      calibrationSetSchema,
      "calibration set",
    );
    const blindSet = createBlindCalibrationSet(calibration);

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_benchmark-blind.json`);
    writeFileSync(jsonPath, JSON.stringify(blindSet, null, 2), "utf8");

    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "benchmark-blind",
      generator: "benchmark:blind",
      sourceArtifacts: [args.input],
    });

    console.info(`Blind benchmark written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Manifest: ${manifestPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
