import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  jevAttemptSchema,
  jevResultSchema,
  type JevAttempt,
  type JevResult,
} from "./optimization-contract.js";
import { canonicalSha256 } from "../shared/stable-identity.js";
import {
  loadExperiment,
  loadTrials,
  type Experiment,
  type Trial,
} from "./runner.js";
import { planJevOptimization } from "./optimization-runner.js";
import { evaluationRoot, experimentDir, loadDataset } from "./storage.js";
import type { EvaluationCase } from "./types.js";

type Label = {
  value: { task: string; role?: string; grades?: Record<string, string> };
  exposed: boolean;
};
type Observation = {
  source: string;
  variantId: string;
  task: "role" | "rerank";
  caseId: string;
  role?: string;
  ranking?: string[];
  inputCompatible?: boolean;
  originalCaseId?: string;
};
type HumanScore = {
  exposed: boolean;
  correct?: boolean;
  ndcg5?: number;
  pinnedNdcg5?: number | null;
};

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(fraction * ordered.length) - 1] ?? null;
}

function average(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function callCost(
  call: Record<string, unknown>,
  inputPrice: number | undefined,
  outputPrice: number | undefined,
): number | null {
  if (
    inputPrice == null ||
    outputPrice == null ||
    typeof call.inputTokens !== "number" ||
    typeof call.outputTokens !== "number"
  )
    return null;
  const read =
    typeof call.promptCacheReadTokens === "number"
      ? call.promptCacheReadTokens
      : 0;
  const write =
    typeof call.promptCacheWriteTokens === "number"
      ? call.promptCacheWriteTokens
      : 0;
  return (
    ((Math.max(0, call.inputTokens - read - write) +
      read * 0.1 +
      write * 1.25) *
      inputPrice +
      call.outputTokens * outputPrice) /
    1_000_000
  );
}

function readArtifactDirectory<T>(
  directory: string,
  parse: (value: unknown) => T,
): T[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      parse(JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown),
    );
}

export function loadOptimizationAttempts(experimentId: string): JevAttempt[] {
  return readArtifactDirectory(
    join(experimentDir(experimentId), "attempts"),
    (value) => jevAttemptSchema.parse(value),
  );
}

export function loadOptimizationResults(experimentId: string): JevResult[] {
  return readArtifactDirectory(
    join(experimentDir(experimentId), "results"),
    (value) => jevResultSchema.parse(value),
  );
}

function sourceTrial(
  trial: Trial,
  cache: Map<string, Trial[]>,
): { trial: Trial; sourceExperimentId: string; telemetryAvailable: boolean } {
  let current = trial;
  const seen = new Set<string>();
  while (current.reusedFrom) {
    const { experimentId, trialId } = current.reusedFrom;
    const key = `${experimentId}/${trialId}`;
    if (seen.has(key))
      return {
        trial: current,
        sourceExperimentId: current.experimentId,
        telemetryAvailable: false,
      };
    seen.add(key);
    try {
      let sourceTrials = cache.get(experimentId);
      if (!sourceTrials) {
        sourceTrials = loadTrials(experimentId);
        cache.set(experimentId, sourceTrials);
      }
      const source = sourceTrials.find((item) => item.trialId === trialId);
      if (!source)
        return {
          trial: current,
          sourceExperimentId: experimentId,
          telemetryAvailable: false,
        };
      current = source;
    } catch {
      return {
        trial: current,
        sourceExperimentId: experimentId,
        telemetryAvailable: false,
      };
    }
  }
  return {
    trial: current,
    sourceExperimentId: current.experimentId,
    telemetryAvailable: true,
  };
}

/** Reused trial copies never count as another provider attempt. */
export function historicalAttemptAccounting(trials: Trial[]): {
  uniqueAttempts: number;
  missingTelemetryTrials: number;
  provenance: {
    experimentId: string;
    trialId: string;
    attempts: number;
    telemetryAvailable: boolean;
  }[];
} {
  const sources = new Map<string, ReturnType<typeof sourceTrial>>();
  const cache = new Map<string, Trial[]>();
  for (const trial of trials) {
    const origin = sourceTrial(trial, cache);
    sources.set(`${origin.sourceExperimentId}/${origin.trial.trialId}`, origin);
  }
  const provenance = [...sources.values()].map((origin) => ({
    experimentId: origin.sourceExperimentId,
    trialId: origin.trial.trialId,
    attempts: origin.telemetryAvailable ? origin.trial.calls.length : 0,
    telemetryAvailable:
      origin.telemetryAvailable && origin.trial.calls.length > 0,
  }));
  return {
    uniqueAttempts: provenance.reduce((sum, item) => sum + item.attempts, 0),
    missingTelemetryTrials: provenance.filter(
      (item) => !item.telemetryAvailable,
    ).length,
    provenance,
  };
}

