import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  artifactStemFromPrimaryPath,
  buildLogicalStageGroups,
  buildStageInspectorPayload,
  buildStageWorkflowSnapshot,
  computeAggregateStageStatus,
  deriveStageSummary,
  extractStageFailureDetailFromLog,
  getEnvironmentHealthSummary,
  getStageDefinition,
  isGenericStageErrorMessage,
  listStageArtifacts,
  listStageArtifactsForStem,
  type AnalysisRunStage,
  type LogicalStageGroup,
  type DashboardStats,
  type RunDetail,
  type RunStageDetail,
  type RunStageGroupDetail,
  type RunSummary,
  type RunVerdictSummary,
  type StageInspectorPayload,
  type StageKey,
} from "palimpsest/contract/server";
import {
  createAnalysisRun,
  getAnalysisRun,
  getRunStage,
  listAnalysisRuns,
  listRunStages,
  type CreateAnalysisRunInput,
} from "palimpsest/storage";

import { getDatabase } from "./database";
import {
  ensureRunDirectories,
  getRunRoot,
  getStageDirectory,
  getStageLogPath,
} from "./run-files";
import { getRepoRoot } from "./root-path";

function buildHealthSummary(groups: LogicalStageGroup[]): string {
  for (const group of groups) {
    const failed = group.members.find((m) =>
      ["failed", "cancelled", "interrupted"].includes(m.status),
    );
    if (failed) {
      return `${failed.status} at ${getStageDefinition(group.stageKey).title}`;
    }
  }

  const running = groups.find((g) => g.aggregateStatus === "running");
  if (running) {
    return `Running ${getStageDefinition(running.stageKey).title}`;
  }

  const succeeded = groups.filter(
    (g) => g.aggregateStatus === "succeeded",
  ).length;
  return `${String(succeeded)}/${String(groups.length)} stages complete`;
}

function countVerdictsFromAdjudicateInspectorRecords(
  records: StageInspectorPayload<"adjudicate">["records"],
): RunVerdictSummary {
  let supported = 0;
  let partially_supported = 0;
  let overstated_or_generalized = 0;
  let not_supported = 0;
  let cannot_determine = 0;
  let total = 0;

  for (const record of records) {
    if (record.excluded) continue;
    total++;
    const v = record.verdict ?? "";
    if (v === "supported") supported++;
    else if (v === "partially_supported") partially_supported++;
    else if (v === "overstated_or_generalized") overstated_or_generalized++;
    else if (v === "not_supported") not_supported++;
    else if (v === "cannot_determine") cannot_determine++;
  }

  return {
    supported,
    partially_supported,
    overstated_or_generalized,
    not_supported,
    cannot_determine,
    total,
  };
}

/**
 * Loads adjudicate stage artifact(s) and aggregates verdict counts (non-excluded records only).
 */
function loadAdjudicateVerdictSummaryForRun(
  database: ReturnType<typeof getDatabase>,
  runId: string,
): RunVerdictSummary | undefined {
  const adjudicateRows = attachStageSummaries(
    listRunStages(database, runId).filter((s) => s.stageKey === "adjudicate"),
    runId,
  );
  const records: StageInspectorPayload<"adjudicate">["records"] = [];
  for (const stage of adjudicateRows) {
    if (stage.status !== "succeeded") continue;
    const path = stage.primaryArtifactPath;
    if (!path) continue;
    try {
      const payload = buildStageInspectorPayload("adjudicate", path);
      records.push(...payload.records);
    } catch {
      /* artifact missing or invalid */
    }
  }
  if (records.length === 0) {
    return undefined;
  }
  return countVerdictsFromAdjudicateInspectorRecords(records);
}

function readStageLogContent(
  runId: string,
  stage: AnalysisRunStage,
): string | undefined {
  const logPath = stage.logPath ?? getStageLogPath(runId, stage.stageKey);
  try {
    const content = readFileSync(logPath, "utf8");
    if (content.trim()) return content;
  } catch {
    /* per-stage log missing or empty — fall through */
  }
  // Fallback: the supervisor tees all pipeline stdout into pipeline.log.
  // buildStageWorkflowSnapshot already filters events by stage key, so
  // passing the full pipeline log is safe for telemetry extraction.
  try {
    return readFileSync(
      resolve(getRunRoot(runId), "logs", "pipeline.log"),
      "utf8",
    );
  } catch {
    return undefined;
  }
}

