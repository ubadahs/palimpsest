import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStableId, canonicalSha256 } from "../shared/stable-identity.js";
import { validateEvaluationDataset } from "./dataset.js";
import {
  constructedCaseIds,
  constructedScoreMarkdown,
  scoreConstructedCases,
} from "./constructed-scoring.js";
import {
  importedReviewsSchema,
  importedUnitVerdicts,
} from "./imported-labels.js";
import {
  repeatAgreement,
  repeatAgreementMarkdown,
} from "./repeat-agreement.js";
import {
  atomicJson,
  atomicText,
  datasetDir,
  experimentDir,
  loadAnnotationLog,
  loadDataset,
} from "./storage.js";
import { callCostUsd } from "./providers.js";
import { loadExperiment, loadTrials, type Trial } from "./runner.js";
import {
  buildOptimizationAnalysis,
  historicalAttemptAccounting,
  uniqueHistoricalCalls,
  loadOptimizationAttempts,
} from "./optimization-report.js";
import {
  annotationValueSchema,
  type AnnotationValue,
  type EvaluationCase,
} from "./types.js";

type Label = { value: AnnotationValue; exposed: boolean };
const REPORT_BUILDER_VERSION = "evaluation-report-build-v9";

function importedLabels(
  datasetId: string,
  cases: EvaluationCase[],
): Map<string, Label> {
  const path = join(datasetDir(datasetId), "imported-reviews.json");
  const result = new Map<string, Label>();
  if (!existsSync(path)) return result;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const verdicts = importedUnitVerdicts(importedReviewsSchema.parse(raw));
  for (const item of cases) {
    if (item.task !== "adjudication") continue;
    const unit = verdicts.get(item.unitKey);
    if (!unit) continue;
    result.set(item.caseId, {
      value: {
        task: "adjudication",
        verdict: unit.verdict,
        packetQuality: "valid",
        evidenceSufficiency: "sufficient",
      },
      exposed: unit.exposed,
    });
  }
  return result;
}

function currentLabels(
  datasetId: string,
  cases: EvaluationCase[],
): { labels: Map<string, Label>; conflicts: string[]; snapshotHash: string } {
  const imported = importedLabels(datasetId, cases);
  const log = loadAnnotationLog(datasetId);
  const importManifest: unknown = JSON.parse(
    readFileSync(join(datasetDir(datasetId), "imports.json"), "utf8"),
  );
  const latest = new Map<string, (typeof log.events)[number]>();
  for (const event of log.events)
    if ("value" in event && event.status === "final")
      latest.set(`${event.caseId}\0${event.reviewer}`, event);
  const grouped = new Map<string, Label[]>();
  const resolutions = new Map<string, Label>();
  for (const event of latest.values()) {
    if (!("value" in event) || event.status !== "final") continue;
    const labels = grouped.get(event.caseId) ?? [];
    labels.push({
      value: annotationValueSchema.parse(event.value),
      exposed: event.exposed,
    });
    grouped.set(event.caseId, labels);
    if (event.resolvesConflict)
      resolutions.set(event.caseId, {
        value: event.value,
        exposed: event.exposed,
      });
  }
  const conflicts: string[] = [];
  for (const [caseId, labels] of grouped) {
    const resolution = resolutions.get(caseId);
    if (resolution) {
      imported.set(caseId, resolution);
      continue;
    }
    const inherited = imported.get(caseId);
    if (
      new Set(
        [...labels, ...(inherited ? [inherited] : [])].map((label) =>
          canonicalSha256(label.value),
        ),
      ).size > 1
    ) {
      conflicts.push(caseId);
      imported.delete(caseId);
      continue;
    }
    imported.set(caseId, {
      value: labels[0]!.value,
      exposed:
        labels.some((label) => label.exposed) || (inherited?.exposed ?? false),
    });
  }
  return {
    labels: imported,
    conflicts,
    snapshotHash: buildStableId("annotation-snapshot", {
      importManifest,
      imported: [...imported],
      events: log.events,
    }),
  };
}

function prediction(trial: Trial): Record<string, unknown> | undefined {
  return trial.status === "success" &&
    trial.prediction &&
    typeof trial.prediction === "object"
    ? (trial.prediction as Record<string, unknown>)
    : undefined;
}

function categoricalPrediction(
  output: Record<string, unknown>,
  task: "role" | "adjudication",
): string | undefined {
  const value = task === "role" ? output.role : output.verdict;
  return typeof value === "string" ? value : undefined;
}

function percentile(values: number[], proportion: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(proportion * sorted.length) - 1] ?? null;
}

function pinsApplied(
  item: Extract<EvaluationCase, { task: "rerank" }>,
  ranking: string[],
): string[] {
  return [
    ...item.pinnedChunkIds,
    ...ranking.filter((id) => !item.pinnedChunkIds.includes(id)),
  ];
}

