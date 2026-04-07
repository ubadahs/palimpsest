import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  canRunFromStage,
  findActiveRun,
  getAnalysisRun,
  getClaimGateBlockReasonForRun,
  getRunStage,
  listRunningStages,
  listRunStages,
  markDownstreamStagesStale,
  markRunInterrupted,
  setRunStatus,
  setStageInputArtifact,
  updateStageStatus,
} from "palimpsest/storage";
import {
  extractStageFailureDetailFromLog,
  getStageDefinition,
  stageDefinitions,
  type AnalysisRun,
  type StageKey,
} from "palimpsest/ui-contract";
import {
  deriveStageSummary,
  listStageArtifacts,
} from "palimpsest/ui-contract/server";

import { getDatabase } from "./database";
import {
  buildStageCommand,
  canRerunStage,
  resolveStartStage,
} from "./run-command-builder";
import { getRepoRoot } from "./root-path";
import {
  getShortlistPath,
  getStageDirectory,
  getStageLogPath,
} from "./run-files";

function assertClaimGateAllowsDownstream(
  run: AnalysisRun,
  stages: { stageKey: StageKey; primaryArtifactPath?: string | undefined }[],
  startStage: StageKey,
): void {
  const preOrder = getStageDefinition("screen").order;
  const startOrder = getStageDefinition(startStage).order;
  if (startOrder <= preOrder) {
    return;
  }
  const preStage = stages.find((s) => s.stageKey === "screen");
  const blockReason = getClaimGateBlockReasonForRun(
    preStage?.primaryArtifactPath,
    run.seedDoi,
  );
  if (blockReason) {
    throw new Error(blockReason);
  }
}

type ActiveChild = {
  runId: string;
  stageKey: StageKey;
  child: ChildProcessWithoutNullStreams;
  cancelRequested: boolean;
};

type RunSupervisorState = {
  activeChildren: Map<string, ActiveChild>;
  ready: boolean;
};

declare global {
  var __citationFidelityRunSupervisor: RunSupervisorState | undefined;
}

function getState(): RunSupervisorState {
  if (!globalThis.__citationFidelityRunSupervisor) {
    globalThis.__citationFidelityRunSupervisor = {
      activeChildren: new Map<string, ActiveChild>(),
      ready: false,
    };
  }

  return globalThis.__citationFidelityRunSupervisor;
}

