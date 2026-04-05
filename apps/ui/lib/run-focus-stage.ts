import type { AnalysisRunStage } from "citation-fidelity/ui-contract";

function isTerminalFailure(status: AnalysisRunStage["status"]): boolean {
  return (
    status === "failed" || status === "cancelled" || status === "interrupted"
  );
}

/**
 * Stage used for run overview log, artifacts, and workflow recap: running
 * stage if any, else first failed/cancelled stage, else last succeeded, else
 * the first stage in pipeline order.
 */
export function resolveFocusStage(
  stages: AnalysisRunStage[],
): AnalysisRunStage | undefined {
  if (stages.length === 0) {
    return undefined;
  }

  const ordered = [...stages].sort((a, b) => a.stageOrder - b.stageOrder);

  const running = ordered.find((stage) => stage.status === "running");
  if (running) {
    return running;
  }

  const failed = ordered.find((stage) => isTerminalFailure(stage.status));
  if (failed) {
    return failed;
  }

  const succeeded = ordered.filter((stage) => stage.status === "succeeded");
  const lastSucceeded = succeeded[succeeded.length - 1];
  if (lastSucceeded) {
    return lastSucceeded;
  }

  return ordered[0];
}
