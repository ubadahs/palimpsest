import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildStableId } from "../shared/stable-identity.js";
import type { ExperimentConfig, ProviderConfig } from "./config.js";
import {
  jevAttemptSchema,
  jevResultSchema,
  type JevAttempt,
  type JevRequestSpec,
  type JevResult,
  type JevVariant,
} from "./optimization-contract.js";
import {
  buildJevFixtureRequestSpecs,
  buildJevRequestSpecs,
  parseJevResult,
  validateJevFixtureResult,
} from "./jev-tasks.js";
import {
  atomicJson,
  evaluationRoot,
  experimentDir,
  loadDataset,
  readJson,
} from "./storage.js";
import type { EvaluationCase } from "./types.js";
import {
  fetchJev,
  jevEndpoint,
  jevQuotaGroup,
  type JevTransport,
} from "./jev-transport.js";
import type { Trial } from "./runner.js";

type OptimizationConfig = NonNullable<ExperimentConfig["optimization"]>;
type Phase = JevVariant["phase"];
const phases: Phase[] = ["fixture", "fallback", "main", "comparison", "probe"];

type Job = {
  spec: JevRequestSpec;
  provider: ProviderConfig;
  variant: JevVariant;
  phase: Phase;
  repetition: number;
  caseInput?: EvaluationCase;
  trialId?: string;
};

function middleSix(
  cases: EvaluationCase[],
  variant: JevVariant,
  provider: ProviderConfig,
): Set<string> {
  const rerank = cases
    .filter((item) => item.task === "rerank")
    .sort(
      (a, b) =>
        JSON.stringify(
          buildJevRequestSpecs(a, variant, provider).map((spec) => spec.body),
        ).length -
          JSON.stringify(
            buildJevRequestSpecs(b, variant, provider).map((spec) => spec.body),
          ).length || a.caseId.localeCompare(b.caseId),
    );
  if (rerank.length <= 6) return new Set(rerank.map((item) => item.caseId));
  return new Set(
    Array.from(
      { length: 6 },
      (_, index) =>
        rerank[Math.round((index * (rerank.length - 1)) / 5)]!.caseId,
    ),
  );
}

function selectedOptimizationCases(
  cases: EvaluationCase[],
  variant: JevVariant,
  provider: ProviderConfig,
): EvaluationCase[] {
  const selected = variant.caseIds ? new Set(variant.caseIds) : undefined;
  const six =
    variant.task === "rerank" ? middleSix(cases, variant, provider) : undefined;
  if (selected) {
    const missing = [...selected].filter(
      (id) =>
        !cases.some((item) => item.caseId === id && item.task === variant.task),
    );
    if (missing.length)
      throw new Error(
        `Unknown case IDs in ${variant.id}: ${missing.join(", ")}`,
      );
  }
  return cases
    .filter(
      (item) =>
        item.task === variant.task &&
        (selected
          ? selected.has(item.caseId)
          : variant.phase === "fallback"
            ? item.task === "role" && item.deterministicRole === "unclear"
            : variant.task === "rerank"
              ? six!.has(item.caseId)
              : true),
    )
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
}

function jobsFor(datasetId: string, config: ExperimentConfig): Job[] {
  const optimization = config.optimization;
  if (!optimization) throw new Error("Missing optimization settings");
  const dataset = loadDataset(datasetId);
  const jobs: Job[] = [];
  for (const provider of config.providers) {
    if (provider.kind !== "jev")
      throw new Error("Optimization experiments run Jev providers only");
    for (const variant of optimization.variants) {
      if (variant.phase === "fixture") {
        const specs = buildJevFixtureRequestSpecs(provider);
        for (const spec of specs)
          jobs.push({
            spec,
            provider,
            variant,
            phase: "fixture",
            repetition: 1,
          });
        continue;
      }
      for (const caseInput of selectedOptimizationCases(
        dataset.cases,
        variant,
        provider,
      )) {
        const specs = buildJevRequestSpecs(caseInput, variant, provider);
        for (
          let repetition = 1;
          repetition <= variant.repetition;
          repetition++
        ) {
          const trialId = buildStableId("optimization-trial", {
            datasetId,
            providerId: provider.id,
            variantId: variant.id,
            caseId: caseInput.caseId,
            repetition,
          });
          for (const spec of specs) {
            const requestId = buildStableId("optimization-request", {
              trialId,
              batchIndex: spec.batchIndex,
              requestHash: spec.requestHash,
            });
            jobs.push({
              spec: { ...spec, requestId },
              provider,
              variant,
              phase: variant.phase,
              repetition,
              caseInput,
              trialId,
            });
          }
        }
      }
    }
  }
  return jobs.sort(
    (a, b) =>
      phases.indexOf(a.phase) - phases.indexOf(b.phase) ||
      a.variant.id.localeCompare(b.variant.id) ||
      a.spec.caseId.localeCompare(b.spec.caseId) ||
      a.spec.batchIndex - b.spec.batchIndex,
  );
}

