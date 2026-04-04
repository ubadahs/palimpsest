import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { calibrationSetSchema } from "../../domain/types.js";
import { adjudicateCalibrationSet } from "../../adjudication/llm-adjudicator.js";
import { toCalibrationJson } from "../../reporting/adjudication-report.js";
import { toCalibrationSummaryMarkdown } from "../../reporting/calibration-summary.js";
import { toAgreementMarkdown } from "../../reporting/agreement-report.js";
import {
  loadJsonArtifact,
  writeArtifactManifest,
} from "../../shared/artifact-io.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): {
  calibrationPath: string;
  humanPath: string | undefined;
  model: string;
  thinking: boolean;
  output: string;
} {
  let calibrationPath: string | undefined;
  let humanPath: string | undefined;
  let model = "claude-opus-4-6";
  let thinking = false;
  let output = "data/m6-llm-adjudication";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--calibration" && i + 1 < argv.length) {
      calibrationPath = argv[i + 1];
      i++;
    } else if (arg === "--human" && i + 1 < argv.length) {
      humanPath = argv[i + 1];
      i++;
    } else if (arg === "--model" && i + 1 < argv.length) {
      model = argv[i + 1]!;
      i++;
    } else if (arg === "--thinking") {
      thinking = true;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!calibrationPath) {
    console.error(
      "Usage: m6-llm-judge --calibration <path> [--human <path>] [--model <id>] [--thinking] [--output <dir>]",
    );
    process.exitCode = 1;
    throw new Error("Missing required arguments");
  }

  return { calibrationPath, humanPath, model, thinking, output };
}

export async function runM6LlmJudgeCommand(argv: string[]): Promise<void> {
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

  try {
    const calibration = loadJsonArtifact(
      args.calibrationPath,
      calibrationSetSchema,
      "calibration set",
    );

    const activeCount = calibration.records.filter((r) => !r.excluded).length;
    console.info(
      `M6 LLM adjudication for: ${calibration.resolvedSeedPaperTitle}`,
    );
    console.info(
      `  Model: ${args.model}${args.thinking ? " (extended thinking)" : ""}`,
    );
    console.info(`  Records: ${String(activeCount)} active\n`);

    const llmResult = await adjudicateCalibrationSet(
      calibration,
      {
        apiKey: config.anthropicApiKey,
        model: args.model,
        useExtendedThinking: args.thinking,
      },
      (i, total) => {
        console.info(`  [${String(i)}/${String(total)}] adjudicating...`);
      },
    );

    const outputDir = resolve(process.cwd(), args.output);
    mkdirSync(outputDir, { recursive: true });

    const stamp = nextRunStamp(outputDir);
    const jsonPath = resolve(outputDir, `${stamp}_llm-calibration.json`);
    const summaryPath = resolve(outputDir, `${stamp}_llm-summary.md`);

    writeFileSync(jsonPath, toCalibrationJson(llmResult), "utf8");
    writeFileSync(summaryPath, toCalibrationSummaryMarkdown(llmResult), "utf8");

    const relatedArtifacts = [summaryPath];

    console.info(`\nLLM results written to:`);
    console.info(`  JSON: ${jsonPath}`);
    console.info(`  Summary: ${summaryPath}`);

    if (args.humanPath) {
      const humanSet = loadJsonArtifact(
        args.humanPath,
        calibrationSetSchema,
        "human adjudication set",
      );

      const agreementPath = resolve(outputDir, `${stamp}_agreement-report.md`);
      writeFileSync(
        agreementPath,
        toAgreementMarkdown(humanSet, llmResult),
        "utf8",
      );
      relatedArtifacts.push(agreementPath);
      console.info(`  Agreement: ${agreementPath}`);
    }

    const manifestPath = writeArtifactManifest(jsonPath, {
      artifactType: "m6-llm-calibration",
      generator: "m6-llm-judge",
      sourceArtifacts: args.humanPath
        ? [args.calibrationPath, args.humanPath]
        : [args.calibrationPath],
      relatedArtifacts,
      model: args.model,
    });
    console.info(`  Manifest: ${manifestPath}`);

    const verdicts = llmResult.records.filter((r) => !r.excluded && r.verdict);
    const supported = verdicts.filter((r) => r.verdict === "supported").length;
    const partial = verdicts.filter(
      (r) => r.verdict === "partially_supported",
    ).length;
    const notSupported = verdicts.filter(
      (r) => r.verdict === "not_supported",
    ).length;

    console.info(
      `\n${String(verdicts.length)} verdicts: ${String(supported)} supported, ${String(partial)} partial, ${String(notSupported)} not supported`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