export function uniqueHistoricalCalls(
  trials: Trial[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const cache = new Map<string, Trial[]>();
  return trials.flatMap((trial) => {
    const origin = sourceTrial(trial, cache);
    const key = `${origin.sourceExperimentId}/${origin.trial.trialId}`;
    if (seen.has(key) || !origin.telemetryAvailable) return [];
    seen.add(key);
    return origin.trial.calls.filter(
      (call): call is Record<string, unknown> =>
        typeof call === "object" && call != null,
    );
  });
}

function trialObservation(trial: Trial, source: string): Observation | null {
  if (
    trial.status !== "success" ||
    !trial.prediction ||
    typeof trial.prediction !== "object"
  )
    return null;
  const output = trial.prediction as Record<string, unknown>;
  if (trial.task === "role" && typeof output.role === "string")
    return {
      source,
      variantId: trial.variantId ?? trial.providerId,
      task: "role",
      caseId: trial.caseId,
      role: output.role,
    };
  if (
    trial.task === "rerank" &&
    Array.isArray(output.rankedChunkIds) &&
    output.rankedChunkIds.every((id) => typeof id === "string")
  )
    return {
      source,
      variantId: trial.variantId ?? trial.providerId,
      task: "rerank",
      caseId: trial.caseId,
      ranking: output.rankedChunkIds,
    };
  return null;
}

function overlap(
  left: string[],
  right: string[],
  limit: number,
): number | null {
  const denominator = Math.min(limit, left.length, right.length);
  return denominator
    ? left.slice(0, limit).filter((id) => right.slice(0, limit).includes(id))
        .length / denominator
    : null;
}

function pinned(item: EvaluationCase, ranking: string[]): string[] {
  return item.task === "rerank"
    ? [
        ...item.pinnedChunkIds,
        ...ranking.filter((id) => !item.pinnedChunkIds.includes(id)),
      ]
    : ranking;
}

function ndcg5(
  ranking: string[],
  grades: Record<string, string>,
): number | null {
  const gain = (id: string) =>
    grades[id] === "direct" ? 3 : grades[id] === "contextual" ? 1 : 0;
  const ideal = Object.keys(grades)
    .filter((id) => grades[id] !== "cannot_judge")
    .sort((left, right) => gain(right) - gain(left))
    .slice(0, 5)
    .reduce((sum, id, index) => sum + gain(id) / Math.log2(index + 2), 0);
  if (!ideal) return null;
  const observed = ranking
    .filter((id) => grades[id] && grades[id] !== "cannot_judge")
    .slice(0, 5)
    .reduce((sum, id, index) => sum + gain(id) / Math.log2(index + 2), 0);
  return observed / ideal;
}

function scientificKey(item: EvaluationCase): string {
  return `${item.task}\0${item.runId}\0${item.recordId}\0${item.task === "role" ? item.occurrenceId : item.task === "span" ? item.claimRecordId : ""}`;
}

function inputCompatible(
  current: EvaluationCase,
  historical: EvaluationCase,
): boolean {
  if (current.task !== historical.task) return false;
  if (current.task === "rerank" && historical.task === "rerank")
    return (
      canonicalSha256({
        query: current.query,
        candidates: current.candidates,
        pinnedPassages: current.pinnedPassages,
        pinnedChunkIds: current.pinnedChunkIds,
      }) ===
      canonicalSha256({
        query: historical.query,
        candidates: historical.candidates,
        pinnedPassages: historical.pinnedPassages,
        pinnedChunkIds: historical.pinnedChunkIds,
      })
    );
  // Role v2 intentionally carries additional verified input; a historical role answer is diagnostic only.
  return current.caseId === historical.caseId;
}

function historicalCampaignTrials(
  source: Experiment,
  providerId: string,
): { experimentIds: string[]; trials: Trial[] } {
  const selected = source.config.providers.find(
    (item) => item.id === providerId,
  );
  if (!selected) return { experimentIds: [], trials: [] };
  const root = join(evaluationRoot(), "experiments");
  const experimentIds = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          try {
            const candidate = loadExperiment(entry.name);
            const provider = candidate.config.providers.find(
              (item) => item.id === providerId,
            );
            return candidate.datasetId === source.datasetId &&
              candidate.datasetHash === source.datasetHash &&
              candidate.config.promptRevision ===
                source.config.promptRevision &&
              provider?.kind === selected.kind &&
              provider.model === selected.model &&
              provider.endpoint === selected.endpoint
              ? [candidate.experimentId]
              : [];
          } catch {
            return [];
          }
        })
    : [];
  return {
    experimentIds,
    trials: experimentIds.flatMap((experimentId) =>
      loadTrials(experimentId).filter(
        (trial) =>
          trial.providerId === providerId &&
          !trial.reusedFrom &&
          (trial.status !== "pending" || trial.calls.length > 0),
      ),
    ),
  };
}

