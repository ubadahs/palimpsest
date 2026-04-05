import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { familyEvidenceResultSchema } from "../../domain/types.js";
import { sampleCalibrationSet } from "../../adjudication/sample-calibration.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import {
  toCalibrationJson,
  toCalibrationMarkdown,
} from "../../reporting/adjudication-report.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
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
  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("m5-adjudicate");

  try {
    progress.startStep("collect_eligible_tasks", {
      detail:
        "Loading evidence-backed tasks eligible for calibration sampling.",
    });
    const evidence = loadJsonArtifact(
      args.evidencePath,
      familyEvidenceResultSchema,
      "m4 evidence results",
    );
    const eligibleTasks = evidence.edges.reduce(
      (count, edge) =>
        count +
        edge.tasks.filter(
          (task) => task.evidenceRetrievalStatus !== "not_attempted",
        ).length,
      0,
    );
    progress.completeStep("collect_eligible_tasks", {
      detail: `${String(eligibleTasks)} eligible tasks collected`,
    });

    const title = evidence.resolvedSeedPaperTitle;
    console.info(`M5 adjudication for: ${title}`);
    console.info(`  Target size: ${String(args.targetSize)}`);

    progress.startStep("prioritize_edge_cases", {
      detail: "Prioritizing oversampled edge cases for calibration.",
    });
    progress.startStep("allocate_mode_balanced_sample", {
      detail: "Allocating a balanced sample across evaluation modes.",
    });
    const calibrationSet = sampleCalibrationSet(
      evidence,
      undefined,
      args.targetSize,
    );
    progress.completeStep("prioritize_edge_cases", {
      detail:
        calibrationSet.samplingStrategy.oversampled.length > 0
          ? `Oversampled ${calibrationSet.samplingStrategy.oversampled.join(", ")}`
          : "No extra oversampling tags were needed",
    });
    progress.completeStep("allocate_mode_balanced_sample", {
      detail: `${String(calibrationSet.records.length)} records selected toward a target of ${String(args.targetSize)}`,
    });
    progress.startStep("build_calibration_records", {
      detail: "Building calibration-ready records from sampled tasks.",
    });
    progress.completeStep("build_calibration_records", {
      detail: `${String(calibrationSet.records.length)} calibration records prepared`,
    });

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_calibration-set.json`);
    const mdPath = resolve(outputDir, `${stamp}_calibration-worksheet.md`);

    writeFileSync(jsonPath, toCalibrationJson(calibrationSet), "utf8");
    writeFileSync(mdPath, toCalibrationMarkdown(calibrationSet), "utf8");
    progress.startStep("write_sampling_outputs", {
      detail: "Writing the calibration set and worksheet artifacts.",
    });
    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "m5-calibration-set",
      generator: "m5-adjudicate",
      sourceArtifacts: [args.evidencePath],
      relatedArtifacts: [mdPath],
    });
    progress.completeStep("write_sampling_outputs", {
      detail: "Calibration set, worksheet, and manifest written.",
    });

    console.info(`\nResults written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Worksheet: ${mdPath}`);
    console.info(`  Manifest: ${manifestPath}`);

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
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
