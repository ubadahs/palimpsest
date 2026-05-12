import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { auditSampleSchema } from "../../domain/types.js";
import { adjudicateAuditSample } from "../../adjudication/llm-adjudicator.js";
import { DEFAULT_FIDELITY_VECTOR_MODEL } from "../../adjudication/fidelity-vector-scorer.js";
import { createTrackedCliProgressReporter } from "../progress.js";
import { toAgreementMarkdown } from "../../reporting/agreement-report.js";
import { loadJsonArtifact } from "../../shared/artifact-io.js";
import { writeAdjudicationArtifacts } from "../stage-artifact-writers.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  auditSamplePath: string;
  humanPath: string | undefined;
  model: string;
  thinking: boolean;
  output: string;
  fidelityVectorTrace: boolean;
  fidelityVectorSamples: number;
  fidelityVectorModel: string;
  fidelityVectorTemperature: number;
  adjudicationMode: "categorical" | "vector_first";
  vectorFirstInitialSamples: number;
  vectorFirstMaxSamples: number;
  vectorFirstModel: string;
  vectorFirstTemperature: number;
  vectorFirstConcurrency: number;
} {
  let auditSamplePath: string | undefined;
  let humanPath: string | undefined;
  let model = "claude-opus-4-6";
  let thinking = true;
  let output = "data/adjudication";
  let fidelityVectorTrace = false;
  let fidelityVectorSamples = 3;
  let fidelityVectorModel = DEFAULT_FIDELITY_VECTOR_MODEL;
  let fidelityVectorTemperature = 0.7;
  let adjudicationMode: "categorical" | "vector_first" = "categorical";
  let vectorFirstInitialSamples = 1;
  let vectorFirstMaxSamples = 3;
  let vectorFirstModel = DEFAULT_FIDELITY_VECTOR_MODEL;
  let vectorFirstTemperature = 0.7;
  let vectorFirstConcurrency = 2;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      (arg === "--audit-sample" || arg === "--calibration") &&
      i + 1 < argv.length
    ) {
      auditSamplePath = argv[i + 1];
      i++;
    } else if (arg === "--human" && i + 1 < argv.length) {
      humanPath = argv[i + 1];
      i++;
    } else if (arg === "--model" && i + 1 < argv.length) {
      model = argv[i + 1]!;
      i++;
    } else if (arg === "--thinking") {
      thinking = true;
    } else if (arg === "--no-thinking") {
      thinking = false;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    } else if (arg === "--fidelity-vector-trace") {
      fidelityVectorTrace = true;
    } else if (arg === "--no-fidelity-vector-trace") {
      fidelityVectorTrace = false;
    } else if (arg === "--fidelity-vector-samples" && i + 1 < argv.length) {
      fidelityVectorSamples = Math.min(
        10,
        Math.max(1, parseInt(argv[i + 1]!, 10)),
      );
      i++;
    } else if (arg === "--fidelity-vector-model" && i + 1 < argv.length) {
      fidelityVectorModel = argv[i + 1]!;
      i++;
    } else if (arg === "--fidelity-vector-temperature" && i + 1 < argv.length) {
      fidelityVectorTemperature = Math.min(
        2,
        Math.max(0, Number(argv[i + 1]!)),
      );
      i++;
    } else if (arg === "--adjudication-mode" && i + 1 < argv.length) {
      const val = argv[i + 1]!;
      if (val === "categorical" || val === "vector_first") {
        adjudicationMode = val;
      } else {
        console.error(
          `Invalid --adjudication-mode value "${val}". Use "categorical" or "vector_first".`,
        );
        process.exitCode = 1;
        throw new Error("Invalid --adjudication-mode");
      }
      i++;
    } else if (
      arg === "--vector-first-initial-samples" &&
      i + 1 < argv.length
    ) {
      vectorFirstInitialSamples = Math.min(
        10,
        Math.max(1, parseInt(argv[i + 1]!, 10)),
      );
      i++;
    } else if (arg === "--vector-first-max-samples" && i + 1 < argv.length) {
      vectorFirstMaxSamples = Math.min(
        10,
        Math.max(1, parseInt(argv[i + 1]!, 10)),
      );
      i++;
    } else if (arg === "--vector-first-model" && i + 1 < argv.length) {
      vectorFirstModel = argv[i + 1]!;
      i++;
    } else if (arg === "--vector-first-temperature" && i + 1 < argv.length) {
      vectorFirstTemperature = Math.min(2, Math.max(0, Number(argv[i + 1]!)));
      i++;
    } else if (arg === "--vector-first-concurrency" && i + 1 < argv.length) {
      vectorFirstConcurrency = Math.max(1, parseInt(argv[i + 1]!, 10));
      i++;
    }
  }

  if (!auditSamplePath) {
    console.error(
      "Usage: adjudicate --audit-sample <path> [--human <path>] [--model <id>] [--thinking] [--output <dir>] [--fidelity-vector-trace]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return {
    auditSamplePath,
    humanPath,
    model,
    thinking,
    output,
    fidelityVectorTrace,
    fidelityVectorSamples,
    fidelityVectorModel,
    fidelityVectorTemperature,
    adjudicationMode,
    vectorFirstInitialSamples,
    vectorFirstMaxSamples,
    vectorFirstModel,
    vectorFirstTemperature,
    vectorFirstConcurrency,
  };
}