export function optimizationRequestPlan(
  datasetId: string,
  config: ExperimentConfig,
) {
  return {
    schemaVersion: "evaluation-jev-plan-v1" as const,
    requests: jobsFor(datasetId, config).map((job) => ({
      requestId: job.spec.requestId,
      requestHash: job.spec.requestHash,
      variantId: job.spec.variantId,
      caseId: job.spec.caseId,
      providerId: job.provider.id,
      phase: job.phase,
      repetition: job.repetition,
      batchIndex: job.spec.batchIndex,
    })),
  };
}

export function plannedOptimizationTrials(
  experimentId: string,
  datasetId: string,
  config: ExperimentConfig,
): Trial[] {
  const groups = new Map<string, Job[]>();
  for (const job of jobsFor(datasetId, config)) {
    if (!job.trialId) continue;
    const group = groups.get(job.trialId) ?? [];
    group.push(job);
    groups.set(job.trialId, group);
  }
  return [...groups].map(([trialId, group]) => {
    const first = group[0]!;
    const input = first.caseInput!;
    return {
      trialId,
      experimentId,
      caseId: input.caseId,
      task: input.task,
      providerId: first.provider.id,
      requestedModel: first.provider.model,
      repetition: first.repetition,
      caseHash: buildStableId("case-input", input),
      providerHash: buildStableId("scientific-provider-settings", {
        endpoint: jevEndpoint(first.provider),
        model: first.provider.model,
        inferenceSettings: first.provider.inferenceSettings,
      }),
      status: "pending",
      calls: [],
      variantId: first.variant.id,
      requestIds: group.map((job) => job.spec.requestId),
    };
  });
}

function validateConfig(config: ExperimentConfig): OptimizationConfig {
  const optimization = config.optimization;
  if (!optimization) throw new Error("Optimization config is required");
  if (
    new Set(optimization.variants.map((variant) => variant.id)).size !==
    optimization.variants.length
  )
    throw new Error("Optimization variant IDs must be unique");
  if (config.providers.some((provider) => provider.kind !== "jev"))
    throw new Error(
      "Optimization may only dispatch Jev providers; baselines must be references",
    );
  if (config.tasks.some((task) => task !== "role" && task !== "rerank"))
    throw new Error("Optimization tasks must be role and rerank only");
  for (const variant of optimization.variants) {
    if (!config.tasks.includes(variant.task))
      throw new Error(`${variant.id} task is not selected`);
    if (variant.task === "role" && variant.layout !== "role-v2")
      throw new Error(`${variant.id} has an invalid role layout`);
    if (variant.task === "rerank" && variant.layout === "role-v2")
      throw new Error(`${variant.id} has an invalid rerank layout`);
  }
  return optimization;
}

