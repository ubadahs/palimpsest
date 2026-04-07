import { readFileSync } from "node:fs";

import {
  buildStageWorkflowSnapshot,
  buildStageInspectorPayload,
  deriveStageSummary,
  extractStageFailureDetailFromLog,
  getEnvironmentHealthSummary,
  getStageDefinition,
  isGenericStageErrorMessage,
  listStageArtifacts,
  type AnalysisRunStage,
  type RunDetail,
  type RunStageDetail,
  type RunSummary,
  type StageKey,
} from "palimpsest/ui-contract/server";
import {
  createAnalysisRun,
  getAnalysisRun,
  getRunStage,
  listAnalysisRuns,
  listRunStages,
  type CreateAnalysisRunInput,
} from "palimpsest/storage";

import { getDatabase } from "./database";
import { ensureRunDirectories, getStageDirectory } from "./run-files";
import { getRepoRoot } from "./root-path";

function buildHealthSummary(stages: AnalysisRunStage[]): string {
  const failed = stages.find((stage) =>
    ["failed", "cancelled", "interrupted"].includes(stage.status),
  );
  if (failed) {
    return `${failed.status} at ${getStageDefinition(failed.stageKey).title}`;
  }

  const succeeded = stages.filter(
    (stage) => stage.status === "succeeded",
  ).length;
  const running = stages.find((stage) => stage.status === "running");
  if (running) {
    return `Running ${getStageDefinition(running.stageKey).title}`;
  }

  return `${String(succeeded)}/${String(stages.length)} complete`;
}

function readStageLogContent(stage: AnalysisRunStage): string | undefined {
  if (!stage.logPath) {
    return undefined;
  }

  try {
    return readFileSync(stage.logPath, "utf8");
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
  stage: AnalysisRunStage,
): AnalysisRunStage["summary"] {
  const logContent = readStageLogContent(stage);
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

function attachStageSummaries(
  stages: AnalysisRunStage[],
  runId: string,
): AnalysisRunStage[] {
  return stages.map((stage) => {
    const logContent = readStageLogContent(stage);
    const errorMessage = resolveStageErrorMessage(stage, logContent);
    const artifacts = listStageArtifacts(
      stage.stageKey,
      getStageDirectory(runId, stage.stageKey),
    );
    const pointers = [
      ...(artifacts.primaryArtifactPath
        ? [{ kind: "primary", path: artifacts.primaryArtifactPath }]
        : []),
      ...(artifacts.reportArtifactPath
        ? [{ kind: "report", path: artifacts.reportArtifactPath }]
        : []),
      ...(artifacts.manifestPath
        ? [{ kind: "manifest", path: artifacts.manifestPath }]
        : []),
      ...artifacts.extraArtifacts,
    ];

    return {
      ...stage,
      ...(errorMessage ? { errorMessage } : {}),
      primaryArtifactPath:
        artifacts.primaryArtifactPath ?? stage.primaryArtifactPath,
      reportArtifactPath:
        artifacts.reportArtifactPath ?? stage.reportArtifactPath,
      manifestPath: artifacts.manifestPath ?? stage.manifestPath,
      summary:
        stage.summary ??
        deriveStageSummary(
          stage.stageKey,
          artifacts.primaryArtifactPath,
          pointers,
          {
            stageStatus: stage.status,
            ...(errorMessage ? { errorMessage } : {}),
          },
        ) ??
        (stage.status === "not_started"
          ? undefined
          : buildWorkflowSummary(stage)),
    };
  });
}

export async function getDashboardData(): Promise<{
  health: Awaited<ReturnType<typeof getEnvironmentHealthSummary>>;
  runs: RunSummary[];
}> {
  const database = getDatabase();
  const health = await getEnvironmentHealthSummary(getRepoRoot());
  const runs = listAnalysisRuns(database).map((run) => {
    const stages = attachStageSummaries(
      listRunStages(database, run.id),
      run.id,
    );
    return {
      ...run,
      stages,
      healthSummary: buildHealthSummary(stages),
    };
  });

  return { health, runs };
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

  const stages = attachStageSummaries(listRunStages(database, runId), runId);
  const activeStage =
    stages.find((stage) => stage.status === "running") ??
    stages.find((stage) => stage.stageKey === run.currentStage);
  const activeLogContent = activeStage
    ? readStageLogContent(activeStage)
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

export function getStageDetailOrThrow(
  runId: string,
  stageKey: StageKey,
): RunStageDetail {
  const database = getDatabase();
  const run = getAnalysisRun(database, runId);
  const stage = getRunStage(database, runId, stageKey);

  if (!run || !stage) {
    throw new Error("Run stage not found.");
  }

  const artifactSet = listStageArtifacts(
    stageKey,
    getStageDirectory(runId, stageKey),
  );
  const artifactPointers = [
    ...(artifactSet.primaryArtifactPath
      ? [{ kind: "primary", path: artifactSet.primaryArtifactPath }]
      : []),
    ...(artifactSet.reportArtifactPath
      ? [{ kind: "report", path: artifactSet.reportArtifactPath }]
      : []),
    ...(artifactSet.manifestPath
      ? [{ kind: "manifest", path: artifactSet.manifestPath }]
      : []),
    ...artifactSet.extraArtifacts,
  ];

  let inspectorPayload: unknown = undefined;
  const stageLogContent = readStageLogContent(stage);
  let errorMessage = resolveStageErrorMessage(stage, stageLogContent);
  const primaryArtifactPath =
    artifactSet.primaryArtifactPath ?? stage.primaryArtifactPath;

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
    reportArtifactPath:
      artifactSet.reportArtifactPath ?? stage.reportArtifactPath,
    manifestPath: artifactSet.manifestPath ?? stage.manifestPath,
    inspectorPayload,
    errorMessage,
    workflow: buildStageWorkflowSnapshot({
      stageKey,
      stageStatus: stage.status,
      ...(stageLogContent ? { logContent: stageLogContent } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    }),
  };
}

export function getLogTail(runId: string, stageKey: StageKey): string {
  const stage = getRunStage(getDatabase(), runId, stageKey);
  if (!stage?.logPath) {
    return "";
  }

  try {
    const lines = readFileSync(stage.logPath, "utf8").split("\n");
    return lines.slice(-400).join("\n");
  } catch {
    return "";
  }
}

export function getArtifactContent(
  runId: string,
  stageKey: StageKey,
  kind: string,
): { content: string; path: string } {
  const detail = getStageDetailOrThrow(runId, stageKey);
  const pointer = detail.artifactPointers.find((entry) => entry.kind === kind);
  if (!pointer) {
    throw new Error(`Artifact not found for kind "${kind}".`);
  }

  return {
    content: readFileSync(pointer.path, "utf8"),
    path: pointer.path,
  };
}