function resolveStageErrorMessage(
  stage: AnalysisRunStage,
  logContent: string | undefined,
): string | undefined {
  const fromLog = logContent
    ? extractStageFailureDetailFromLog({
        stageKey: stage.stageKey,
        logContent,
      })
    : undefined;

  if (!stage.errorMessage) {
    return fromLog;
  }

  if (fromLog && isGenericStageErrorMessage(stage.errorMessage)) {
    return fromLog;
  }

  return stage.errorMessage;
}

function buildWorkflowSummary(
  runId: string,
  stage: AnalysisRunStage,
): AnalysisRunStage["summary"] {
  const logContent = readStageLogContent(runId, stage);
  const errorMessage = resolveStageErrorMessage(stage, logContent);
  const workflow = buildStageWorkflowSnapshot({
    stageKey: stage.stageKey,
    stageStatus: stage.status,
    ...(logContent ? { logContent } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  });

  return {
    headline: workflow.summary,
    metrics: workflow.counts
      ? [
          {
            label: workflow.counts.label,
            value: `${String(workflow.counts.current)}/${String(workflow.counts.total)}`,
          },
        ]
      : [],
    artifacts: [],
  };
}

function resolveArtifactSetForRow(
  runId: string,
  stage: AnalysisRunStage,
): ReturnType<typeof listStageArtifacts> {
  const dir = getStageDirectory(runId, stage.stageKey);
  if (stage.primaryArtifactPath) {
    try {
      const stem = artifactStemFromPrimaryPath(
        stage.primaryArtifactPath,
        stage.stageKey,
      );
      const byStem = listStageArtifactsForStem(stage.stageKey, dir, stem);
      if (byStem.primaryArtifactPath) {
        return byStem;
      }
    } catch {
      /* fall through */
    }
  }
  return listStageArtifacts(stage.stageKey, dir);
}

function attachStageSummaries(
  stages: AnalysisRunStage[],
  runId: string,
): AnalysisRunStage[] {
  return stages.map((stage) => {
    const logContent = readStageLogContent(runId, stage);
    const errorMessage = resolveStageErrorMessage(stage, logContent);
    const artifacts = resolveArtifactSetForRow(runId, stage);
    const primaryArtifactPath =
      stage.primaryArtifactPath ?? artifacts.primaryArtifactPath;
    const reportArtifactPath =
      stage.reportArtifactPath ?? artifacts.reportArtifactPath;
    const manifestPath = stage.manifestPath ?? artifacts.manifestPath;

    const pointers = [
      ...(primaryArtifactPath
        ? [{ kind: "primary", path: primaryArtifactPath }]
        : []),
      ...(reportArtifactPath
        ? [{ kind: "report", path: reportArtifactPath }]
        : []),
      ...(manifestPath ? [{ kind: "manifest", path: manifestPath }] : []),
      ...artifacts.extraArtifacts,
    ];

    return {
      ...stage,
      ...(errorMessage ? { errorMessage } : {}),
      primaryArtifactPath,
      reportArtifactPath,
      manifestPath,
      summary:
        stage.summary ??
        deriveStageSummary(stage.stageKey, primaryArtifactPath, pointers, {
          stageStatus: stage.status,
          ...(errorMessage ? { errorMessage } : {}),
        }) ??
        (stage.status === "not_started"
          ? undefined
          : buildWorkflowSummary(runId, stage)),
    };
  });
}

function pickActiveStageForWorkflow(
  groups: LogicalStageGroup[],
  currentStage: StageKey | undefined,
): AnalysisRunStage | undefined {
  const flat = groups.flatMap((g) => g.members);
  const running = flat.find((s) => s.status === "running");
  if (running) {
    return running;
  }
  if (currentStage) {
    const match = flat.find((s) => s.stageKey === currentStage);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export type DashboardPollPayload = {
  health: Awaited<ReturnType<typeof getEnvironmentHealthSummary>>;
  stats: DashboardStats;
  runs: RunSummary[];
};

export async function getDashboardData(): Promise<DashboardPollPayload> {
  const database = getDatabase();
  const health = await getEnvironmentHealthSummary(getRepoRoot());
  const runs: RunSummary[] = listAnalysisRuns(database).map((run) => {
    const flat = attachStageSummaries(listRunStages(database, run.id), run.id);
    const stages = buildLogicalStageGroups(flat);
    const verdictSummary =
      run.status === "succeeded"
        ? loadAdjudicateVerdictSummaryForRun(database, run.id)
        : undefined;
    return {
      ...run,
      stages,
      healthSummary: buildHealthSummary(stages),
      ...(verdictSummary ? { verdictSummary } : {}),
    };
  });

  const stats: DashboardStats = {
    totalRuns: runs.length,
    activeRuns: runs.filter(
      (r) => r.status === "running" || r.status === "queued",
    ).length,
    completedRuns: runs.filter((r) => r.status === "succeeded").length,
    failedRuns: runs.filter((r) =>
      ["failed", "cancelled", "interrupted"].includes(r.status),
    ).length,
    adjudicatedCitationTotal: runs.reduce(
      (acc, r) => acc + (r.verdictSummary?.total ?? 0),
      0,
    ),
  };

  return { health, stats, runs };
}

export function createRun(
  input: Omit<CreateAnalysisRunInput, "runRoot">,
): RunDetail {
  const database = getDatabase();
  const runRoot = ensureRunDirectories(input.id);
  const run = createAnalysisRun(database, {
    ...input,
    runRoot,
  });
  return getRunDetailOrThrow(run.id);
}

export function getRunDetailOrThrow(runId: string): RunDetail {
  const database = getDatabase();
  const run = getAnalysisRun(database, runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const flat = attachStageSummaries(listRunStages(database, runId), runId);
  const stages = buildLogicalStageGroups(flat);
  const activeStage = pickActiveStageForWorkflow(stages, run.currentStage);
  const activeLogContent = activeStage
    ? readStageLogContent(runId, activeStage)
    : undefined;
  return {
    ...run,
    stages,
    ...(activeStage
      ? {
          activeWorkflow: buildStageWorkflowSnapshot({
            stageKey: activeStage.stageKey,
            stageStatus: activeStage.status,
            ...(activeLogContent ? { logContent: activeLogContent } : {}),
            ...(activeStage.errorMessage
              ? { errorMessage: activeStage.errorMessage }
              : {}),
          }),
        }
      : {}),
  };
}

export function buildRunStageDetail<K extends StageKey>(
  runId: string,
  stage: AnalysisRunStage & { stageKey: K },
): RunStageDetail<K> {
  const stageKey = stage.stageKey;
  const artifacts = resolveArtifactSetForRow(runId, stage);
  const primaryArtifactPath =
    stage.primaryArtifactPath ?? artifacts.primaryArtifactPath;
  const reportArtifactPath =
    stage.reportArtifactPath ?? artifacts.reportArtifactPath;
  const manifestPath = stage.manifestPath ?? artifacts.manifestPath;

  const artifactPointers = [
    ...(primaryArtifactPath
      ? [{ kind: "primary", path: primaryArtifactPath }]
      : []),
    ...(reportArtifactPath
      ? [{ kind: "report", path: reportArtifactPath }]
      : []),
    ...(manifestPath ? [{ kind: "manifest", path: manifestPath }] : []),
    ...artifacts.extraArtifacts,
  ];

  let inspectorPayload: StageInspectorPayload<K> | undefined = undefined;
  const stageLogContent = readStageLogContent(runId, stage);
  let errorMessage = resolveStageErrorMessage(stage, stageLogContent);

  if (primaryArtifactPath) {
    try {
      inspectorPayload = buildStageInspectorPayload(
        stageKey,
        primaryArtifactPath,
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  const durationMs =
    stage.startedAt == null
      ? undefined
      : Math.max(
          0,
          new Date(stage.finishedAt ?? new Date().toISOString()).getTime() -
            new Date(stage.startedAt).getTime(),
        );
  return {
    ...stage,
    stageTitle: getStageDefinition(stageKey).title,
    durationMs,
    artifactPointers,
    primaryArtifactPath,
    reportArtifactPath,
    manifestPath,
    inspectorPayload,
    errorMessage,
    workflow: buildStageWorkflowSnapshot({
      stageKey,
      stageStatus: stage.status,
      ...(stageLogContent ? { logContent: stageLogContent } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    }),
  } as RunStageDetail<K>;
}

/** Single family row (default family 0). */
export function getStageDetailOrThrow<K extends StageKey>(
  runId: string,
  stageKey: K,
  familyIndex = 0,
): RunStageDetail<K> {
  const database = getDatabase();
  const run = getAnalysisRun(database, runId);
  const stage = getRunStage(database, runId, stageKey, familyIndex);

  if (!run || !stage) {
    throw new Error("Run stage not found.");
  }

  const enriched = attachStageSummaries([stage], runId)[0]!;
  return buildRunStageDetail(
    runId,
    enriched as AnalysisRunStage & { stageKey: K },
  );
}

export function getStageGroupDetailOrThrow<K extends StageKey>(
  runId: string,
  stageKey: K,
): RunStageGroupDetail<K> {
  const database = getDatabase();
  const run = getAnalysisRun(database, runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const flat = attachStageSummaries(listRunStages(database, runId), runId);
  const members = flat
    .filter((s) => s.stageKey === stageKey)
    .sort((a, b) => a.familyIndex - b.familyIndex);

  if (members.length === 0) {
    throw new Error("Run stage not found.");
  }

  return {
    stageKey,
    stageTitle: getStageDefinition(stageKey).title,
    aggregateStatus: computeAggregateStageStatus(members),
    members: members.map((m) =>
      buildRunStageDetail(runId, m as AnalysisRunStage & { stageKey: K }),
    ),
  } as RunStageGroupDetail<K>;
}

export function getLogTail(
  runId: string,
  stageKey: StageKey,
  familyIndex?: number,
): string {
  const database = getDatabase();
  const path =
    familyIndex != null
      ? (getRunStage(database, runId, stageKey, familyIndex)?.logPath ??
        getStageLogPath(runId, stageKey))
      : getStageLogPath(runId, stageKey);

  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    /* per-stage log not available */
  }

  // Filter out CF_PROGRESS JSON lines — the log panel shows human-readable output only
  const lines = raw
    .split("\n")
    .filter((line) => !line.startsWith("CF_PROGRESS "));
  return lines.slice(-400).join("\n");
}

export function getArtifactContent(
  runId: string,
  stageKey: StageKey,
  kind: string,
  familyIndex = 0,
): { content: string; path: string } {
  const detail = getStageDetailOrThrow(runId, stageKey, familyIndex);
  const pointer = detail.artifactPointers.find((entry) => entry.kind === kind);
  if (!pointer) {
    throw new Error(`Artifact not found for kind "${kind}".`);
  }

  return {
    content: readFileSync(pointer.path, "utf8"),
    path: pointer.path,
  };
}

export type RunCostPurposeSummary = {
  attempted: number;
  successful: number;
  failed: number;
  billable: number;
  exactCacheHits: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
};

export type RunCostSummary = {
  totalEstimatedCostUsd: number;
  totalCalls: number;
  totalAttemptedCalls: number;
  totalSuccessfulCalls: number;
  totalFailedCalls: number;
  totalBillableCalls: number;
  totalExactCacheHits: number;
  byStage: Array<{
    stage: string;
    familyIndex: number;
    estimatedCostUsd: number;
    calls: number;
    attemptedCalls: number;
    successfulCalls: number;
    failedCalls: number;
    billableCalls: number;
    exactCacheHits: number;
  }>;
  byPurpose?: Record<string, RunCostPurposeSummary>;
  source: "cost_file" | "adjudicate_artifacts";
};

/**
 * Read cost data for a run: first try the pipeline-generated `_run-cost.json`,
 * then fall back to summing `runTelemetry` from adjudicate artifacts.
 */
export function getRunCostSummary(runId: string): RunCostSummary | undefined {
  const runRoot = getRunRoot(runId);

  const costFile = readdirSync(runRoot)
    .filter((f) => f.endsWith("_run-cost.json"))
    .sort()
    .at(-1);

  if (costFile) {
    try {
      const raw = JSON.parse(
        readFileSync(`${runRoot}/${costFile}`, "utf8"),
      ) as Record<string, unknown>;
      return {
        totalEstimatedCostUsd: Number(raw["totalEstimatedCostUsd"] ?? 0),
        totalCalls: Number(raw["totalCalls"] ?? 0),
        totalAttemptedCalls: Number(
          raw["totalAttemptedCalls"] ?? raw["totalCalls"] ?? 0,
        ),
        totalSuccessfulCalls: Number(raw["totalSuccessfulCalls"] ?? 0),
        totalFailedCalls: Number(raw["totalFailedCalls"] ?? 0),
        totalBillableCalls: Number(raw["totalBillableCalls"] ?? 0),
        totalExactCacheHits: Number(raw["totalExactCacheHits"] ?? 0),
        byStage: ((raw["byStage"] as RunCostSummary["byStage"]) ?? []).map(
          (entry) => ({
            ...entry,
            attemptedCalls: Number(entry.attemptedCalls ?? entry.calls ?? 0),
            successfulCalls: Number(entry.successfulCalls ?? 0),
            failedCalls: Number(entry.failedCalls ?? 0),
            billableCalls: Number(entry.billableCalls ?? 0),
            exactCacheHits: Number(entry.exactCacheHits ?? 0),
          }),
        ),
        ...(raw["byPurpose"] != null
          ? {
              byPurpose: raw["byPurpose"] as Record<
                string,
                RunCostPurposeSummary
              >,
            }
          : {}),
        source: "cost_file",
      };
    } catch {
      /* fall through */
    }
  }

  const database = getDatabase();
  const stages = listRunStages(database, runId);
  const adjudicateStages = stages.filter(
    (s) => s.stageKey === "adjudicate" && s.status === "succeeded",
  );
  if (adjudicateStages.length === 0) return undefined;

  const entries: RunCostSummary["byStage"] = [];
  for (const stage of adjudicateStages) {
    if (!stage.primaryArtifactPath || !existsSync(stage.primaryArtifactPath)) {
      continue;
    }
    try {
      const payload = buildStageInspectorPayload(
        "adjudicate",
        stage.primaryArtifactPath,
      ) as Record<string, unknown>;
      const telemetry = payload["runTelemetry"] as
        | Record<string, unknown>
        | undefined;
      if (telemetry && typeof telemetry["estimatedCostUsd"] === "number") {
        entries.push({
          stage: "adjudicate",
          familyIndex: stage.familyIndex ?? 0,
          estimatedCostUsd: telemetry["estimatedCostUsd"],
          calls: Number(telemetry["totalCalls"] ?? 0),
          attemptedCalls: Number(telemetry["totalCalls"] ?? 0),
          successfulCalls: Number(telemetry["successfulCalls"] ?? 0),
          failedCalls: Number(telemetry["failedCalls"] ?? 0),
          billableCalls: Number(telemetry["successfulCalls"] ?? 0),
          exactCacheHits: 0,
        });
      }
    } catch {
      /* skip */
    }
  }

  if (entries.length === 0) return undefined;

  return {
    totalEstimatedCostUsd: entries.reduce(
      (sum, e) => sum + e.estimatedCostUsd,
      0,
    ),
    totalCalls: entries.reduce((sum, e) => sum + e.calls, 0),
    totalAttemptedCalls: entries.reduce((sum, e) => sum + e.attemptedCalls, 0),
    totalSuccessfulCalls: entries.reduce(
      (sum, e) => sum + e.successfulCalls,
      0,
    ),
    totalFailedCalls: entries.reduce((sum, e) => sum + e.failedCalls, 0),
    totalBillableCalls: entries.reduce((sum, e) => sum + e.billableCalls, 0),
    totalExactCacheHits: 0,
    byStage: entries,
    source: "adjudicate_artifacts",
  };
}
