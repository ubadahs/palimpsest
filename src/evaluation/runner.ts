import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createLLMClient } from "../integrations/llm-client.js";
import { buildStableId } from "../shared/stable-identity.js";
import { experimentConfigSchema } from "./config.js";
import { validateEvaluationDataset } from "./dataset.js";
import {
  classifyProviderError,
  createRequestBudget,
  executeProviderCase,
  ProviderRequestError,
} from "./providers.js";
import {
  atomicJson,
  evaluationRoot,
  experimentDir,
  loadDataset,
} from "./storage.js";
import { evaluationTaskSchema, type EvaluationCase } from "./types.js";
import {
  optimizationRequestPlan,
  plannedOptimizationTrials,
  planJevOptimization,
  runJevOptimization,
  withQuotaLock,
} from "./optimization-runner.js";

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

function trialPath(experimentId: string, trialId: string): string {
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

function plannedTrials(
  experiment: Experiment,
  cases: EvaluationCase[],
): Trial[] {
  if (experiment.config.optimization)
    return plannedOptimizationTrials(
      experiment.experimentId,
      experiment.datasetId,
      experiment.config,
    );
  return experiment.config.providers.flatMap((provider) =>
    cases
      .filter(
        (item) =>
          experiment.config.tasks.includes(item.task) &&
          (!provider.tasks || provider.tasks.includes(item.task)),
      )
      .flatMap((item) =>
        Array.from({ length: experiment.config.repetitions }, (_, index) => {
          const repetition = index + 1;
          return {
            trialId: buildStableId("trial", {
              experimentId: experiment.experimentId,
              caseId: item.caseId,
              providerId: provider.id,
              repetition,
            }),
            experimentId: experiment.experimentId,
            caseId: item.caseId,
            task: item.task,
            providerId: provider.id,
            requestedModel: provider.model,
            repetition,
            caseHash: buildStableId("case-input", item),
            providerHash: buildStableId("provider-settings", provider),
            status: "pending" as const,
            calls: [],
          };
        }),
      ),
  );
}

function compatibleSavedTrials(
  experiment: Experiment,
  cases: EvaluationCase[],
): Map<string, Trial> {
  const candidates = new Map<string, Trial>();
  const root = join(evaluationRoot(), "experiments");
  if (!existsSync(root)) return candidates;
  const requestSettings = (
    provider: Experiment["config"]["providers"][number],
    task: Trial["task"],
  ) => {
    const {
      concurrency,
      minimumRequestIntervalMs,
      maxTransientRetries,
      rerankBatchSize,
      rerankMinFallbackBatchSize,
      ...settings
    } = provider;
    void concurrency;
    void minimumRequestIntervalMs;
    void maxTransientRetries;
    void rerankMinFallbackBatchSize;
    return buildStableId("provider-request-settings", {
      ...settings,
      ...(task === "rerank" && rerankBatchSize != null
        ? { rerankBatchSize }
        : {}),
    });
  };
  const keyOf = (trial: Trial, requestHash: string) =>
    [
      trial.caseId,
      trial.caseHash,
      trial.providerId,
      requestHash,
      trial.task,
      trial.repetition,
    ].join("\0");
  for (const entry of readdirSync(root, { withFileTypes: true }).filter(
    (item) => item.isDirectory() && item.name !== experiment.experimentId,
  )) {
    const path = join(root, entry.name, "experiment.json");
    if (!existsSync(path)) continue;
    const prior = loadExperiment(entry.name);
    if (
      prior.datasetId !== experiment.datasetId ||
      prior.datasetHash !== experiment.datasetHash ||
      prior.config.promptRevision !== experiment.config.promptRevision
    )
      continue;
    const priorPlan = new Map(
      plannedTrials(prior, cases).map((trial) => [trial.trialId, trial]),
    );
    const priorProviders = new Map(
      prior.config.providers.map((provider) => [provider.id, provider]),
    );
    for (const saved of loadTrials(prior.experimentId)) {
      const expected = priorPlan.get(saved.trialId);
      if (
        !expected ||
        saved.caseHash !== expected.caseHash ||
        saved.providerHash !== expected.providerHash ||
        saved.requestedModel !== expected.requestedModel ||
        ![
          "success",
          "unsupported",
          "oversized_context",
          "invalid_response",
        ].includes(saved.status)
      )
        continue;
      const priorProvider = priorProviders.get(saved.providerId);
      if (!priorProvider) continue;
      const key = keyOf(saved, requestSettings(priorProvider, saved.task));
      if (!candidates.has(key)) candidates.set(key, saved);
    }
  }
  const compatible = new Map<string, Trial>();
  for (const provider of experiment.config.providers) {
    for (const trial of plannedTrials(experiment, cases).filter(
      (item) => item.providerId === provider.id,
    )) {
      const prior = candidates.get(
        keyOf(trial, requestSettings(provider, trial.task)),
      );
      if (prior) compatible.set(trial.trialId, prior);
    }
  }
  return compatible;
}

export function createExperiment(
  datasetId: string,
  configInput: unknown,
): Experiment {
  const dataset = loadDataset(datasetId);
  validateEvaluationDataset(datasetId);
  const config = experimentConfigSchema.parse(configInput);
  if (
    new Set(config.providers.map((provider) => provider.id)).size !==
    config.providers.length
  )
    throw new Error("Provider IDs must be unique");
  if (config.optimization) planJevOptimization(datasetId, config);
  const experimentId = buildStableId("experiment", { datasetId, config });
  const dir = experimentDir(experimentId);
  if (existsSync(join(dir, "experiment.json")))
    return loadExperiment(experimentId);
  const experiment: Experiment = {
    schemaVersion: "evaluation-experiment-v1",
    experimentId,
    datasetId,
    datasetHash: buildStableId("dataset-contents", dataset),
    config,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(join(dir, "trials"), { recursive: true });
  atomicJson(join(dir, "experiment.json"), experiment);
  if (config.optimization)
    atomicJson(
      join(dir, "optimization-plan.json"),
      optimizationRequestPlan(datasetId, config),
    );
  const reusable = config.optimization
    ? new Map<string, Trial>()
    : compatibleSavedTrials(experiment, dataset.cases);
  for (const trial of plannedTrials(experiment, dataset.cases)) {
    const prior = reusable.get(trial.trialId);
    atomicJson(
      trialPath(experimentId, trial.trialId),
      prior
        ? {
            ...prior,
            trialId: trial.trialId,
            experimentId,
            providerHash: trial.providerHash,
            reusedFrom: prior.reusedFrom ?? {
              experimentId: prior.experimentId,
              trialId: prior.trialId,
            },
          }
        : trial,
    );
  }
  return experiment;
}

function isTerminal(status: Trial["status"]): boolean {
  return status !== "pending" && status !== "cancelled";
}

export async function runExperiment(id: string): Promise<{
  experimentId: string;
  completed: number;
  pending: number;
  accessErrors: string[];
}> {
  const experiment = loadExperiment(id);
  if (experiment.config.optimization) {
    const dataset = loadDataset(experiment.datasetId);
    validateEvaluationDataset(experiment.datasetId);
    if (experiment.datasetHash !== buildStableId("dataset-contents", dataset))
      throw new Error("Experiment dataset changed");
    return runJevOptimization(id, experiment.datasetId, experiment.config);
  }
  const jev = experiment.config.providers.find(
    (provider) => provider.kind === "jev",
  );
  return jev
    ? withQuotaLock(jev, () => runLegacyExperiment(experiment))
    : runLegacyExperiment(experiment);
}

async function runLegacyExperiment(experiment: Experiment): Promise<{
  experimentId: string;
  completed: number;
  pending: number;
  accessErrors: string[];
}> {
  const id = experiment.experimentId;
  if (experiment.config.promptRevision !== "evaluation-prompts-v2")
    throw new Error(
      "This experiment used an older evaluation prompt revision; create a fresh experiment to avoid mixing methods",
    );
  const dataset = loadDataset(experiment.datasetId);
  validateEvaluationDataset(experiment.datasetId);
  if (experiment.datasetHash !== buildStableId("dataset-contents", dataset))
    throw new Error("Experiment dataset changed");
  const planned = plannedTrials(experiment, dataset.cases);
  const saved = new Map(loadTrials(id).map((trial) => [trial.trialId, trial]));
  if (saved.size !== planned.length)
    throw new Error("Experiment trial plan changed");
  for (const trial of planned) {
    const previous = saved.get(trial.trialId);
    if (
      !previous ||
      previous.caseHash !== trial.caseHash ||
      previous.providerHash !== trial.providerHash ||
      previous.requestedModel !== trial.requestedModel
    )
      throw new Error(`Incompatible saved trial ${trial.trialId}`);
  }
  const cases = new Map(dataset.cases.map((item) => [item.caseId, item]));
  const controller = new AbortController();
  const started = Date.now();
  const budgetPath = join(experimentDir(id), "request-budget.json");
  const previousBudget = existsSync(budgetPath)
    ? z
        .object({
          requestCount: z.number().int().nonnegative(),
          activeMs: z.number().nonnegative(),
        })
        .parse(JSON.parse(readFileSync(budgetPath, "utf8")) as unknown)
    : {
        requestCount: [...saved.values()].reduce(
          (sum, trial) => sum + (trial.reusedFrom ? 0 : trial.calls.length),
          0,
        ),
        activeMs: 0,
      };
  let requestCount = previousBudget.requestCount;
  const accessErrors: string[] = [];
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    for (const provider of experiment.config.providers) {
      if (controller.signal.aborted) break;
      let active = planned.filter(
        (trial) =>
          trial.providerId === provider.id &&
          !isTerminal(saved.get(trial.trialId)!.status),
      );
      if (provider.kind === "jev" || provider.kind === "djev") {
        const keyName =
          provider.apiKeyEnv ??
          (provider.kind === "jev" ? "TYPESAFE_API_KEY" : "DJEV_API_KEY");
        if (provider.kind === "jev" && !process.env[keyName]) {
          accessErrors.push(`${provider.id}: missing ${keyName}`);
          continue;
        }
        if (
          provider.kind === "djev" &&
          !(
            provider.endpoint ??
            (provider.endpointEnv
              ? process.env[provider.endpointEnv]
              : undefined)
          )
        ) {
          accessErrors.push(
            `${provider.id}: missing endpoint or ${provider.endpointEnv ?? "endpointEnv"}`,
          );
          continue;
        }
      }
      if (
        provider.kind === "anthropic" &&
        !process.env[provider.apiKeyEnv ?? "ANTHROPIC_API_KEY"]
      ) {
        accessErrors.push(
          `${provider.id}: missing ${provider.apiKeyEnv ?? "ANTHROPIC_API_KEY"}`,
        );
        continue;
      }
      let providerStopped = false;
      let providerRequestCount = 0;
      const countRequest = () => {
        if (controller.signal.aborted || providerStopped)
          throw new Error("Experiment cancelled");
        if (
          experiment.config.maxDurationSeconds != null &&
          previousBudget.activeMs + Date.now() - started >=
            experiment.config.maxDurationSeconds * 1000
        ) {
          controller.abort();
          throw new Error("Experiment duration limit reached");
        }
        if (
          experiment.config.maxRequests != null &&
          requestCount >= experiment.config.maxRequests
        ) {
          controller.abort();
          throw new Error("Experiment request limit reached");
        }
        requestCount++;
        atomicJson(budgetPath, {
          requestCount,
          activeMs: previousBudget.activeMs + Date.now() - started,
        });
        providerRequestCount++;
        return providerRequestCount;
      };
      const budget =
        provider.kind === "jev" || provider.kind === "djev"
          ? createRequestBudget(provider, countRequest)
          : undefined;
      const llm =
        provider.kind === "anthropic"
          ? createLLMClient({
              apiKey: process.env[provider.apiKeyEnv ?? "ANTHROPIC_API_KEY"]!,
              defaultModel: provider.model,
              forceRefresh: true,
            })
          : undefined;
      let cursor = 0;
      const worker = async () => {
        while (
          cursor < active.length &&
          !controller.signal.aborted &&
          !providerStopped
        ) {
          const plannedTrial = active[cursor++]!;
          const item = cases.get(plannedTrial.caseId)!;
          const start = performance.now();
          let outcome: Trial;
          if (
            (provider.kind === "jev" && item.task === "span") ||
            (provider.kind === "bm25" && item.task !== "rerank") ||
            (provider.kind === "rules" && item.task !== "role")
          ) {
            outcome = {
              ...plannedTrial,
              status: "unsupported",
              error: `${provider.kind} does not support ${item.task}`,
              durationMs: 0,
              completedAt: new Date().toISOString(),
            };
          } else {
            try {
              const sequence =
                provider.kind === "anthropic" ? countRequest() : undefined;
              const result = await executeProviderCase(
                item,
                provider,
                budget,
                llm,
                controller.signal,
                sequence,
              );
              outcome = {
                ...plannedTrial,
                status: "success",
                prediction: result.prediction,
                calls: result.calls,
                ...(result.diagnostics !== undefined
                  ? { diagnostics: result.diagnostics }
                  : {}),
                durationMs: performance.now() - start,
                completedAt: new Date().toISOString(),
              };
            } catch (error) {
              const classified = classifyProviderError(error);
              if (classified.fatal) providerStopped = true;
              outcome = {
                ...plannedTrial,
                status:
                  controller.signal.aborted ||
                  (providerStopped &&
                    classified.message === "Error: Experiment cancelled")
                    ? "cancelled"
                    : classified.status,
                error: classified.message,
                ...(error instanceof ProviderRequestError
                  ? {
                      calls: error.partialCalls,
                      ...(error.diagnostics !== undefined
                        ? { diagnostics: error.diagnostics }
                        : {}),
                    }
                  : {}),
                durationMs: performance.now() - start,
                completedAt: new Date().toISOString(),
              };
            }
          }
          atomicJson(trialPath(id, outcome.trialId), outcome);
          saved.set(outcome.trialId, outcome);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(provider.concurrency, active.length) },
          () => worker(),
        ),
      );
      active = active.filter(
        (trial) => !isTerminal(saved.get(trial.trialId)!.status),
      );
    }
  } finally {
    process.removeListener("SIGINT", stop);
    atomicJson(budgetPath, {
      requestCount,
      activeMs: previousBudget.activeMs + Date.now() - started,
    });
  }
  const final = [...saved.values()];
  const summary = {
    experimentId: id,
    completed: final.filter((trial) => isTerminal(trial.status)).length,
    pending: final.filter((trial) => !isTerminal(trial.status)).length,
    accessErrors,
  };
  atomicJson(join(experimentDir(id), "execution-summary.json"), {
    ...summary,
    recordedAt: new Date().toISOString(),
    requestCount,
  });
  return summary;
}