function rankingMetrics(
  ranking: string[],
  grades: Record<string, string>,
): { recall5: number | null; ndcg5: number | null } {
  const labeled = Object.entries(grades).filter(
    ([, grade]) => grade !== "cannot_judge",
  );
  const relevant = labeled.filter(
    ([, grade]) => grade === "direct" || grade === "contextual",
  ).length;
  const gain = (id: string) =>
    grades[id] === "direct" ? 3 : grades[id] === "contextual" ? 1 : 0;
  const visible = ranking.filter(
    (id) => grades[id] && grades[id] !== "cannot_judge",
  );
  const dcg = visible
    .slice(0, 5)
    .reduce((sum, id, index) => sum + gain(id) / Math.log2(index + 2), 0);
  const ideal = labeled
    .map(([id]) => id)
    .sort((a, b) => gain(b) - gain(a))
    .slice(0, 5)
    .reduce((sum, id, index) => sum + gain(id) / Math.log2(index + 2), 0);
  return {
    recall5: relevant
      ? visible.slice(0, 5).filter((id) => gain(id) > 0).length / relevant
      : null,
    ndcg5: ideal ? dcg / ideal : null,
  };
}

function quality(
  item: EvaluationCase,
  label: Label,
  trial: Trial,
): Record<string, number | boolean | null> | undefined {
  const output = prediction(trial);
  if (!output || item.task !== label.value.task) return undefined;
  if (item.task === "role" && label.value.task === "role")
    return { correct: output.role === label.value.role };
  if (
    item.task === "adjudication" &&
    label.value.task === "adjudication" &&
    label.value.verdict !== "not_adjudicable"
  )
    return {
      correct: output.verdict === label.value.verdict,
      falseFaithful: output.verdict === "F" && label.value.verdict !== "F",
    };
  if (
    item.task === "rerank" &&
    label.value.task === "rerank" &&
    Array.isArray(output.rankedChunkIds)
  ) {
    if (
      !Object.values(label.value.grades).some(
        (grade) => grade === "direct" || grade === "contextual",
      )
    )
      return undefined;
    const ranking = output.rankedChunkIds.filter(
      (id): id is string => typeof id === "string",
    );
    if (
      new Set(ranking).size !== item.candidates.length ||
      ranking.some(
        (id) => !item.candidates.some((candidate) => candidate.chunkId === id),
      )
    )
      return undefined;
    const before = rankingMetrics(ranking, label.value.grades);
    const after = rankingMetrics(
      pinsApplied(item, ranking),
      label.value.grades,
    );
    return {
      recall5: before.recall5,
      ndcg5: before.ndcg5,
      pinnedRecall5: after.recall5,
      pinnedNdcg5: after.ndcg5,
    };
  }
  if (item.task === "span" && label.value.task === "span") {
    const span = output.span;
    if (label.value.noValidSpan)
      return {
        noSpanAccuracy: span == null,
        exact: span == null,
        overlapPrecision: span == null ? 1 : 0,
        overlapRecall: span == null ? 1 : 0,
        overlapF1: span == null ? 1 : 0,
        validSubstring: span == null,
      };
    if (!span || typeof span !== "object")
      return {
        exact: false,
        overlapPrecision: 0,
        overlapRecall: 0,
        overlapF1: 0,
        validSubstring: false,
      };
    const s = span as { start?: unknown; end?: unknown; text?: unknown };
    const valid =
      typeof s.start === "number" &&
      typeof s.end === "number" &&
      typeof s.text === "string" &&
      item.context.slice(s.start, s.end) === s.text &&
      s.end > s.start;
    if (!valid)
      return {
        exact: false,
        overlapPrecision: 0,
        overlapRecall: 0,
        overlapF1: 0,
        validSubstring: false,
      };
    const exact = label.value.spans.some(
      (accepted) => accepted.start === s.start && accepted.end === s.end,
    );
    const overlaps = label.value.spans.map((accepted) => {
      const overlap = Math.max(
        0,
        Math.min(s.end as number, accepted.end) -
          Math.max(s.start as number, accepted.start),
      );
      const precision = overlap / ((s.end as number) - (s.start as number));
      const recall = overlap / (accepted.end - accepted.start);
      return {
        precision,
        recall,
        f1:
          precision + recall
            ? (2 * precision * recall) / (precision + recall)
            : 0,
      };
    });
    const best = overlaps.sort((a, b) => b.f1 - a.f1)[0];
    return {
      exact,
      overlapPrecision: best?.precision ?? 0,
      overlapRecall: best?.recall ?? 0,
      overlapF1: best?.f1 ?? 0,
      validSubstring: true,
    };
  }
  return undefined;
}