export function planJevOptimization(
  datasetId: string,
  config: ExperimentConfig,
) {
  const optimization = validateConfig(config);
  const targetDataset = loadDataset(datasetId);
  for (const reference of optimization.baselineReferences) {
    const path = join(experimentDir(reference.experimentId), "experiment.json");
    if (!existsSync(path))
      throw new Error(`Missing baseline experiment ${reference.experimentId}`);
    const source = JSON.parse(readFileSync(path, "utf8")) as {
      datasetId?: string;
      config?: { providers?: { id: string }[] };
    };
    if (
      !source.config?.providers?.some(
        (item) => item.id === reference.providerId,
      )
    )
      throw new Error(
        `Incompatible baseline ${reference.experimentId}/${reference.providerId}`,
      );
    if (!source.datasetId)
      throw new Error(`Baseline ${reference.experimentId} has no dataset`);
    const baselineDataset = loadDataset(source.datasetId);
    if (
      JSON.stringify(baselineDataset.sources) !==
      JSON.stringify(targetDataset.sources)
    )
      throw new Error(
        `Baseline ${reference.experimentId} has different source lineage`,
      );
  }
  const jobs = jobsFor(datasetId, config);
  return {
    datasetId,
    selectedCases: [
      ...new Set(
        jobs.filter((job) => job.caseInput).map((job) => job.spec.caseId),
      ),
    ],
    variants: optimization.variants.map((variant) => ({
      id: variant.id,
      phase: variant.phase,
      task: variant.task,
      layout: variant.layout,
      batchSize: variant.batchSize ?? null,
      caseCount: new Set(
        jobs
          .filter((job) => job.variant.id === variant.id && job.caseInput)
          .map((job) => job.spec.caseId),
      ).size,
      plannedRequests: jobs.filter((job) => job.variant.id === variant.id)
        .length,
    })),
    baselineReferences: optimization.baselineReferences,
    plannedRequests: jobs.length,
    limits: {
      maxAttempts: optimization.maxAttempts,
      maxActiveSeconds: optimization.maxActiveSeconds,
      requestTimeoutMs: optimization.requestTimeoutMs,
      concurrency: optimization.concurrency,
      minimumRequestIntervalMs: optimization.minimumRequestIntervalMs,
      probeMinimumRequestIntervalMs: optimization.probeMinimumRequestIntervalMs,
      retryBaseDelayMs: optimization.retryBaseDelayMs,
      ...(optimization.stopAfterConsecutiveServiceFailures
        ? {
            stopAfterConsecutiveServiceFailures:
              optimization.stopAfterConsecutiveServiceFailures,
          }
        : {}),
    },
  };
}

function attemptDir(id: string): string {
  return join(experimentDir(id), "attempts");
}
function resultDir(id: string): string {
  return join(experimentDir(id), "results");
}
function attemptPath(id: string, attemptId: string): string {
  return join(attemptDir(id), `${attemptId}.json`);
}
function resultPath(id: string, requestId: string): string {
  return join(resultDir(id), `${requestId}.json`);
}
function loadAttempts(id: string): JevAttempt[] {
  const dir = attemptDir(id);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readJson(join(dir, name), jevAttemptSchema))
    : [];
}
function loadResult(id: string, requestId: string): JevResult | undefined {
  const path = resultPath(id, requestId);
  return existsSync(path) ? readJson(path, jevResultSchema) : undefined;
}

