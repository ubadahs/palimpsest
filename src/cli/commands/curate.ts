import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { familyEvidenceResultSchema } from "../../domain/types.js";
import { sampleAuditSet } from "../../adjudication/sample-audit.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import { writeAuditSampleArtifacts } from "../stage-artifact-writers.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  evidencePath: string;
  targetSize: number;
  output: string;
} {
  let evidencePath: string | undefined;
  let targetSize = 20;
  let output = "data/curation";

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
      "Usage: curate --evidence <path> [--target-size 20] [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { evidencePath, targetSize, output };
}

export function runCurateCommand(argv: string[]): void {
  const args = parseArgs(argv);
  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("curate");

  try {
    progress.startStep("collect_eligible_tasks", {
      detail: "Loading evidence-backed tasks eligible for audit sampling.",
    });
    const evidence = loadJsonArtifact(
      args.evidencePath,
      familyEvidenceResultSchema,
      "evidence results",
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
    console.info(`Curation for: ${title}`);
    console.info(`  Target size: ${String(args.targetSize)}`);

    progress.startStep("prioritize_edge_cases", {
      detail: "Prioritizing oversampled edge cases for audit sampling.",
    });
    progress.startStep("allocate_mode_balanced_sample", {
      detail: "Allocating a balanced sample across evaluation modes.",
    });
    const auditSample = sampleAuditSet(evidence, undefined, args.targetSize);
    progress.completeStep("prioritize_edge_cases", {
      detail:
        auditSample.samplingStrategy.oversampled.length > 0
          ? `Oversampled ${auditSample.samplingStrategy.oversampled.join(", ")}`
          : "No extra oversampling tags were needed",
    });
    progress.completeStep("allocate_mode_balanced_sample", {
      detail: `${String(auditSample.records.length)} records selected toward a target of ${String(args.targetSize)}`,
    });
    progress.startStep("build_audit_records", {
      detail: "Building audit-ready records from sampled tasks.",
    });
    progress.completeStep("build_audit_records", {
      detail: `${String(auditSample.records.length)} audit records prepared`,
    });

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const { jsonPath, mdPath, manifestPath } = writeAuditSampleArtifacts({
      outputRoot: outputDir,
      stamp,
      result: auditSample,
      sourceArtifacts: [args.evidencePath],
    });
    progress.startStep("write_sampling_outputs", {
      detail: "Writing the audit sample and worksheet artifacts.",
    });
    progress.completeStep("write_sampling_outputs", {
      detail: "Audit sample, worksheet, and manifest written.",
    });

    console.info(`\nResults written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Worksheet: ${mdPath}`);
    console.info(`  Manifest: ${manifestPath}`);

    const byMode = new Map<string, number>();
    for (const r of auditSample.records) {
      const count = byMode.get(r.evaluationMode) ?? 0;
      byMode.set(r.evaluationMode, count + 1);
    }

    console.info(`\n${String(auditSample.records.length)} tasks sampled:`);
    for (const [mode, count] of byMode) {
      console.info(`  ${mode}: ${String(count)}`);
    }

    if (auditSample.samplingStrategy.oversampled.length > 0) {
      console.info(
        `  Oversampled: ${auditSample.samplingStrategy.oversampled.join(", ")}`,
      );
    }
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
