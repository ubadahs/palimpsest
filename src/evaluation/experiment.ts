/** A saved experiment and its trials, as every runner and report reads them. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { experimentConfigSchema } from "./config.js";
import { experimentDir } from "./storage.js";
import { evaluationTaskSchema } from "./types.js";

export const trialSchema = z.object({
  trialId: z.string(),
  experimentId: z.string(),
  caseId: z.string(),
  task: evaluationTaskSchema,
  providerId: z.string(),
  requestedModel: z.string(),
  repetition: z.number().int().positive(),
  caseHash: z.string(),
  providerHash: z.string(),
  status: z.enum([
    "pending",
    "success",
    "unsupported",
    "oversized_context",
    "invalid_response",
    "provider_failure",
    "cancelled",
  ]),
  prediction: z.unknown().optional(),
  calls: z.array(z.unknown()),
  diagnostics: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  completedAt: z.string().optional(),
  reusedFrom: z
    .object({ experimentId: z.string(), trialId: z.string() })
    .optional(),
  variantId: z.string().optional(),
  requestIds: z.array(z.string()).optional(),
});
export type Trial = z.infer<typeof trialSchema>;
export const experimentSchema = z.object({
  schemaVersion: z.literal("evaluation-experiment-v1"),
  experimentId: z.string(),
  datasetId: z.string(),
  datasetHash: z.string(),
  config: experimentConfigSchema,
  createdAt: z.string(),
});
export type Experiment = z.infer<typeof experimentSchema>;

export function loadExperiment(id: string): Experiment {
  return experimentSchema.parse(
    JSON.parse(
      readFileSync(join(experimentDir(id), "experiment.json"), "utf8"),
    ) as unknown,
  );
}

export function trialPath(experimentId: string, trialId: string): string {
  return join(experimentDir(experimentId), "trials", `${trialId}.json`);
}

export function loadTrials(experimentId: string): Trial[] {
  const dir = join(experimentDir(experimentId), "trials");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      trialSchema.parse(
        JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown,
      ),
    );
}