function mean(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

export function generateEvaluationReport(experimentId: string): {
  jsonPath: string;
  markdownPath: string;
  report: Record<string, unknown>;
} {
  const experiment = loadExperiment(experimentId);
  const dataset = loadDataset(experiment.datasetId);
  validateEvaluationDataset(experiment.datasetId);
  const trials = loadTrials(experimentId);
  const byCase = new Map(dataset.cases.map((item) => [item.caseId, item]));
  const { labels, conflicts, snapshotHash } = currentLabels(
    dataset.datasetId,
    dataset.cases,
  );
  const constructedIds = constructedCaseIds(dataset.cases);
  const providerIds = experiment.config.providers.map(
    (provider) => provider.id,
  );
  const constructedCases = scoreConstructedCases(
    dataset.cases,
    trials,
    providerIds,
  );
  const repeats = repeatAgreement(trials, providerIds);
  const groups: Record<string, unknown>[] = [];
  for (const provider of experiment.config.providers)
    for (const task of experiment.config.tasks) {
      const rows = trials.filter(
        (trial) => trial.providerId === provider.id && trial.task === task,
      );
      if (rows.length === 0) continue;
      const scoredRaw = rows.flatMap((trial) => {
        if (trial.repetition !== 1) return [];
        const item = byCase.get(trial.caseId);
        const label = labels.get(trial.caseId);
        if (!item || !label) return [];
        const metrics = quality(item, label, trial);
        return metrics ? [{ trial, item, label, metrics }] : [];
      });
      const unitPredictionConflicts: string[] = [];
      const scored =
        task === "adjudication"
          ? [
              ...new Map(
                scoredRaw.map((row) => {
                  const unitKey =
                    row.item.task === "adjudication"
                      ? row.item.unitKey
                      : row.item.caseId;
                  return [unitKey, row] as const;
                }),
              ).entries(),
            ].flatMap(([unitKey, exemplar]) => {
              const matches = scoredRaw.filter(
                (row) =>
                  `${row.item.task === "adjudication" ? row.item.unitKey : row.item.caseId}` ===
                  unitKey,
              );
              if (
                new Set(
                  matches.map((row) => JSON.stringify(prediction(row.trial))),
                ).size > 1
              ) {
                unitPredictionConflicts.push(unitKey);
                return [];
              }
              return [exemplar];
            })
          : scoredRaw;
      const blind = scored.filter((row) => !row.label.exposed);
      // Behavior on real records only; constructed cases are scored apart.
      const successfulPredictions = rows
        .filter(
          (row) => row.status === "success" && !constructedIds.has(row.caseId),
        )
        .flatMap((row) => {
          const output = prediction(row);
          return output ? [{ row, output }] : [];
        });
      const outputSummary: Record<string, unknown> =
        task === "role" || task === "adjudication"
          ? {
              predictedLabels: Object.fromEntries(
                [
                  ...new Set(
                    successfulPredictions.flatMap(({ output }) => {
                      const label = categoricalPrediction(output, task);
                      return label ? [label] : [];
                    }),
                  ),
                ].map((label) => [
                  label,
                  successfulPredictions.filter(
                    ({ output }) =>
                      categoricalPrediction(output, task) === label,
                  ).length,
                ]),
              ),
            }
          : task === "span"
            ? {
                found: successfulPredictions.filter(
                  ({ output }) => output.span != null,
                ).length,
                noSpan: successfulPredictions.filter(
                  ({ output }) => output.span == null,
                ).length,
                invalidOrFailed: rows.filter(
                  (row) => row.status !== "success" && row.status !== "pending",
                ).length,
              }
            : {
                meanTop5OverlapWithBm25: mean(
                  successfulPredictions.flatMap(({ row, output }) => {
                    const item = byCase.get(row.caseId);
                    if (
                      item?.task !== "rerank" ||
                      !Array.isArray(output.rankedChunkIds)
                    )
                      return [];
                    const top = output.rankedChunkIds
                      .filter((id): id is string => typeof id === "string")
                      .slice(0, 5);
                    return [
                      top.filter((id) =>
                        item.bm25Order.slice(0, 5).includes(id),
                      ).length / Math.min(5, item.bm25Order.length),
                    ];
                  }),
                ),
              };
      const calls = uniqueHistoricalCalls(rows);
      const historicalAccounting = historicalAttemptAccounting(rows);
      const newCalls = rows
        .filter((row) => !row.reusedFrom)
        .flatMap((row) => row.calls)
        .filter(
          (call): call is Record<string, unknown> =>
            typeof call === "object" && call != null,
        );
      const callCost = (call: unknown) => callCostUsd(call, provider);
      const costs = calls.map(callCost);
      const newCosts = newCalls.map(callCost);
      const knownCostUsd = costs.reduce<number>(
        (sum, cost) => sum + (cost ?? 0),
        0,
      );
      const unknownUsageCalls = costs.filter((cost) => cost == null).length;
      const requestLatencies = calls
        .filter((call) => typeof call.latencyMs === "number")
        .map((call) => Number(call.latencyMs));
      const durations = rows
        .filter((row) => row.status === "success")
        .map((row) => row.durationMs ?? 0);
      const completedCount = rows.filter(
        (row) => row.status === "success",
      ).length;
      const costUsd =
        provider.kind === "djev" &&
        provider.instanceHourlyUsd != null &&
        provider.billingWindowSeconds != null
          ? (provider.instanceHourlyUsd * provider.billingWindowSeconds) / 3600
          : provider.kind === "bm25" || provider.kind === "rules"
            ? 0
            : costs.length && costs.every((cost) => cost != null)
              ? costs.reduce((sum, cost) => sum + (cost ?? 0), 0)
              : null;
      const newSpendUsd =
        provider.kind === "bm25" || provider.kind === "rules"
          ? 0
          : provider.kind === "djev"
            ? null
            : newCosts.length && newCosts.every((cost) => cost != null)
              ? newCosts.reduce((sum, cost) => sum + (cost ?? 0), 0)
              : newCosts.length === 0
                ? 0
                : null;
      const firstRequestLatencyMs =
        newCalls.find((call) => call.sequence === 1)?.latencyMs ?? null;
      const subsequentRequestP50Ms = percentile(
        newCalls
          .filter(
            (call) => typeof call.sequence === "number" && call.sequence > 1,
          )
          .map((call) => Number(call.latencyMs)),
        0.5,
      );
      const providerMetadata = {
        requestedModel: provider.model,
        implementationRevision: provider.implementationRevision ?? "unknown",
        weights: provider.weights ?? "unknown",
        quantization: provider.quantization ?? "unknown",
        inferenceSettings: provider.inferenceSettings ?? "unknown",
      };
      const promptCacheUsage = {
        readTokens: calls.reduce(
          (sum, call) =>
            sum +
            (typeof call.promptCacheReadTokens === "number"
              ? call.promptCacheReadTokens
              : 0),
          0,
        ),
        writeTokens: calls.reduce(
          (sum, call) =>
            sum +
            (typeof call.promptCacheWriteTokens === "number"
              ? call.promptCacheWriteTokens
              : 0),
          0,
        ),
      };
      const metrics: Record<string, number | null> = {};
      for (const key of [
        "correct",
        "falseFaithful",
        "recall5",
        "ndcg5",
        "pinnedRecall5",
        "pinnedNdcg5",
        "exact",
        "overlapPrecision",
        "overlapRecall",
        "overlapF1",
        "validSubstring",
        "noSpanAccuracy",
      ]) {
        const values = blind
          .map((row) => row.metrics[key])
          .filter(
            (value): value is number | boolean =>
              typeof value === "number" || typeof value === "boolean",
          )
          .map((value) => Number(value));
        if (values.length) metrics[key] = mean(values);
      }
      const exposedRows = scored.filter((row) => row.label.exposed);
      const exposedMetrics: Record<string, number | null> = {};
      for (const key of Object.keys(metrics)) {
        const values = exposedRows
          .map((row) => row.metrics[key])
          .filter(
            (value): value is number | boolean =>
              typeof value === "number" || typeof value === "boolean",
          )
          .map(Number);
        if (values.length) exposedMetrics[key] = mean(values);
      }
      if (task === "role" || task === "adjudication") {
        const key = task === "role" ? "role" : "verdict";
        const confusion: Record<string, Record<string, number>> = {};
        for (const row of blind) {
          const expected =
            row.label.value.task === "role"
              ? row.label.value.role
              : row.label.value.task === "adjudication"
                ? row.label.value.verdict
                : "";
          const actual = prediction(row.trial)?.[key];
          if (typeof actual !== "string" || !expected) continue;
          const counts = confusion[expected] ?? {};
          counts[actual] = (counts[actual] ?? 0) + 1;
          confusion[expected] = counts;
        }
        const classes =
          task === "role"
            ? [
                "substantive_attribution",
                "background_context",
                "methods_materials",
                "acknowledgment_or_low_information",
                "unclear",
              ]
            : ["F", "D", "E", "U"];
        const f1 = classes.map((name) => {
          const tp = confusion[name]?.[name] ?? 0;
          const support = Object.values(confusion[name] ?? {}).reduce(
            (sum, count) => sum + count,
            0,
          );
          const predicted = Object.values(confusion).reduce(
            (sum, row) => sum + (row[name] ?? 0),
            0,
          );
          return {
            class: name,
            support,
            precision: predicted ? tp / predicted : null,
            recall: support ? tp / support : null,
            f1: support + predicted ? (2 * tp) / (support + predicted) : null,
          };
        });
        const probabilityRows = blind.flatMap((row) => {
          const expected =
            row.label.value.task === "role"
              ? row.label.value.role
              : row.label.value.task === "adjudication"
                ? row.label.value.verdict
                : undefined;
          const call = row.trial.calls.find(
            (entry) =>
              typeof entry === "object" &&
              entry != null &&
              "probabilities" in entry,
          ) as { probabilities?: Record<string, number> } | undefined;
          if (!expected || !call?.probabilities) return [];
          const values = call.probabilities;
          if (classes.some((name) => typeof values[name] !== "number"))
            return [];
          return [
            {
              goldProbability: values[expected]!,
              brier:
                classes.reduce(
                  (sum, name) =>
                    sum + (values[name]! - Number(name === expected)) ** 2,
                  0,
                ) / classes.length,
            },
          ];
        });
        const probabilityDiagnostics = {
          labeled: probabilityRows.length,
          meanGoldProbability: mean(
            probabilityRows.map((row) => row.goldProbability),
          ),
          brier: mean(probabilityRows.map((row) => row.brier)),
        };
        const scoredBlindLabels = Object.fromEntries(
          classes.map((name) => [
            name,
            blind.filter((row) =>
              row.label.value.task === "role"
                ? row.label.value.role === name
                : row.label.value.task === "adjudication"
                  ? row.label.value.verdict === name
                  : false,
            ).length,
          ]),
        );
        metrics.macroF1 = mean(
          f1.flatMap((entry) =>
            entry.support > 0 && entry.f1 != null ? [entry.f1] : [],
          ),
        );
        if (task === "role") {
          metrics.substantiveRecall = f1[0]!.recall;
          const unclear = blind.filter(
            (row) => row.item.task === "role" && row.item.deterministicUnclear,
          );
          metrics.deterministicUnclearAccuracy = mean(
            unclear.map((row) => Number(row.metrics.correct)),
          );
        } else {
          for (const name of ["D", "E"]) {
            const entry = f1.find((metric) => metric.class === name)!;
            metrics[`${name}Precision`] = entry.precision;
            metrics[`${name}Recall`] = entry.recall;
          }
        }
        groups.push({
          providerId: provider.id,
          task,
          planned: rows.length,
          success: completedCount,
          statuses: Object.fromEntries(
            [...new Set(rows.map((row) => row.status))].map((status) => [
              status,
              rows.filter((row) => row.status === status).length,
            ]),
          ),
          labeledCases: new Set(
            rows
              .filter((row) => labels.has(row.caseId))
              .map((row) =>
                task === "adjudication" &&
                byCase.get(row.caseId)?.task === "adjudication"
                  ? (
                      byCase.get(row.caseId) as Extract<
                        EvaluationCase,
                        { task: "adjudication" }
                      >
                    ).unitKey
                  : row.caseId,
              ),
          ).size,
          scoredBlind: blind.length,
          scoredExposed: scored.length - blind.length,
          unitPredictionConflicts,
          metrics,
          outputSummary,
          exposedMetrics,
          confusion,
          scoredBlindLabels,
          classMetrics: f1,
          probabilityDiagnostics,
          costUsd,
          knownCostUsd,
          unknownUsageCalls,
          newSpendUsd,
          reusedTrials: rows.filter((row) => row.reusedFrom).length,
          costPerCompletedCaseUsd:
            costUsd != null && completedCount ? costUsd / completedCount : null,
          latencyP50Ms: percentile(durations, 0.5),
          latencyP95Ms: percentile(durations, 0.95),
          requestLatencyP50Ms: percentile(requestLatencies, 0.5),
          requestLatencyP95Ms: percentile(requestLatencies, 0.95),
          firstRequestLatencyMs,
          subsequentRequestP50Ms,
          servedModels: [...new Set(calls.map((call) => call.servedModel))],
          providerMetadata,
          promptCacheUsage,
          requestCount: calls.length,
          newRequestCount: newCalls.length,
          historicalAttemptAccounting: historicalAccounting,
        });
        continue;
      }
      groups.push({
        providerId: provider.id,
        task,
        planned: rows.length,
        success: completedCount,
        statuses: Object.fromEntries(
          [...new Set(rows.map((row) => row.status))].map((status) => [
            status,
            rows.filter((row) => row.status === status).length,
          ]),
        ),
        labeledCases: new Set(
          rows.filter((row) => labels.has(row.caseId)).map((row) => row.caseId),
        ).size,
        scoredBlind: blind.length,
        scoredExposed: scored.length - blind.length,
        metrics,
        outputSummary,
        exposedMetrics,
        costUsd,
        knownCostUsd,
        unknownUsageCalls,
        newSpendUsd,
        reusedTrials: rows.filter((row) => row.reusedFrom).length,
        costPerCompletedCaseUsd:
          costUsd != null && completedCount ? costUsd / completedCount : null,
        latencyP50Ms: percentile(durations, 0.5),
        latencyP95Ms: percentile(durations, 0.95),
        requestLatencyP50Ms: percentile(requestLatencies, 0.5),
        requestLatencyP95Ms: percentile(requestLatencies, 0.95),
        firstRequestLatencyMs,
        subsequentRequestP50Ms,
        servedModels: [...new Set(calls.map((call) => call.servedModel))],
        providerMetadata,
        promptCacheUsage,
        requestCount: calls.length,
        newRequestCount: newCalls.length,
        historicalAttemptAccounting: historicalAccounting,
      });
    }
  const pairedDifferences: {
    task: string;
    left: string;
    right: string;
    commonSuccessfulCases: number;
    meanDifference: number | null;
  }[] = [];
  for (const task of experiment.config.tasks) {
    const metric =
      task === "role" || task === "adjudication"
        ? "correct"
        : task === "rerank"
          ? "ndcg5"
          : "overlapF1";
    for (let left = 0; left < experiment.config.providers.length; left++)
      for (
        let right = left + 1;
        right < experiment.config.providers.length;
        right++
      ) {
        const first = experiment.config.providers[left]!;
        const second = experiment.config.providers[right]!;
        if (
          (first.tasks && !first.tasks.includes(task)) ||
          (second.tasks && !second.tasks.includes(task))
        )
          continue;
        const scoredUnits = (providerId: string) => {
          const units = new Map<
            string,
            { value: number; predictions: Set<string> }
          >();
          for (const trial of trials.filter(
            (row) =>
              row.providerId === providerId &&
              row.task === task &&
              row.repetition === 1 &&
              row.status === "success",
          )) {
            const item = byCase.get(trial.caseId);
            const label = labels.get(trial.caseId);
            if (!item || !label || label.exposed) continue;
            const value = quality(item, label, trial)?.[metric];
            if (typeof value !== "number" && typeof value !== "boolean")
              continue;
            const unit =
              item.task === "adjudication" ? item.unitKey : item.caseId;
            const existing = units.get(unit);
            if (existing)
              existing.predictions.add(JSON.stringify(prediction(trial)));
            else
              units.set(unit, {
                value: Number(value),
                predictions: new Set([JSON.stringify(prediction(trial))]),
              });
          }
          return new Map(
            [...units.entries()]
              .filter(([, row]) => row.predictions.size === 1)
              .map(([unit, row]) => [unit, row.value]),
          );
        };
        const leftUnits = scoredUnits(first.id);
        const rightUnits = scoredUnits(second.id);
        const differences = [...leftUnits.entries()].flatMap(
          ([unit, value]) => {
            const other = rightUnits.get(unit);
            return other == null ? [] : [value - other];
          },
        );
        pairedDifferences.push({
          task,
          left: first.id,
          right: second.id,
          commonSuccessfulCases: differences.length,
          meanDifference: mean(differences),
        });
      }
  }
  const successful = trials.filter(
    (trial) =>
      trial.status === "success" && trial.completedAt && !trial.reusedFrom,
  );
  const elapsedSeconds = successful.length
    ? (Math.max(...successful.map((trial) => Date.parse(trial.completedAt!))) -
        Date.parse(experiment.createdAt)) /
      1000
    : null;
  const adjudicationUnits = new Map<string, Label>();
  for (const item of dataset.cases)
    if (item.task === "adjudication") {
      const label = labels.get(item.caseId);
      if (label) adjudicationUnits.set(item.unitKey, label);
    }
  const blindVerdictLabels: Record<string, number> = {};
  const exposedVerdictLabels: Record<string, number> = {};
  let notAdjudicableClaimUnits = 0;
  for (const label of adjudicationUnits.values())
    if (label.value.task === "adjudication") {
      if (label.value.verdict === "not_adjudicable") {
        notAdjudicableClaimUnits++;
        continue;
      }
      const counts = label.exposed ? exposedVerdictLabels : blindVerdictLabels;
      counts[label.value.verdict] = (counts[label.value.verdict] ?? 0) + 1;
    }
  const summaryPath = join(
    experimentDir(experimentId),
    "execution-summary.json",
  );
  const executionSummary: unknown = existsSync(summaryPath)
    ? JSON.parse(readFileSync(summaryPath, "utf8"))
    : null;
  const optimizationAnalysis = buildOptimizationAnalysis(
    experiment,
    trials,
    dataset.cases,
    labels,
  );
  const report = {
    schemaVersion: "evaluation-report-v1",
    builderVersion: REPORT_BUILDER_VERSION,
    experimentId,
    datasetId: dataset.datasetId,
    annotationSnapshotHash: snapshotHash,
    reportId: buildStableId("evaluation-report", {
      builderVersion: REPORT_BUILDER_VERSION,
      experimentId,
      snapshotHash,
      trials: trials.map((trial) => [
        trial.trialId,
        trial.status,
        trial.prediction ?? null,
      ]),
      optimizationAttempts: optimizationAnalysis
        ? loadOptimizationAttempts(experimentId).map((attempt) => [
            attempt.attemptId,
            attempt.status,
            attempt.completedAt ?? null,
          ])
        : [],
      optimizationAnalysis,
    }),
    generatedAt: new Date().toISOString(),
    sources: dataset.sources,
    caveat:
      "Exploratory single-seed corpus. Other runs of the same seed are not independent examples; blinded D/E/U labels are scarce. This report cannot establish safe production substitution.",
    caseCounts: Object.fromEntries(
      ["role", "rerank", "span", "adjudication"].map((task) => [
        task,
        dataset.cases.filter((item) => item.task === task).length,
      ]),
    ),
    annotationConflicts: conflicts,
    annotationCoverage: {
      roleCases: dataset.cases.filter(
        (item) => item.task === "role" && labels.has(item.caseId),
      ).length,
      rerankQueries: dataset.cases.filter(
        (item) => item.task === "rerank" && labels.has(item.caseId),
      ).length,
      spanCases: dataset.cases.filter(
        (item) => item.task === "span" && labels.has(item.caseId),
      ).length,
      adjudicationClaimUnits: adjudicationUnits.size,
      notAdjudicableClaimUnits,
      blindVerdictLabels,
      exposedVerdictLabels,
    },
    executionSummary,
    throughputCompletedCasesPerSecond:
      elapsedSeconds && elapsedSeconds > 0
        ? successful.length / elapsedSeconds
        : null,
    throughputWindow:
      "experiment creation to last newly completed trial; excludes imported compatible trials and includes any pause between resumed attempts",
    pairedDifferences,
    groups,
    constructedCases,
    repeatAgreement: repeats,
    optimization: optimizationAnalysis,
  };
  const base = join(experimentDir(experimentId), "reports", report.reportId);
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  atomicJson(jsonPath, report);
  const adjudicationGroup = groups.find(
    (group) => group.task === "adjudication" && group.success !== 0,
  );
  const scoredAdjudicationLabels =
    (adjudicationGroup?.scoredBlindLabels as
      | Record<string, number>
      | undefined) ?? {};
  const lines = [
    `# Evaluation comparison: ${experimentId}`,
    "",
    report.caveat,
    "",
    `Dataset: ${dataset.datasetId}`,
    `Annotation snapshot: ${snapshotHash}`,
    `Blind adjudication labels: ${
      Object.entries(blindVerdictLabels)
        .map(([label, count]) => `${label} ${count}`)
        .join(", ") || "none"
    }. Role, relevance, and span accuracy remain unknown until those cases receive human labels.`,
    `Adjudication labels actually scored blind: ${
      Object.entries(scoredAdjudicationLabels)
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${label} ${count}`)
        .join(", ") || "none"
    }.`,
    "",
    "| Provider | Task | Successful / planned | Reused | Blinded scored | Main metric | Task p50 / p95 ms | Request p50 / p95 ms | Model cost USD | New spend USD |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const group of groups) {
    const row = group as {
      providerId: string;
      task: string;
      success: number;
      planned: number;
      reusedTrials: number;
      scoredBlind: number;
      metrics: Record<string, number | null>;
      latencyP50Ms: number | null;
      latencyP95Ms: number | null;
      requestLatencyP50Ms: number | null;
      requestLatencyP95Ms: number | null;
      costUsd: number | null;
      newSpendUsd: number | null;
      knownCostUsd: number;
      unknownUsageCalls: number;
    };
    const main =
      row.metrics.correct ?? row.metrics.ndcg5 ?? row.metrics.overlapF1 ?? null;
    lines.push(
      `| ${row.providerId} | ${row.task} | ${row.success}/${row.planned} | ${row.reusedTrials} | ${row.scoredBlind} | ${main == null ? "unlabeled" : main.toFixed(3)} | ${row.latencyP50Ms?.toFixed(0) ?? "?"} / ${row.latencyP95Ms?.toFixed(0) ?? "?"} | ${row.requestLatencyP50Ms?.toFixed(0) ?? "?"} / ${row.requestLatencyP95Ms?.toFixed(0) ?? "?"} | ${row.costUsd?.toFixed(4) ?? "unknown"} | ${row.newSpendUsd?.toFixed(4) ?? "unknown"} |`,
    );
  }
  lines.push(
    "",
    "Task latency includes configured request spacing and retries; request latency measures the HTTP call itself.",
    ...groups
      .filter((group) => (group.unknownUsageCalls as number) > 0)
      .map(
        (group) =>
          `${String(group.providerId)} ${String(group.task)} has ${String(group.unknownUsageCalls)} request attempt${group.unknownUsageCalls === 1 ? "" : "s"} without usage; known-usage cost is $${Number(group.knownCostUsd).toFixed(4)} and full cost is unknown.`,
      ),
  );
  lines.push(
    "",
    "Output summaries below describe model behavior without human accuracy claims:",
    ...groups
      .filter((group) => (group.success as number) > 0)
      .map(
        (group) =>
          `- ${String(group.providerId)} ${String(group.task)}: ${JSON.stringify(group.outputSummary)}`,
      ),
    "",
    `Access dependencies: ${executionSummary && typeof executionSummary === "object" && "accessErrors" in executionSummary && Array.isArray(executionSummary.accessErrors) ? executionSummary.accessErrors.join("; ") : "none recorded"}.`,
    `Adjudication units with conflicting predictions were excluded from categorical agreement; see unitPredictionConflicts in JSON.`,
    `Conflicting cases excluded: ${conflicts.length}. Unknown labels remain unknown.`,
    "",
    ...constructedScoreMarkdown(constructedCases),
    ...repeatAgreementMarkdown(repeats),
  );
  if (optimizationAnalysis) {
    const analysis = optimizationAnalysis as {
      operations: {
        plannedRequests: number;
        attempts: number;
        completedResults: number;
        unknownCompletionAttempts: number;
      };
      cost: {
        knownNewSpendUsd: number;
        unknownChargeAttempts: number;
        historicalUniqueAttempts: number;
        historicalMissingTelemetryTrials: number;
        knownHistoricalSpendUsd: number;
        unknownHistoricalChargeAttempts: number;
      };
      variants: {
        variantId: string;
        task: string;
        selectedCases: number;
        completedCases: number;
        plannedRequests: number;
        firstAttemptSuccess: number;
        eventualRequestSuccess: number;
        attempts: number;
        blindHumanRoleDenominator: number;
        blindHumanRoleAccuracy: number | null;
        blindHumanRerankDenominator: number;
        blindHumanRerankNdcg5: number | null;
        blindHumanRerankPinnedNdcg5: number | null;
      }[];
      operationalRecommendations: {
        task: string;
        variantId: string | null;
        basis: string;
      }[];
      baselines: {
        experimentId: string;
        providerId: string;
        model: string;
        historicalThinking: string | null;
        historicalExperimentIds: string[];
        selectedReferenceAttempts: number;
        selectedReferenceUnknownChargeAttempts: number;
        accounting: { uniqueAttempts: number };
        unknownHistoricalChargeAttempts: number;
      }[];
      humanEvaluationShortlist: { caseId: string; rationale: string }[];
    };
    lines.push(
      "## Jev optimization",
      "",
      `Planned requests: ${analysis.operations.plannedRequests}; HTTP attempts: ${analysis.operations.attempts}; validated results: ${analysis.operations.completedResults}; interrupted or in-flight attempts with uncertain provider completion: ${analysis.operations.unknownCompletionAttempts}.`,
      `Known new model spend: $${analysis.cost.knownNewSpendUsd.toFixed(4)}; ${analysis.cost.unknownChargeAttempts} attempts have unknown charges. Referenced historical baselines represent ${analysis.cost.historicalUniqueAttempts} unique recorded attempts, $${analysis.cost.knownHistoricalSpendUsd.toFixed(4)} known historical spend, and ${analysis.cost.unknownHistoricalChargeAttempts} unknown historical charges; ${analysis.cost.historicalMissingTelemetryTrials} source trials lack attempt telemetry. Historical timings are excluded from new performance measurements.`,
      ...analysis.baselines.map(
        (item) =>
          `Historical baseline ${item.providerId} (${item.model}) from ${item.experimentId}: selected reference has ${item.selectedReferenceAttempts} recorded attempts, ${item.selectedReferenceUnknownChargeAttempts} without usage; matching original saved trials across ${item.historicalExperimentIds.length} experiments have ${item.accounting.uniqueAttempts} attempts, ${item.unknownHistoricalChargeAttempts} without usage. Attempt provenance: ${item.historicalExperimentIds.join(", ") || "none"}. ${item.historicalThinking ?? "Saved provider thinking settings are listed in JSON."}`,
      ),
      "",
      "| Variant | Completed / selected cases | First / eventual successful requests | Attempts | Blind human quality |",
      "|---|---:|---:|---:|---:|",
      ...analysis.variants.map(
        (variant) =>
          `| ${variant.variantId} | ${variant.completedCases}/${variant.selectedCases} | ${variant.firstAttemptSuccess}/${variant.plannedRequests} / ${variant.eventualRequestSuccess}/${variant.plannedRequests} | ${variant.attempts} | ${variant.task === "role" ? `role accuracy ${variant.blindHumanRoleAccuracy == null ? "unlabeled" : variant.blindHumanRoleAccuracy.toFixed(3)} (n=${variant.blindHumanRoleDenominator})` : `NDCG@5 ${variant.blindHumanRerankNdcg5 == null ? "unlabeled" : variant.blindHumanRerankNdcg5.toFixed(3)}, after pins ${variant.blindHumanRerankPinnedNdcg5 == null ? "unlabeled" : variant.blindHumanRerankPinnedNdcg5.toFixed(3)} (n=${variant.blindHumanRerankDenominator})`} |`,
      ),
      "",
      "Agreement with baselines, ranking overlap, provider confidence, answer probabilities, and repeatability are diagnostic. They do not establish scientific quality. This corpus has one seed.",
      "",
      ...analysis.operationalRecommendations.map(
        (item) =>
          `${item.task} operational recommendation: ${item.variantId ?? "pending"}. ${item.basis}`,
      ),
      "",
      `Human evaluation shortlist (${analysis.humanEvaluationShortlist.length} cases):`,
      ...analysis.humanEvaluationShortlist.map(
        (item) => `- ${item.caseId}: ${item.rationale}`,
      ),
      "",
    );
  }
  atomicText(markdownPath, lines.join("\n"));
  return { jsonPath, markdownPath, report };
}