export function withQuotaLock<T>(
  provider: ProviderConfig,
  run: () => Promise<T>,
): Promise<T> {
  const lockDir = join(evaluationRoot(), "locks");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(
    lockDir,
    `${buildStableId("jev-quota", jevQuotaGroup(provider))}.lock`,
  );
  try {
    const current = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(current) || current <= 0)
      throw new Error("Jev quota lock is in use or unreadable");
    try {
      process.kill(current, 0);
      throw new Error(`Jev quota group is in use by process ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      try {
        unlinkSync(lockPath);
      } catch {
        /* stale lock removal is harmless */
      }
    });
}

function withQuotaLocks<T>(
  providers: ProviderConfig[],
  run: () => Promise<T>,
): Promise<T> {
  const unique = [
    ...new Map(
      providers.map((provider) => [jevQuotaGroup(provider), provider]),
    ).entries(),
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, provider]) => provider);
  return unique.reduceRight<() => Promise<T>>(
    (next, provider) => () => withQuotaLock(provider, next),
    run,
  )();
}

function fairQueue(jobs: Job[]): Job[] {
  const byCase = new Map<string, Job[]>();
  for (const job of jobs) {
    const key = `${job.provider.id}\0${job.spec.caseId}`;
    const queue = byCase.get(key) ?? [];
    queue.push(job);
    byCase.set(key, queue);
  }
  const result: Job[] = [];
  while ([...byCase.values()].some((queue) => queue.length))
    for (const queue of byCase.values()) {
      const job = queue.shift();
      if (job) result.push(job);
    }
  return result;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Cancelled"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function transient(status?: number): boolean {
  return (
    status === 429 ||
    status === 529 ||
    (status != null && status >= 500 && status <= 599)
  );
}
function fatal(status?: number): boolean {
  return status === 401 || status === 402 || status === 403;
}
function safeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "Request timeout";
  if (error instanceof Error && error.name === "AbortError")
    return "Request interrupted";
  return error instanceof Error ? error.name : "Request failed";
}

export function optimizationStatus(id: string) {
  const attempts = loadAttempts(id);
  const resultFiles = existsSync(resultDir(id))
    ? readdirSync(resultDir(id)).filter((name) => name.endsWith(".json")).length
    : 0;
  const planPath = join(experimentDir(id), "optimization-plan.json");
  const plan = existsSync(planPath)
    ? (JSON.parse(readFileSync(planPath, "utf8")) as {
        requests: { requestId: string; variantId: string; phase: Phase }[];
      })
    : undefined;
  const complete = (requestId: string) => existsSync(resultPath(id, requestId));
  const results = plan
    ? plan.requests.filter((request) => complete(request.requestId)).length
    : resultFiles;
  const progress = (key: "phase" | "variantId") =>
    Object.fromEntries(
      [...new Set(plan?.requests.map((request) => request[key]) ?? [])].map(
        (name) => {
          const requests = plan!.requests.filter(
            (request) => request[key] === name,
          );
          const completed = requests.filter((request) =>
            complete(request.requestId),
          ).length;
          return [
            name,
            {
              planned: requests.length,
              completed,
              pending: requests.length - completed,
            },
          ];
        },
      ),
    );
  const budgetPath = join(experimentDir(id), "optimization-budget.json");
  const budget = existsSync(budgetPath)
    ? (JSON.parse(readFileSync(budgetPath, "utf8")) as { activeMs: number })
    : { activeMs: 0 };
  return {
    experimentId: id,
    attempts: attempts.length,
    completedRequests: results,
    plannedRequests: plan?.requests.length ?? null,
    pendingRequests: plan ? Math.max(0, plan.requests.length - results) : null,
    byPhase: progress("phase"),
    byVariant: progress("variantId"),
    inFlight: attempts.filter((attempt) => attempt.status === "in_flight")
      .length,
    failedAttempts: attempts.filter(
      (attempt) =>
        attempt.status !== "success" && attempt.status !== "in_flight",
    ).length,
    activeSeconds: Math.ceil(budget.activeMs / 1000),
  };
}

export async function runJevOptimization(
  id: string,
  datasetId: string,
  config: ExperimentConfig,
  transport: JevTransport = fetchJev,
): Promise<{
  experimentId: string;
  completed: number;
  pending: number;
  accessErrors: string[];
}> {
  const optimization = validateConfig(config);
  const jobs = jobsFor(datasetId, config);
  if (!config.providers.length) throw new Error("No Jev provider configured");
  return withQuotaLocks(config.providers, async () => {
    const frozenPlanPath = join(experimentDir(id), "optimization-plan.json");
    if (!existsSync(frozenPlanPath))
      throw new Error("Missing frozen optimization request plan");
    const frozenPlan = JSON.parse(
      readFileSync(frozenPlanPath, "utf8"),
    ) as unknown;
    if (
      JSON.stringify(frozenPlan) !==
      JSON.stringify(optimizationRequestPlan(datasetId, config))
    )
      throw new Error(
        "Optimization request plan changed; refusing to dispatch",
      );
    const missingKeys =
      transport === fetchJev
        ? config.providers.filter(
            (provider) =>
              !process.env[provider.apiKeyEnv ?? "TYPESAFE_API_KEY"],
          )
        : [];
    if (missingKeys.length)
      return {
        experimentId: id,
        completed: jobs.filter((job) => loadResult(id, job.spec.requestId))
          .length,
        pending: jobs.filter((job) => !loadResult(id, job.spec.requestId))
          .length,
        accessErrors: missingKeys.map(
          (provider) =>
            `${provider.id}: missing ${provider.apiKeyEnv ?? "TYPESAFE_API_KEY"}`,
        ),
      };
    mkdirSync(attemptDir(id), { recursive: true });
    mkdirSync(resultDir(id), { recursive: true });
    const priorAttempts = loadAttempts(id);
    const plannedTrials = plannedOptimizationTrials(id, datasetId, config);
    const trialsById = new Map(
      plannedTrials.map((trial) => [trial.trialId, trial]),
    );
    for (const trial of plannedTrials) {
      const path = join(experimentDir(id), "trials", `${trial.trialId}.json`);
      if (!existsSync(path))
        throw new Error(`Missing planned trial ${trial.trialId}`);
      const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<Trial>;
      if (
        saved.caseHash !== trial.caseHash ||
        saved.providerHash !== trial.providerHash ||
        JSON.stringify(saved.requestIds) !== JSON.stringify(trial.requestIds)
      )
        throw new Error(
          `Incompatible saved optimization trial ${trial.trialId}`,
        );
    }
    const trialJobs = new Map<string, Job[]>();
    for (const job of jobs)
      if (job.trialId) {
        const list = trialJobs.get(job.trialId) ?? [];
        list.push(job);
        trialJobs.set(job.trialId, list);
      }
    const attemptsByRequest = new Map<string, JevAttempt[]>();
    for (const attempt of priorAttempts) {
      if (attempt.status === "in_flight") {
        atomicJson(attemptPath(id, attempt.attemptId), {
          ...attempt,
          status: "interrupted",
          completedAt: new Date().toISOString(),
          error:
            "Process ended before response was recorded; provider completion is uncertain",
        });
        attempt.status = "interrupted";
      }
      const list = attemptsByRequest.get(attempt.requestId) ?? [];
      list.push(attempt);
      attemptsByRequest.set(attempt.requestId, list);
    }
    const budgetPath = join(experimentDir(id), "optimization-budget.json");
    const previousBudget = existsSync(budgetPath)
      ? (JSON.parse(readFileSync(budgetPath, "utf8")) as { activeMs: number })
      : { activeMs: 0 };
    let activeMs = previousBudget.activeMs;
    const sessionStart = Date.now();
    atomicJson(budgetPath, { activeMs: previousBudget.activeMs + 1000 });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const heartbeat = setInterval(() => {
      activeMs = previousBudget.activeMs + Date.now() - sessionStart;
      atomicJson(budgetPath, { activeMs: activeMs + 1000 });
      if (activeMs >= optimization.maxActiveSeconds * 1000) controller.abort();
    }, 1000);
    let attemptsUsed = priorAttempts.length;
    const nextStart = new Map<string, number>();
    const cooldownUntil = new Map<string, number>();
    let stopped = false;
    const accessErrors: string[] = [];
    let consecutiveServiceFailures = 0;
    const serviceFailure = () => {
      consecutiveServiceFailures++;
      if (
        optimization.stopAfterConsecutiveServiceFailures != null &&
        consecutiveServiceFailures >=
          optimization.stopAfterConsecutiveServiceFailures
      ) {
        stopped = true;
        accessErrors.push(
          `Stopped after ${consecutiveServiceFailures} consecutive service failures`,
        );
      }
    };
    let activeRequests = 0;
    let peakConcurrency = 0;
    const activeByVariant = new Map<string, number>();
    const peakByVariant = new Map<string, number>();
    let rateLimitWaitMs = 0;
    const syncTrial = (trialId: string) => {
      const base = trialsById.get(trialId)!;
      const entries = trialJobs.get(trialId)!;
      const results = entries.map((entry) =>
        loadResult(id, entry.spec.requestId),
      );
      const recorded = loadAttempts(id)
        .filter((attempt) =>
          entries.some((entry) => entry.spec.requestId === attempt.requestId),
        )
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const calls = recorded.map((attempt) => ({
        servedModel: attempt.servedModel ?? "unknown",
        latencyMs: attempt.durationMs ?? 0,
        ...(attempt.usage
          ? {
              inputTokens: attempt.usage.inputTokens,
              outputTokens: attempt.usage.outputTokens,
            }
          : {}),
      }));
      const allDone = results.every(Boolean);
      const failure = entries.some((entry) => {
        if (loadResult(id, entry.spec.requestId)) return false;
        const attempts = recorded.filter(
          (attempt) => attempt.requestId === entry.spec.requestId,
        );
        return (
          attempts.length >= 3 ||
          attempts.some(
            (attempt) =>
              attempt.status === "invalid_response" ||
              (attempt.httpStatus != null && !transient(attempt.httpStatus)),
          )
        );
      });
      const scoreEntries = results.flatMap((result) =>
        result?.scores
          ? Object.entries(result.scores).map(
              ([key, value]) => [key, value.score] as const,
            )
          : [],
      );
      const scores = Object.fromEntries(scoreEntries);
      const input = entries[0]!.caseInput!;
      const prediction =
        input.task === "role"
          ? { role: results[0]?.role }
          : input.task === "rerank"
            ? {
                rankedChunkIds: input.candidates
                  .map((candidate) => candidate.chunkId)
                  .sort(
                    (a, b) =>
                      (scores[b] ?? 0) - (scores[a] ?? 0) || a.localeCompare(b),
                  ),
                relevance: scores,
              }
            : undefined;
      atomicJson(join(experimentDir(id), "trials", `${trialId}.json`), {
        ...base,
        status: allDone ? "success" : failure ? "provider_failure" : "pending",
        calls,
        ...(allDone && prediction
          ? {
              prediction,
              completedAt: new Date().toISOString(),
              durationMs: recorded.length
                ? Date.parse(
                    recorded.at(-1)!.completedAt ?? recorded.at(-1)!.startedAt,
                  ) - Date.parse(recorded[0]!.queuedAt)
                : 0,
            }
          : {}),
        diagnostics: {
          requestIds: entries.map((entry) => entry.spec.requestId),
          results: results.filter(Boolean),
        },
      });
    };
    const startWait = async (
      queuedAt: number,
      phase: Phase,
      provider: ProviderConfig,
    ) => {
      const group = jevQuotaGroup(provider);
      while (true) {
        if (controller.signal.aborted || stopped) throw new Error("Cancelled");
        const cooldown = cooldownUntil.get(group) ?? 0;
        const due = Math.max(nextStart.get(group) ?? 0, cooldown);
        const remaining = due - Date.now();
        if (remaining <= 0) {
          nextStart.set(
            group,
            Date.now() +
              (phase === "probe"
                ? optimization.probeMinimumRequestIntervalMs
                : optimization.minimumRequestIntervalMs),
          );
          return Date.now() - queuedAt;
        }
        if (cooldown > Date.now())
          rateLimitWaitMs += Math.min(remaining, cooldown - Date.now());
        await wait(remaining, controller.signal);
      }
    };
    const runJob = async (job: Job) => {
      const existing = loadResult(id, job.spec.requestId);
      if (existing) {
        if (existing.requestHash !== job.spec.requestHash)
          throw new Error(`Request identity changed: ${job.spec.requestId}`);
        if (job.trialId) syncTrial(job.trialId);
        return;
      }
      const previous = attemptsByRequest.get(job.spec.requestId) ?? [];
      if (
        previous.some((attempt) => attempt.requestHash !== job.spec.requestHash)
      )
        throw new Error(`Request identity changed: ${job.spec.requestId}`);
      const persistedSuccess = previous.find(
        (attempt) =>
          attempt.status === "success" && attempt.response !== undefined,
      );
      if (persistedSuccess) {
        const reconstructed = parseJevResult(
          job.spec,
          persistedSuccess.response,
          persistedSuccess.attemptId,
        );
        if (
          job.phase !== "fixture" ||
          validateJevFixtureResult(job.spec, reconstructed)
        ) {
          atomicJson(resultPath(id, job.spec.requestId), reconstructed);
          return;
        }
      }
      if (
        previous.length >= 3 ||
        previous.some(
          (attempt) =>
            attempt.status === "invalid_response" ||
            (attempt.httpStatus != null && !transient(attempt.httpStatus)),
        )
      )
        return;
      let queuedAt = Date.now();
      let retryWaitMs = previous.length
        ? Math.max(
            0,
            Date.now() -
              Date.parse(
                previous.at(-1)!.completedAt ?? previous.at(-1)!.startedAt,
              ),
          )
        : 0;
      for (
        let attemptNumber = previous.length + 1;
        attemptNumber <= 3;
        attemptNumber++
      ) {
        if (
          attemptsUsed >= optimization.maxAttempts ||
          previousBudget.activeMs + Date.now() - sessionStart >=
            optimization.maxActiveSeconds * 1000
        ) {
          controller.abort();
          return;
        }
        let queueWaitMs: number;
        try {
          queueWaitMs = await startWait(queuedAt, job.phase, job.provider);
        } catch {
          return;
        }
        if (
          attemptsUsed >= optimization.maxAttempts ||
          controller.signal.aborted
        )
          return;
        const startedAt = new Date().toISOString();
        const attemptId = randomUUID();
        const record: JevAttempt = {
          schemaVersion: "evaluation-jev-attempt-v1",
          attemptId,
          experimentId: id,
          requestId: job.spec.requestId,
          requestHash: job.spec.requestHash,
          variantId: job.spec.variantId,
          caseId: job.spec.caseId,
          providerId: job.provider.id,
          attemptNumber,
          status: "in_flight",
          queuedAt: new Date(queuedAt).toISOString(),
          startedAt,
          queueWaitMs,
          retryWaitMs,
        };
        atomicJson(attemptPath(id, attemptId), record);
        attemptsUsed++;
        activeRequests++;
        peakConcurrency = Math.max(peakConcurrency, activeRequests);
        const variantActive = (activeByVariant.get(job.variant.id) ?? 0) + 1;
        activeByVariant.set(job.variant.id, variantActive);
        peakByVariant.set(
          job.variant.id,
          Math.max(peakByVariant.get(job.variant.id) ?? 0, variantActive),
        );
        const started = performance.now();
        try {
          const response = await transport(
            job.provider,
            job.spec.body,
            controller.signal,
            optimization.requestTimeoutMs,
          );
          const common = {
            ...record,
            httpStatus: response.httpStatus,
            ...(response.diagnostics
              ? { diagnostics: response.diagnostics }
              : {}),
            ...(response.providerRequestId
              ? { providerRequestId: response.providerRequestId }
              : {}),
          };
          const metadata = response.body as
            | {
                model?: unknown;
                usage?: { input_tokens?: unknown; output_tokens?: unknown };
              }
            | undefined;
          const usage = metadata?.usage;
          const telemetry = {
            ...(typeof metadata?.model === "string"
              ? { servedModel: metadata.model }
              : {}),
            ...(typeof usage?.input_tokens === "number" &&
            typeof usage.output_tokens === "number"
              ? {
                  usage: {
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                  },
                }
              : {}),
          };
          if (response.httpStatus >= 200 && response.httpStatus < 300) {
            let parsed: JevResult;
            try {
              parsed = parseJevResult(job.spec, response.body, attemptId);
              if (
                job.phase === "fixture" &&
                !validateJevFixtureResult(job.spec, parsed)
              )
                throw new Error(
                  "Fixture answer did not match expected independent result",
                );
            } catch {
              atomicJson(attemptPath(id, attemptId), {
                ...common,
                ...telemetry,
                status: "invalid_response",
                completedAt: new Date().toISOString(),
                durationMs: performance.now() - started,
                error:
                  "Response failed schema, answer coverage, or fixture validation",
              });
              return;
            }
            const answerBody = response.body as {
              answers: Record<string, unknown>;
            };
            const sanitizedResponse = {
              ...(telemetry.servedModel
                ? { model: telemetry.servedModel }
                : {}),
              answers: Object.fromEntries(
                Object.keys(job.spec.answerMap).map((key) => [
                  key,
                  answerBody.answers[key],
                ]),
              ),
              ...(usage
                ? {
                    usage: {
                      input_tokens: usage.input_tokens,
                      output_tokens: usage.output_tokens,
                    },
                  }
                : {}),
            };
            atomicJson(attemptPath(id, attemptId), {
              ...common,
              ...telemetry,
              status: "success",
              completedAt: new Date().toISOString(),
              durationMs: performance.now() - started,
              response: sanitizedResponse,
            });
            atomicJson(resultPath(id, job.spec.requestId), parsed);
            consecutiveServiceFailures = 0;
            if (job.trialId) syncTrial(job.trialId);
            return;
          }
          atomicJson(attemptPath(id, attemptId), {
            ...common,
            ...telemetry,
            status: "http_error",
            completedAt: new Date().toISOString(),
            durationMs: performance.now() - started,
            error: `HTTP ${response.httpStatus}`,
          });
          if (response.httpStatus >= 500) serviceFailure();
          if (stopped) return;
          if (fatal(response.httpStatus)) {
            stopped = true;
            accessErrors.push(
              `${job.provider.id}: HTTP ${response.httpStatus}`,
            );
            return;
          }
          if (!transient(response.httpStatus)) return;
          if (job.phase === "probe") {
            stopped = true;
            return;
          }
          if (response.httpStatus === 429 || response.httpStatus === 529) {
            const group = jevQuotaGroup(job.provider);
            cooldownUntil.set(
              group,
              Math.max(
                cooldownUntil.get(group) ?? 0,
                Date.now() +
                  (response.retryAfterMs ??
                    Math.min(
                      30_000,
                      optimization.retryBaseDelayMs * 2 ** (attemptNumber - 1),
                    )),
              ),
            );
          }
          retryWaitMs = Math.max(
            response.retryAfterMs ?? 0,
            Math.min(
              30_000,
              optimization.retryBaseDelayMs * 2 ** (attemptNumber - 1),
            ),
          );
        } catch (error) {
          const interrupted = controller.signal.aborted;
          atomicJson(attemptPath(id, attemptId), {
            ...record,
            status: interrupted ? "interrupted" : "network_error",
            completedAt: new Date().toISOString(),
            durationMs: performance.now() - started,
            error: interrupted
              ? "Interrupted; provider completion is uncertain"
              : safeError(error),
          });
          if (interrupted) return;
          serviceFailure();
          if (stopped) return;
          retryWaitMs = Math.min(
            30_000,
            optimization.retryBaseDelayMs * 2 ** (attemptNumber - 1),
          );
        } finally {
          activeRequests--;
          activeByVariant.set(
            job.variant.id,
            (activeByVariant.get(job.variant.id) ?? 1) - 1,
          );
        }
        if (attemptNumber < 3)
          try {
            const retryStarted = Date.now();
            await wait(retryWaitMs, controller.signal);
            retryWaitMs = Date.now() - retryStarted;
            queuedAt = Date.now();
          } catch {
            return;
          }
      }
    };
    try {
      for (const phase of phases) {
        if (controller.signal.aborted || stopped) break;
        const phaseJobs = jobs.filter((job) => job.phase === phase);
        const groups =
          phase === "probe"
            ? [...new Set(phaseJobs.map((job) => job.variant.id))]
                .sort(
                  (a, b) =>
                    (phaseJobs.find((job) => job.variant.id === a)!.variant
                      .concurrencyCeiling ?? 1) -
                    (phaseJobs.find((job) => job.variant.id === b)!.variant
                      .concurrencyCeiling ?? 1),
                )
                .map((variantId) =>
                  phaseJobs.filter((job) => job.variant.id === variantId),
                )
            : [phaseJobs];
        for (const group of groups) {
          if (controller.signal.aborted || stopped) break;
          const queue = fairQueue(group);
          let cursor = 0;
          const ceiling =
            phase === "probe"
              ? (group[0]?.variant.concurrencyCeiling ?? 1)
              : optimization.concurrency;
          const workers = Array.from(
            {
              length: Math.min(ceiling, optimization.concurrency, queue.length),
            },
            async () => {
              while (
                cursor < queue.length &&
                !controller.signal.aborted &&
                !stopped
              ) {
                const job = queue[cursor++]!;
                await runJob(job);
                if (job.trialId) syncTrial(job.trialId);
              }
            },
          );
          await Promise.all(workers);
        }
        if (
          phase === "fixture" &&
          phaseJobs.some((job) => !loadResult(id, job.spec.requestId))
        ) {
          stopped = true;
          accessErrors.push(
            "Fixture validation failed; corpus dispatch was stopped",
          );
        }
      }
    } finally {
      clearInterval(heartbeat);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      activeMs = previousBudget.activeMs + Date.now() - sessionStart;
      atomicJson(budgetPath, { activeMs });
    }
    const completed = jobs.filter((job) =>
      loadResult(id, job.spec.requestId),
    ).length;
    const summary = {
      experimentId: id,
      completed,
      pending: jobs.length - completed,
      accessErrors,
      attempts: attemptsUsed,
      activeSeconds: Math.ceil(activeMs / 1000),
      peakConcurrency,
      peakConcurrencyByVariant: Object.fromEntries(peakByVariant),
      rateLimitWaitMs,
      endpoints: config.providers.map(jevEndpoint),
    };
    atomicJson(join(experimentDir(id), "execution-summary.json"), {
      ...summary,
      recordedAt: new Date().toISOString(),
    });
    return summary;
  });
}
