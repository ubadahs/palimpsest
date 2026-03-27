import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FamilyEvidenceResult } from "../../domain/types.js";
import { sampleCalibrationSet } from "../../adjudication/sample-calibration.js";
import {
  toCalibrationJson,
  toCalibrationMarkdown,
} from "../../reporting/adjudication-report.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  evidencePath: string;
  targetSize: number;
  output: string;
} {
  let evidencePath: string | undefined;
  let targetSize = 40;
  let output = "data/m5-adjudication";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--evidence" && i + 1 < argv.length) {
      evidencePath = argv[i + 1];
      i++;
    } else if (arg === "--target-size" && i + 1 < argv.length) {
      targetSize = parseInt(argv[i + 1]!, 10);
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!evidencePath) {
    console.error(
      "Usage: m5-adjudicate --evidence <path> [--target-size 40] [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { evidencePath, targetSize, output };
}

export function runM5AdjudicateCommand(argv: string[]): void {
  const args = parseArgs(argv);

  const evidence = JSON.parse(
    readFileSync(args.evidencePath, "utf8"),
  ) as FamilyEvidenceResult;

  const title = evidence.resolvedSeedPaperTitle;
  console.info(`M5 adjudication for: ${title}`);
  console.info(`  Target size: ${String(args.targetSize)}`);

  const calibrationSet = sampleCalibrationSet(
    evidence,
    undefined,
    args.targetSize,
  );

  const outputDir = resolve(process.cwd(), args.output);
  mkdirSync(outputDir, { recursive: true });

  const stamp = nextRunStamp(outputDir);
  const jsonPath = resolve(outputDir, `${stamp}_calibration-set.json`);
  const mdPath = resolve(outputDir, `${stamp}_calibration-worksheet.md`);

  writeFileSync(jsonPath, toCalibrationJson(calibrationSet), "utf8");
  writeFileSync(mdPath, toCalibrationMarkdown(calibrationSet), "utf8");

  console.info(`\nResults written to:`);
  console.info(`  JSON: ${jsonPath}`);
  console.info(`  Worksheet: ${mdPath}`);

  const byMode = new Map<string, number>();
  for (const r of calibrationSet.records) {
    const count = byMode.get(r.evaluationMode) ?? 0;
    byMode.set(r.evaluationMode, count + 1);
  }

  console.info(`\n${String(calibrationSet.records.length)} tasks sampled:`);
  for (const [mode, count] of byMode) {
    console.info(`  ${mode}: ${String(count)}`);
  }

  if (calibrationSet.samplingStrategy.oversampled.length > 0) {
    console.info(
      `  Oversampled: ${calibrationSet.samplingStrategy.oversampled.join(", ")}`,
    );
  }
}