export async function runAdjudicateCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);

  if (!config.anthropicApiKey) {
    console.error(
      "ANTHROPIC_API_KEY not set in environment. Add it to .env.local",
    );
    process.exitCode = 1;
    return;
  }

  const { progress, reportCliFailure } =
    createTrackedCliProgressReporter("adjudicate");

  try {
    progress.startStep("load_active_records", {
      detail: "Loading active audit records for adjudication.",
    });
    const auditSample = loadJsonArtifact(
      args.auditSamplePath,
      auditSampleSchema,
      "audit sample",
    );

    const activeCount = auditSample.records.filter((r) => !r.excluded).length;
    progress.completeStep("load_active_records", {
      detail: `${String(activeCount)} active records ready for adjudication`,
    });
    console.info(`LLM adjudication for: ${auditSample.resolvedSeedPaperTitle}`);
    console.info(
      `  Model: ${args.model}${args.thinking ? " (extended thinking)" : ""}`,
    );
    console.info(`  Adjudication mode: ${args.adjudicationMode}`);
    if (args.fidelityVectorTrace) {
      console.info(
        `  Fidelity vector trace: ${String(args.fidelityVectorSamples)} samples, ${args.fidelityVectorModel}, temperature ${String(args.fidelityVectorTemperature)}`,
      );
    }
    if (args.adjudicationMode === "vector_first") {
      console.info(
        `  Vector-first: ${String(args.vectorFirstInitialSamples)} initial / ${String(args.vectorFirstMaxSamples)} max samples, ${args.vectorFirstModel}, temperature ${String(args.vectorFirstTemperature)}, concurrency ${String(args.vectorFirstConcurrency)}`,
      );
    }
    console.info(`  Records: ${String(activeCount)} active\n`);

    progress.startStep("adjudicate_records", {
      detail: "Adjudicating audit records with the configured model.",
      ...(activeCount > 0 ? { current: 0, total: activeCount } : {}),
    });
    const llmResult = await adjudicateAuditSample(
      auditSample,
      {
        apiKey: config.anthropicApiKey,
        model: args.model,
        useExtendedThinking: args.thinking,
        adjudicationMode: args.adjudicationMode,
        fidelityVectorTrace: {
          enabled: args.fidelityVectorTrace,
          sampleCount: args.fidelityVectorSamples,
          model: args.fidelityVectorModel,
          temperature: args.fidelityVectorTemperature,
          concurrency: 2,
        },
        vectorFirst: {
          initialSamples: args.vectorFirstInitialSamples,
          maxSamples: args.vectorFirstMaxSamples,
          model: args.vectorFirstModel,
          temperature: args.vectorFirstTemperature,
          concurrency: args.vectorFirstConcurrency,
        },
      },
      (i, total) => {
        console.info(`  [${String(i)}/${String(total)}] adjudicating...`);
        progress.updateStep("adjudicate_records", {
          detail: `Adjudicating record ${String(i)} of ${String(total)}`,
          current: i,
          total,
        });
      },
    );
    progress.completeStep("adjudicate_records", {
      detail: `${String(activeCount)} records adjudicated`,
      ...(activeCount > 0 ? { current: activeCount, total: activeCount } : {}),
    });
    progress.startStep("capture_verdicts_and_rationales", {
      detail: "Capturing verdicts and rationales in the audit sample dataset.",
    });
    progress.completeStep("capture_verdicts_and_rationales", {
      detail: `${String(llmResult.records.filter((record) => !record.excluded && record.verdict != null).length)} records now carry verdicts`,
    });

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const verdicts = llmResult.records.filter((r) => !r.excluded && r.verdict);
    const supported = verdicts.filter((r) => r.verdict === "supported").length;
    const partial = verdicts.filter(
      (r) => r.verdict === "partially_supported",
    ).length;
    const notSupported = verdicts.filter(
      (r) => r.verdict === "not_supported",
    ).length;
    progress.startStep("summarize_verdict_distribution", {
      detail: "Summarizing the verdict distribution.",
    });
    progress.completeStep("summarize_verdict_distribution", {
      detail: `${String(supported)} supported, ${String(partial)} partial, ${String(notSupported)} not supported`,
    });

    progress.startStep("write_final_outputs", {
      detail: "Writing final adjudication outputs.",
    });
    const agreementMarkdown = args.humanPath
      ? toAgreementMarkdown(
          loadJsonArtifact(
            args.humanPath,
            auditSampleSchema,
            "human adjudication set",
          ),
          llmResult,
        )
      : undefined;
    const { jsonPath, summaryPath, agreementPath, manifestPath } =
      writeAdjudicationArtifacts({
        outputRoot: outputDir,
        stamp,
        result: llmResult,
        sourceArtifacts: args.humanPath
          ? [args.auditSamplePath, args.humanPath]
          : [args.auditSamplePath],
        model: args.model,
        ...(agreementMarkdown ? { agreementMarkdown } : {}),
      });
    console.info(`\nLLM results written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Summary: ${summaryPath}`);
    if (agreementPath) {
      console.info(`  Agreement: ${agreementPath}`);
    }
    console.info(`  Manifest: ${manifestPath}`);
    progress.completeStep("write_final_outputs", {
      detail: "Final JSON, summary, and manifest written.",
    });

    console.info(
      `\n${String(verdicts.length)} verdicts: ${String(supported)} supported, ${String(partial)} partial, ${String(notSupported)} not supported`,
    );
  } catch (error) {
    reportCliFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
