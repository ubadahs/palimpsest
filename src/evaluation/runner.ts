import {
  withTraceOwner,
  traceOperation,
  rethrowTraceError,
} from "../telemetry/trace.js";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createLLMClient } from "../integrations/llm-client.js";
import { buildStableId } from "../shared/stable-identity.js";
import {
  CURRENT_PROMPT_REVISION,
  experimentConfigSchema,
  promptsSeen,
  type ProviderConfig,
} from "./config.js";
import { validateEvaluationDataset } from "./dataset.js";
import {
  loadExperiment,
  loadTrials,
  trialPath,
  type Experiment,
  type Trial,
} from "./experiment.js";
import { jevAccessError, withJevQuotaLocks } from "./jev-transport.js";
import {
  optimizationRequestPlan,
  plannedOptimizationTrials,
  planJevOptimization,
  runJevOptimization,
} from "./optimization-runner.js";
import {
  classifyProviderError,
  createRequestBudget,
  executeProviderCase,
  ProviderRequestError,
} from "./providers.js";
import { adjudicateFromSeedText, readsSeedText } from "./seed-text-provider.js";
import {
  atomicJson,
  evaluationRoot,
  experimentDir,
  loadDataset,
} from "./storage.js";
import type { EvaluationCase } from "./types.js";

/**
 * Provider settings that change how requests are sent or what they cost,
 * never what a model is asked, so a saved trial stays reusable across them.
 * Rerank batch size is the exception for rerank trials: it decides how many
 * passages share one request.
 */
const DELIVERY_SETTINGS = [
  "concurrency",
  "minimumRequestIntervalMs",
  "maxTransientRetries",
  "rerankBatchSize",
  "rerankMinFallbackBatchSize",
  "pricePerMillionInputTokensUsd",
  "pricePerMillionOutputTokensUsd",
  "pricePerMillionCacheReadTokensUsd",
  "instanceHourlyUsd",
  "billingWindowSeconds",
] as const satisfies readonly (keyof ProviderConfig)[];

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
    revision: Experiment["config"]["promptRevision"],
    provider: ProviderConfig,
    task: Trial["task"],
  ) =>
    buildStableId("provider-request-settings", {
      prompts: promptsSeen(revision, provider, task),
      ...Object.fromEntries(
        Object.entries(provider).filter(
          ([key]) =>
            !(DELIVERY_SETTINGS as readonly string[]).includes(key) ||
            (key === "rerankBatchSize" && task === "rerank"),
        ),
      ),
    });
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
      prior.datasetHash !== experiment.datasetHash
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
      const key = keyOf(
        saved,
        requestSettings(prior.config.promptRevision, priorProvider, saved.task),
      );
      if (!candidates.has(key)) candidates.set(key, saved);
    }
  }
  const compatible = new Map<string, Trial>();
  for (const provider of experiment.config.providers) {
    for (const trial of plannedTrials(experiment, cases).filter(
      (item) => item.providerId === provider.id,
    )) {
      const prior = candidates.get(
        keyOf(
          trial,
          requestSettings(
            experiment.config.promptRevision,
            provider,
            trial.task,
          ),
        ),
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
  for (const provider of config.providers) {
    if (provider.adjudicationEvidence !== "seed_text") continue;
    if (provider.kind !== "anthropic")
      throw new Error(
        `${provider.id}: only Anthropic providers can adjudicate from seed text`,
      );
    if (!dataset.seedDocuments?.length)
      throw new Error(
        `${provider.id} adjudicates from seed text, which this dataset does not hold; rebuild it with the current builder`,
      );
  }
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

/**
 * The first pending seed-text trial of each seed. Run alone, it writes the
 * provider's prompt cache so the trials that follow read the seed text from
 * it instead of each paying to write it.
 */
function seedTextPrimers(
  trials: readonly Trial[],
  cases: ReadonlyMap<string, EvaluationCase>,
  provider: Experiment["config"]["providers"][number],
): Trial[] {
  const primed = new Set<string>();
  return trials.filter((trial) => {
    const item = cases.get(trial.caseId)!;
    if (!readsSeedText(provider, item) || primed.has(item.seedDoi))
      return false;
    primed.add(item.seedDoi);
    return true;
  });
}

function isTerminal(status: Trial["status"]): boolean {
  return status !== "pending" && status !== "cancelled";
}

export async function runExperiment(id: string) {
  return withTraceOwner(experimentDir(id), { experimentId: id }, () =>
    traceOperation("evaluation", "experiment", { experimentId: id }, () =>
      runExperimentImpl(id),
    ),
  );
}

async function runExperimentImpl(id: string): Promise<{
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
  return withJevQuotaLocks(
    experiment.config.providers.filter((provider) => provider.kind === "jev"),
    () => runComparison(experiment),
  );
}

/** Why a provider cannot send requests yet, if it cannot. */
function providerAccessError(provider: ProviderConfig): string | undefined {
  if (provider.kind === "jev") return jevAccessError(provider);
  if (provider.kind !== "anthropic") return undefined;
  const keyEnv = provider.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  return process.env[keyEnv] ? undefined : `${provider.id}: missing ${keyEnv}`;
}

/** Runs every pending trial of a provider comparison, provider by provider. */
async function runComparison(experiment: Experiment): Promise<{
  experimentId: string;
  completed: number;
  pending: number;
  accessErrors: string[];
}> {
  const id = experiment.experimentId;
  if (experiment.config.promptRevision !== CURRENT_PROMPT_REVISION)
    throw new Error(
      `This experiment uses ${experiment.config.promptRevision}; new trials run only under ${CURRENT_PROMPT_REVISION}. Set promptRevision to ${CURRENT_PROMPT_REVISION} (or leave it out) and create a fresh experiment, which reuses every saved trial whose prompts did not change.`,
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
  const seedByDoi = new Map(
    dataset.seedDocuments?.map((document) => [document.seedDoi, document]),
  );
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
      const accessError = providerAccessError(provider);
      if (accessError) {
        accessErrors.push(accessError);
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
        provider.kind === "jev"
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
      const stopped = () => controller.signal.aborted || providerStopped;
      const runTrial = (plannedTrial: Trial): Promise<void> =>
        traceOperation(
          "evaluation",
          "trial",
          plannedTrial,
          () => runTrialImpl(plannedTrial),
          { trialId: plannedTrial.trialId, provider: provider.id },
        );
      const runTrialImpl = async (plannedTrial: Trial): Promise<void> => {
        const item = cases.get(plannedTrial.caseId)!;
        const start = performance.now();
        let outcome: Trial;
        if (
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
            const result = readsSeedText(provider, item)
              ? await adjudicateFromSeedText({
                  item,
                  seed: seedByDoi.get(item.seedDoi),
                  provider,
                  llm,
                  requestSequence: sequence,
                })
              : await executeProviderCase(
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
            rethrowTraceError(error);
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
      };
      const primers = seedTextPrimers(active, cases, provider);
      for (const trial of primers) if (!stopped()) await runTrial(trial);
      const queue = active.filter((trial) => !primers.includes(trial));
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length && !stopped())
          await runTrial(queue[cursor++]!);
      };
      await Promise.all(
        Array.from(
          { length: Math.min(provider.concurrency, queue.length) },
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