function isProcessAlive(processId: number | undefined): boolean {
  if (!processId) {
    return false;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLog(logPath: string, chunk: string): void {
  mkdirSync(logPath.replace(/\/[^/]+$/, ""), { recursive: true });
  appendFileSync(logPath, chunk, "utf8");
}

function defaultExitErrorMessage(exitCode: number | null): string {
  return `Command exited with code ${String(exitCode ?? 1)}.`;
}

function resolveFailedStageErrorMessage(
  stageKey: StageKey,
  logPath: string,
  exitCode: number | null,
): string {
  try {
    const detail = extractStageFailureDetailFromLog({
      stageKey,
      logContent: readFileSync(logPath, "utf8"),
    });
    return detail ?? defaultExitErrorMessage(exitCode);
  } catch {
    return defaultExitErrorMessage(exitCode);
  }
}

async function runStage(
  run: AnalysisRun,
  stageKey: StageKey,
): Promise<"succeeded" | "failed" | "cancelled"> {
  const database = getDatabase();
  const currentStages = listRunStages(database, run.id);
  const spec = buildStageCommand(run, currentStages, stageKey);
  const stage = getRunStage(database, run.id, stageKey);
  const logPath = stage?.logPath ?? getStageLogPath(run.id, stageKey);
  const startedAt = new Date().toISOString();
  writeLog(
    logPath,
    `\n=== ${startedAt} :: ${spec.command} ${spec.args.slice(1).join(" ")} ===\n`,
  );

  if (spec.inputArtifactPath) {
    setStageInputArtifact(database, run.id, stageKey, spec.inputArtifactPath);
  }
  const runningOptions: {
    inputArtifactPath?: string;
    startedAt: string;
    finishedAt?: string;
    errorMessage?: string;
    exitCode?: number;
    processId?: number;
    primaryArtifactPath?: string;
    reportArtifactPath?: string;
    manifestPath?: string;
  } = {
    startedAt,
  };
  if (spec.inputArtifactPath) {
    runningOptions.inputArtifactPath = spec.inputArtifactPath;
  }
  updateStageStatus(database, run.id, stageKey, "running", {
    ...runningOptions,
  });
  setRunStatus(database, run.id, "running", stageKey);

  const child = spawn("npm", ["run", "cli", "--", ...spec.args], {
    cwd: getRepoRoot(),
    env: process.env,
    stdio: "pipe",
  });
  const activeChild: ActiveChild = {
    runId: run.id,
    stageKey,
    child,
    cancelRequested: false,
  };
  getState().activeChildren.set(run.id, activeChild);
  const activeOptions: {
    inputArtifactPath?: string;
    startedAt: string;
    processId?: number;
  } = {
    startedAt,
  };
  if (spec.inputArtifactPath) {
    activeOptions.inputArtifactPath = spec.inputArtifactPath;
  }
  if (child.pid) {
    activeOptions.processId = child.pid;
  }
  updateStageStatus(database, run.id, stageKey, "running", activeOptions);

  child.stdout.on("data", (chunk) => {
    writeLog(logPath, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    writeLog(logPath, chunk.toString("utf8"));
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  getState().activeChildren.delete(run.id);
  const finishedAt = new Date().toISOString();

  if (activeChild.cancelRequested) {
    const cancelledOptions: {
      inputArtifactPath?: string;
      finishedAt: string;
      errorMessage: string;
      exitCode: number;
    } = {
      finishedAt,
      errorMessage: "Cancelled by user.",
      exitCode: exitCode ?? 130,
    };
    if (spec.inputArtifactPath) {
      cancelledOptions.inputArtifactPath = spec.inputArtifactPath;
    }
    updateStageStatus(
      database,
      run.id,
      stageKey,
      "cancelled",
      cancelledOptions,
    );
    setRunStatus(database, run.id, "cancelled", stageKey);
    return "cancelled";
  }

  if (exitCode !== 0) {
    const failedOptions: {
      inputArtifactPath?: string;
      finishedAt: string;
      errorMessage: string;
      exitCode: number;
    } = {
      finishedAt,
      errorMessage: resolveFailedStageErrorMessage(
        stageKey,
        logPath,
        exitCode,
      ),
      exitCode: exitCode ?? 1,
    };
    if (spec.inputArtifactPath) {
      failedOptions.inputArtifactPath = spec.inputArtifactPath;
    }
    updateStageStatus(database, run.id, stageKey, "failed", failedOptions);
    setRunStatus(database, run.id, "failed", stageKey);
    return "failed";
  }

  const artifactSet = listStageArtifacts(
    stageKey,
    getStageDirectory(run.id, stageKey),
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
  const summary = deriveStageSummary(
    stageKey,
    artifactSet.primaryArtifactPath,
    artifactPointers,
  );

  const successOptions: {
    inputArtifactPath?: string;
    primaryArtifactPath?: string;
    reportArtifactPath?: string;
    manifestPath?: string;
    summary?: NonNullable<ReturnType<typeof deriveStageSummary>>;
    finishedAt: string;
    exitCode: number;
  } = {
    finishedAt,
    exitCode: 0,
  };
  if (spec.inputArtifactPath) {
    successOptions.inputArtifactPath = spec.inputArtifactPath;
  }
  if (artifactSet.primaryArtifactPath) {
    successOptions.primaryArtifactPath = artifactSet.primaryArtifactPath;
  }
  if (artifactSet.reportArtifactPath) {
    successOptions.reportArtifactPath = artifactSet.reportArtifactPath;
  }
  if (artifactSet.manifestPath) {
    successOptions.manifestPath = artifactSet.manifestPath;
  }
  if (summary) {
    successOptions.summary = summary;
  }
  updateStageStatus(database, run.id, stageKey, "succeeded", successOptions);

  // After discover succeeds, copy its shortlist to inputs/shortlist.json
  // so that the screen stage can find it via getShortlistPath().
  if (stageKey === "discover") {
    const shortlistExtra = artifactSet.extraArtifacts.find((a) =>
      a.path.endsWith("_discovery-shortlist.json"),
    );
    if (shortlistExtra) {
      copyFileSync(shortlistExtra.path, getShortlistPath(run.id));
    }
  }

  return "succeeded";
}

async function runSequentially(
  run: AnalysisRun,
  startStage: StageKey,
  stopAfterStage: StageKey,
  markStaleAfterSuccess: boolean,
): Promise<void> {
  const database = getDatabase();
  const orderedStages = stageDefinitions.filter((stage) => {
    const order = getStageDefinition(stage.key).order;
    return (
      order >= getStageDefinition(startStage).order &&
      order <= getStageDefinition(stopAfterStage).order
    );
  });

  for (const [index, stage] of orderedStages.entries()) {
    const status = await runStage(run, stage.key);
    if (status !== "succeeded") {
      return;
    }

    if (markStaleAfterSuccess && index === 0) {
      markDownstreamStagesStale(database, run.id, stage.key);
    }
  }

  setRunStatus(database, run.id, "succeeded", stopAfterStage);
}

export function ensureRunSupervisorReady(): void {
  const state = getState();
  if (state.ready) {
    return;
  }

  const database = getDatabase();

  for (const stage of listRunningStages(database)) {
    if (!isProcessAlive(stage.processId)) {
      markRunInterrupted(
        database,
        stage.runId,
        stage.stageKey,
        "Marked interrupted during UI startup reconciliation.",
      );
    }
  }

  state.ready = true;
}

export async function startRun(runId: string): Promise<void> {
  ensureRunSupervisorReady();
  const database = getDatabase();
  const run = getAnalysisRun(database, runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const active = findActiveRun(database);
  if (active && active.id !== runId) {
    throw new Error(`Run ${active.id} is already active.`);
  }

  const stages = listRunStages(database, runId);
  const startStage = resolveStartStage(run, stages);
  const gate = canRunFromStage(stages, startStage);
  if (!gate.ok) {
    throw new Error(gate.reason);
  }

  assertClaimGateAllowsDownstream(run, stages, startStage);

  void runSequentially(run, startStage, run.targetStage, false);
}

export async function rerunStage(
  runId: string,
  stageKey: StageKey,
): Promise<void> {
  ensureRunSupervisorReady();
  const database = getDatabase();
  const run = getAnalysisRun(database, runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const active = findActiveRun(database);
  if (active) {
    throw new Error(`Run ${active.id} is already active.`);
  }

  const stages = listRunStages(database, runId);
  if (!canRerunStage(stages, stageKey)) {
    throw new Error(
      `Cannot rerun ${stageKey} before its upstream stage succeeds.`,
    );
  }

  assertClaimGateAllowsDownstream(run, stages, stageKey);

  void runSequentially(run, stageKey, stageKey, true);
}

export function cancelRun(runId: string): void {
  const database = getDatabase();
  const active = getState().activeChildren.get(runId);
  if (active) {
    active.cancelRequested = true;
    active.child.kill("SIGTERM");
    return;
  }

  const run = getAnalysisRun(database, runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const runningStage = listRunStages(database, runId).find(
    (stage) => stage.status === "running",
  );
  if (!runningStage) {
    throw new Error("Run is not active.");
  }

  if (runningStage.processId && isProcessAlive(runningStage.processId)) {
    process.kill(runningStage.processId, "SIGTERM");
  }
  updateStageStatus(database, runId, runningStage.stageKey, "cancelled", {
    finishedAt: new Date().toISOString(),
    errorMessage: "Cancelled by user.",
  });
  setRunStatus(database, runId, "cancelled", runningStage.stageKey);
}