function activeConcurrency(attempts: JevAttempt[]): number {
  const boundaries = attempts
    .flatMap((attempt) =>
      attempt.completedAt
        ? [
            { at: Date.parse(attempt.startedAt), change: 1 },
            { at: Date.parse(attempt.completedAt), change: -1 },
          ]
        : [],
    )
    .sort((left, right) => left.at - right.at || left.change - right.change);
  let active = 0;
  let peak = 0;
  for (const boundary of boundaries) {
    active += boundary.change;
    peak = Math.max(peak, active);
  }
  return peak;
}

export function buildOptimizationAnalysis(
  experiment: Experiment,
  trials: Trial[],
  cases: EvaluationCase[],
  labels: Map<string, Label>,
): Record<string, unknown> | null {
  const optimization = experiment.config.optimization;
  if (!optimization) return null;
  const plan = planJevOptimization(experiment.datasetId, experiment.config);
  const plannedVariants = new Map(plan.variants.map((item) => [item.id, item]));
  const attempts = loadOptimizationAttempts(experiment.experimentId);
  const results = loadOptimizationResults(experiment.experimentId);
  const byCase = new Map(cases.map((item) => [item.caseId, item]));
  const byScientificKey = new Map(
    cases.map((item) => [scientificKey(item), item]),
  );
  if (byScientificKey.size !== cases.length)
    throw new Error("Current dataset has duplicate scientific case keys");
  const byRequest = new Map<string, JevAttempt[]>();
  for (const attempt of attempts) {
    const group = byRequest.get(attempt.requestId) ?? [];
    group.push(attempt);
    byRequest.set(attempt.requestId, group);
  }
  const baselines = optimization.baselineReferences.map((reference) => {
    const source = loadExperiment(reference.experimentId);
    const sourceDataset = loadDataset(source.datasetId);
    const currentDataset = loadDataset(experiment.datasetId);
    if (
      canonicalSha256(sourceDataset.sources) !==
      canonicalSha256(currentDataset.sources)
    )
      throw new Error(
        `Baseline ${reference.experimentId} does not share the frozen source lineage`,
      );
    const sourceCases = new Map(
      sourceDataset.cases.map((item) => [item.caseId, item]),
    );
    const provider = source.config.providers.find(
      (item) => item.id === reference.providerId,
    );
    if (!provider)
      throw new Error(
        `Baseline provider ${reference.providerId} is absent from ${reference.experimentId}`,
      );
    const sourceTrials = loadTrials(reference.experimentId).filter(
      (item) => item.providerId === reference.providerId,
    );
    const campaign = historicalCampaignTrials(source, reference.providerId);
    const referenceCosts = uniqueHistoricalCalls(sourceTrials).map((call) =>
      callCost(
        call,
        provider.pricePerMillionInputTokensUsd,
        provider.pricePerMillionOutputTokensUsd,
      ),
    );
    const sourceCosts = uniqueHistoricalCalls(campaign.trials).map((call) =>
      callCost(
        call,
        provider.pricePerMillionInputTokensUsd,
        provider.pricePerMillionOutputTokensUsd,
      ),
    );
    return {
      experimentId: reference.experimentId,
      providerId: reference.providerId,
      model: provider.model,
      thinking: provider.thinking ?? null,
      historicalThinking:
        provider.kind === "anthropic" &&
        provider.model.includes("opus") &&
        !provider.thinking
          ? "legacy evaluation settings; production thinking parity unverified"
          : null,
      accounting: historicalAttemptAccounting(campaign.trials),
      selectedReferenceAttempts: referenceCosts.length,
      selectedReferenceUnknownChargeAttempts: referenceCosts.filter(
        (cost) => cost == null,
      ).length,
      selectedReferenceKnownSpendUsd: referenceCosts.reduce<number>(
        (sum, cost) => sum + (cost ?? 0),
        0,
      ),
      historicalExperimentIds: campaign.experimentIds,
      historicalScope:
        "original trials in saved experiments matching dataset, provider ID, model, endpoint, and prompt revision",
      knownHistoricalSpendUsd: sourceCosts.reduce<number>(
        (sum, cost) => sum + (cost ?? 0),
        0,
      ),
      unknownHistoricalChargeAttempts: sourceCosts.filter(
        (cost) => cost == null,
      ).length,
      observations: sourceTrials.flatMap((item) => {
        const observation = trialObservation(
          item,
          `baseline:${reference.experimentId}/${reference.providerId}`,
        );
        const historical = sourceCases.get(item.caseId);
        const current =
          historical && byScientificKey.get(scientificKey(historical));
        return observation && historical && current
          ? [
              {
                ...observation,
                originalCaseId: item.caseId,
                caseId: current.caseId,
                inputCompatible: inputCompatible(current, historical),
              },
            ]
          : [];
      }),
    };
  });
  const observations = [
    ...trials.flatMap((item) =>
      item.variantId ? (trialObservation(item, "optimization") ?? []) : [],
    ),
    ...baselines.flatMap((item) => item.observations),
  ];
  const comparisonRows: Record<string, unknown>[] = [];
  for (let left = 0; left < observations.length; left++) {
    const first = observations[left]!;
    if (first.source !== "optimization") continue;
    for (let right = left + 1; right < observations.length; right++) {
      const second = observations[right]!;
      if (
        first.caseId !== second.caseId ||
        first.task !== second.task ||
        first.variantId === second.variantId
      )
        continue;
      const item = byCase.get(first.caseId);
      const rawOverlap =
        first.ranking && second.ranking
          ? overlap(first.ranking, second.ranking, 5)
          : null;
      const afterPins =
        item && first.ranking && second.ranking
          ? overlap(
              pinned(item, first.ranking),
              pinned(item, second.ranking),
              5,
            )
          : null;
      comparisonRows.push({
        caseId: first.caseId,
        task: first.task,
        left: first.variantId,
        right: second.variantId,
        comparisonType:
          second.source === "optimization" ? "variant" : "historical_baseline",
        scientificInputCompatible: second.inputCompatible ?? true,
        historicalCaseId: second.originalCaseId ?? null,
        leftRole: first.role ?? null,
        rightRole: second.role ?? null,
        roleAgreement:
          first.role && second.role ? first.role === second.role : null,
        substantiveAttributionDisagreement:
          first.role && second.role
            ? (first.role === "substantive_attribution") !==
              (second.role === "substantive_attribution")
            : null,
        top5OverlapBeforePins: rawOverlap,
        top5OverlapAfterPins: afterPins,
      });
    }
  }
  const variants = optimization.variants.map((variant) => {
    const belongsToVariant = (attempt: JevAttempt) =>
      attempt.variantId === variant.id ||
      (variant.phase === "fixture" && attempt.caseId.startsWith("fixture-"));
    const variantAttempts = attempts.filter(belongsToVariant);
    const requests = [...byRequest.values()].filter(
      (group) => group[0] && belongsToVariant(group[0]),
    );
    const variantTrials = trials.filter(
      (item) => item.variantId === variant.id,
    );
    const durations = variantAttempts.flatMap((item) =>
      item.durationMs == null ? [] : [item.durationMs],
    );
    const success = requests.filter((group) =>
      group.some((item) => item.status === "success"),
    ).length;
    const firstAttemptSuccess = requests.filter(
      (group) =>
        group.sort((a, b) => a.attemptNumber - b.attemptNumber)[0]?.status ===
        "success",
    ).length;
    const windows = variantAttempts.filter((item) => item.completedAt);
    const firstStart = windows.length
      ? Math.min(...windows.map((item) => Date.parse(item.startedAt)))
      : null;
    const lastEnd = windows.length
      ? Math.max(...windows.map((item) => Date.parse(item.completedAt!)))
      : null;
    const provider = experiment.config.providers.find(
      (item) => item.kind === "jev",
    );
    const costed = variantAttempts.map((item) =>
      item.usage &&
      provider?.pricePerMillionInputTokensUsd != null &&
      provider.pricePerMillionOutputTokensUsd != null
        ? (item.usage.inputTokens * provider.pricePerMillionInputTokensUsd +
            item.usage.outputTokens * provider.pricePerMillionOutputTokensUsd) /
          1_000_000
        : null,
    );
    const labeled = variantTrials.flatMap<HumanScore>((trial) => {
      const label = labels.get(trial.caseId);
      const item = byCase.get(trial.caseId);
      if (
        !label ||
        !item ||
        trial.status !== "success" ||
        !trial.prediction ||
        typeof trial.prediction !== "object"
      )
        return [];
      const prediction = trial.prediction as Record<string, unknown>;
      if (item.task === "role" && label.value.task === "role")
        return [
          {
            exposed: label.exposed,
            correct: prediction.role === label.value.role,
          },
        ];
      if (
        item.task === "rerank" &&
        label.value.task === "rerank" &&
        label.value.grades &&
        Array.isArray(prediction.rankedChunkIds) &&
        prediction.rankedChunkIds.every((id) => typeof id === "string")
      ) {
        const ranking = prediction.rankedChunkIds;
        if (
          new Set(ranking).size !== item.candidates.length ||
          ranking.some(
            (id) =>
              !item.candidates.some((candidate) => candidate.chunkId === id),
          )
        )
          return [];
        const before = ndcg5(ranking, label.value.grades);
        const after = ndcg5(pinned(item, ranking), label.value.grades);
        return before == null
          ? []
          : [{ exposed: label.exposed, ndcg5: before, pinnedNdcg5: after }];
      }
      return [];
    });
    const repeated = new Map<string, Observation[]>();
    for (const trial of variantTrials) {
      const observation = trialObservation(trial, "optimization");
      if (!observation) continue;
      const group = repeated.get(trial.caseId) ?? [];
      group.push(observation);
      repeated.set(trial.caseId, group);
    }
    const repeatability = [...repeated.values()].flatMap((group) => {
      if (group.length < 2) return [];
      const first = group[0]!;
      const second = group[1]!;
      if (first.task === "role") return [Number(first.role === second.role)];
      const score =
        first.ranking && second.ranking
          ? overlap(first.ranking, second.ranking, 5)
          : null;
      return score == null ? [] : [score];
    });
    return {
      variantId: variant.id,
      task: variant.task,
      layout: variant.layout,
      phase: variant.phase,
      batchSize: variant.batchSize ?? null,
      selectedCases: plannedVariants.get(variant.id)?.caseCount ?? 0,
      completedCases: new Set(
        variantTrials
          .filter((item) => item.status === "success")
          .map((item) => item.caseId),
      ).size,
      plannedRequests: plannedVariants.get(variant.id)?.plannedRequests ?? 0,
      logicalRequestsStarted: requests.length,
      firstAttemptSuccess,
      eventualRequestSuccess: success,
      attempts: variantAttempts.length,
      retryAmplification: requests.length
        ? variantAttempts.length / requests.length
        : null,
      requestP50Ms: percentile(durations, 0.5),
      requestP95Ms: percentile(durations, 0.95),
      taskP50Ms: percentile(
        variantTrials.flatMap((item) =>
          item.durationMs == null ? [] : [item.durationMs],
        ),
        0.5,
      ),
      taskP95Ms: percentile(
        variantTrials.flatMap((item) =>
          item.durationMs == null ? [] : [item.durationMs],
        ),
        0.95,
      ),
      queueWaitP50Ms: percentile(
        variantAttempts.map((item) => item.queueWaitMs),
        0.5,
      ),
      retryWaitMs: variantAttempts.reduce(
        (sum, item) => sum + item.retryWaitMs,
        0,
      ),
      achievedConcurrency: activeConcurrency(variantAttempts),
      throughputRequestsPerSecond:
        firstStart != null && lastEnd != null && lastEnd > firstStart
          ? success / ((lastEnd - firstStart) / 1000)
          : null,
      knownNewSpendUsd: costed.reduce<number>(
        (sum, item) => sum + (item ?? 0),
        0,
      ),
      usageReportedAttempts: costed.filter((item) => item != null).length,
      unknownChargeAttempts: costed.filter((item) => item == null).length,
      blindHumanRoleAccuracy: average(
        labeled
          .filter((item) => !item.exposed && typeof item.correct === "boolean")
          .map((item) => Number(item.correct)),
      ),
      blindHumanRoleDenominator: labeled.filter(
        (item) => !item.exposed && typeof item.correct === "boolean",
      ).length,
      exposedHumanRoleDenominator: labeled.filter(
        (item) => item.exposed && typeof item.correct === "boolean",
      ).length,
      blindHumanRerankNdcg5: average(
        labeled.flatMap((item) =>
          !item.exposed && typeof item.ndcg5 === "number" ? [item.ndcg5] : [],
        ),
      ),
      blindHumanRerankPinnedNdcg5: average(
        labeled.flatMap((item) =>
          !item.exposed && typeof item.pinnedNdcg5 === "number"
            ? [item.pinnedNdcg5]
            : [],
        ),
      ),
      blindHumanRerankDenominator: labeled.filter(
        (item) => !item.exposed && typeof item.ndcg5 === "number",
      ).length,
      exposedHumanRerankDenominator: labeled.filter(
        (item) => item.exposed && typeof item.ndcg5 === "number",
      ).length,
      repeatability: average(repeatability),
      repeatabilityPairedCases: repeatability.length,
    };
  });
  const paired = new Map<string, typeof comparisonRows>();
  for (const row of comparisonRows) {
    const key = `${String(row.left)}\0${String(row.right)}\0${String(row.task)}`;
    const group = paired.get(key) ?? [];
    group.push(row);
    paired.set(key, group);
  }
  const behavior = [...paired.values()].map((rows) => ({
    left: rows[0]!.left,
    right: rows[0]!.right,
    task: rows[0]!.task,
    pairedCases: rows.length,
    scientificallyCompatibleCases: rows.filter(
      (row) => row.scientificInputCompatible,
    ).length,
    roleAgreement: average(
      rows.flatMap((row) =>
        typeof row.roleAgreement === "boolean"
          ? [Number(row.roleAgreement)]
          : [],
      ),
    ),
    substantiveAttributionDisagreements: rows.filter(
      (row) => row.substantiveAttributionDisagreement === true,
    ).length,
    top5OverlapBeforePins: average(
      rows.flatMap((row) =>
        typeof row.top5OverlapBeforePins === "number"
          ? [row.top5OverlapBeforePins]
          : [],
      ),
    ),
    top5OverlapAfterPins: average(
      rows.flatMap((row) =>
        typeof row.top5OverlapAfterPins === "number"
          ? [row.top5OverlapAfterPins]
          : [],
      ),
    ),
  }));
  const shortlistByCase = new Map<
    string,
    { caseId: string; task: string; priority: number; rationale: string }
  >();
  for (const row of comparisonRows) {
    if (
      row.roleAgreement !== false &&
      !(
        typeof row.top5OverlapBeforePins === "number" &&
        row.top5OverlapBeforePins < 1
      )
    )
      continue;
    const candidate = {
      caseId: String(row.caseId),
      task: String(row.task),
      priority:
        row.substantiveAttributionDisagreement === true
          ? 3
          : row.roleAgreement === false
            ? 2
            : 1,
      rationale:
        row.substantiveAttributionDisagreement === true
          ? "substantive attribution disagreement"
          : row.roleAgreement === false
            ? "role disagreement"
            : "ranking disagreement before grounding pins",
    };
    const previous = shortlistByCase.get(candidate.caseId);
    if (!previous || candidate.priority > previous.priority)
      shortlistByCase.set(candidate.caseId, candidate);
  }
  const shortlist = [...shortlistByCase.values()]
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.caseId.localeCompare(right.caseId),
    )
    .slice(0, 20);
  const complete = (item: (typeof variants)[number]) =>
    item.selectedCases > 0 &&
    item.completedCases === item.selectedCases &&
    item.plannedRequests > 0 &&
    item.eventualRequestSuccess === item.plannedRequests;
  const roleTranches = variants.filter(
    (item) =>
      item.task === "role" &&
      (item.phase === "fallback" || item.phase === "comparison"),
  );
  const roleCases = roleTranches.reduce(
    (sum, item) => sum + item.selectedCases,
    0,
  );
  const roleCompletedCases = roleTranches.reduce(
    (sum, item) => sum + item.completedCases,
    0,
  );
  const roleAttempts = roleTranches.reduce(
    (sum, item) => sum + item.attempts,
    0,
  );
  const roleUnknownCharges = roleTranches.reduce(
    (sum, item) => sum + item.unknownChargeAttempts,
    0,
  );
  const roleRepresentative = roleTranches.find(
    (item) => item.phase === "fallback",
  );
  const roleReady =
    roleTranches.length > 0 &&
    roleTranches.every(complete) &&
    roleRepresentative;
  const rerankCandidate = variants
    .filter(
      (item) =>
        item.task === "rerank" &&
        (item.phase === "main" || item.phase === "comparison") &&
        complete(item),
    )
    .sort(
      (left, right) =>
        right.selectedCases - left.selectedCases ||
        left.attempts / left.plannedRequests -
          right.attempts / right.plannedRequests ||
        (left.requestP50Ms ?? Infinity) - (right.requestP50Ms ?? Infinity) ||
        left.variantId.localeCompare(right.variantId),
    )[0];
  const recommendation = [
    roleReady
      ? {
          task: "role",
          status: "operational_candidate_for_human_review",
          variantId: roleRepresentative.variantId,
          basis: `The same revised role input completed ${roleCompletedCases}/${roleCases} cases across its fallback and remaining tranches in ${roleAttempts} attempts; ${roleUnknownCharges} attempts have unknown charges. Advance to blinded review before any routing decision.`,
        }
      : {
          task: "role",
          status: "pending",
          variantId: null,
          basis:
            "The revised role input has not completed every selected case.",
        },
    rerankCandidate
      ? {
          task: "rerank",
          status: "operational_candidate_for_human_review",
          variantId: rerankCandidate.variantId,
          basis: `Completed ${rerankCandidate.completedCases}/${rerankCandidate.selectedCases} selected queries and ${rerankCandidate.eventualRequestSuccess}/${rerankCandidate.plannedRequests} requests in ${rerankCandidate.attempts} attempts; ${rerankCandidate.unknownChargeAttempts} attempts have unknown charges. Chosen for complete case coverage, then fewer attempts per request. Advance to blinded relevance review before any routing decision.`,
        }
      : {
          task: "rerank",
          status: "pending",
          variantId: null,
          basis:
            "No reranking variant completed all its selected queries and planned requests.",
        },
  ];
  return {
    limits: {
      maxAttempts: optimization.maxAttempts,
      maxActiveSeconds: optimization.maxActiveSeconds,
    },
    operations: {
      plannedRequests: plan.plannedRequests,
      attempts: attempts.length,
      completedResults: results.length,
      unknownCompletionAttempts: attempts.filter(
        (item) => item.status === "interrupted" || item.status === "in_flight",
      ).length,
      rateLimitResponses: attempts.filter((item) => item.httpStatus === 429)
        .length,
      overloadResponses: attempts.filter((item) => item.httpStatus === 529)
        .length,
    },
    cost: {
      knownNewSpendUsd: variants.reduce(
        (sum, item) => sum + item.knownNewSpendUsd,
        0,
      ),
      unknownChargeAttempts: variants.reduce(
        (sum, item) => sum + item.unknownChargeAttempts,
        0,
      ),
      historicalUniqueAttempts: [
        ...new Map(
          baselines.flatMap((item) =>
            item.accounting.provenance.map(
              (entry) =>
                [`${entry.experimentId}/${entry.trialId}`, entry] as const,
            ),
          ),
        ).values(),
      ].reduce((sum, entry) => sum + entry.attempts, 0),
      historicalMissingTelemetryTrials: [
        ...new Map(
          baselines.flatMap((item) =>
            item.accounting.provenance.map(
              (entry) =>
                [`${entry.experimentId}/${entry.trialId}`, entry] as const,
            ),
          ),
        ).values(),
      ].filter((entry) => !entry.telemetryAvailable).length,
      knownHistoricalSpendUsd: baselines.reduce(
        (sum, item) => sum + item.knownHistoricalSpendUsd,
        0,
      ),
      unknownHistoricalChargeAttempts: baselines.reduce(
        (sum, item) => sum + item.unknownHistoricalChargeAttempts,
        0,
      ),
    },
    baselines: baselines.map(
      ({ observations: _observations, ...item }) => item,
    ),
    variants,
    behavior,
    comparisons: comparisonRows,
    humanEvaluationShortlist: shortlist,
    operationalRecommendations: recommendation,
    interpretation:
      "Agreement, probabilities, confidence, and repeatability are diagnostic. Human quality is reported only where compatible labels exist; this single-seed corpus cannot establish production substitution.",
  };
}
