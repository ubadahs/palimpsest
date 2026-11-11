import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import {
  buildEvaluationDataset,
  validateEvaluationDataset,
} from "../../evaluation/dataset.js";
import { createGradingRequest } from "../../evaluation/grading-requests.js";
import { createExperiment, runExperiment } from "../../evaluation/runner.js";
import { experimentConfigSchema } from "../../evaluation/config.js";
import {
  optimizationStatus,
  planJevOptimization,
} from "../../evaluation/optimization-runner.js";
import { generateEvaluationReport } from "../../evaluation/report.js";

function values(args: string[], flag: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === flag) {
      const value = args[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${flag} requires a value`);
      result.push(value);
      i++;
    }
  return result;
}
function one(args: string[], flag: string): string | undefined {
  const found = values(args, flag);
  if (found.length > 1) throw new Error(`${flag} may be supplied once`);
  return found[0];
}
function required(args: string[], flag: string): string {
  const value = one(args, flag);
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}

export async function runEvalCommand(args: string[]): Promise<void> {
  const [command, ...flags] = args;
  if (command === "dataset") {
    const { dataset, heldBackRecordIds } = buildEvaluationDataset({
      reportPaths: values(flags, "--report"),
      name: required(flags, "--name"),
      mutationsPath: one(flags, "--mutations"),
    });
    console.info(
      JSON.stringify(
        {
          datasetId: dataset.datasetId,
          cases: dataset.cases.length,
          constructedCases: dataset.cases.filter(
            (item) => item.task === "adjudication" && item.constructed,
          ).length,
          recordsHeldBackByCurrentPacketGate: heldBackRecordIds.length,
          validation: validateEvaluationDataset(dataset.datasetId),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "request") {
    const datasetId = required(flags, "--dataset");
    const request = createGradingRequest(datasetId, {
      title: required(flags, "--title"),
      purpose: required(flags, "--purpose"),
      caseIds: z
        .array(z.string())
        .parse(
          JSON.parse(
            readFileSync(required(flags, "--cases"), "utf8"),
          ) as unknown,
        ),
    });
    console.info(
      JSON.stringify(
        {
          requestId: request.requestId,
          cases: request.caseIds.length,
          gradeAt: `/evaluations/${datasetId}/grade?request=${request.requestId}`,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "validate") {
    console.info(
      JSON.stringify(
        validateEvaluationDataset(required(flags, "--dataset")),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "run") {
    loadEnv({ path: resolve(".env"), quiet: true });
    loadEnv({ path: resolve(".env.local"), quiet: true });
    const resume = one(flags, "--experiment");
    const experiment = resume
      ? resume
      : createExperiment(
          required(flags, "--dataset"),
          JSON.parse(
            readFileSync(required(flags, "--config"), "utf8"),
          ) as unknown,
        ).experimentId;
    console.info(JSON.stringify(await runExperiment(experiment), null, 2));
    return;
  }
  if (command === "plan") {
    const datasetId = required(flags, "--dataset");
    validateEvaluationDataset(datasetId);
    const config = experimentConfigSchema.parse(
      JSON.parse(readFileSync(required(flags, "--config"), "utf8")) as unknown,
    );
    console.info(
      JSON.stringify(planJevOptimization(datasetId, config), null, 2),
    );
    return;
  }
  if (command === "status") {
    console.info(
      JSON.stringify(
        optimizationStatus(required(flags, "--experiment")),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "report") {
    const result = generateEvaluationReport(required(flags, "--experiment"));
    console.info(
      JSON.stringify(
        { jsonPath: result.jsonPath, markdownPath: result.markdownPath },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(
    "Usage: eval dataset|validate|request|plan|run|status|report [options]",
  );
}
