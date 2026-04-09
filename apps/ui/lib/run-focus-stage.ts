import type {
  AnalysisRunStage,
  LogicalStageGroup,
} from "palimpsest/ui-contract";

function isTerminalFailure(status: AnalysisRunStage["status"]): boolean {
  return (
    status === "failed" || status === "cancelled" || status === "interrupted"
  );
}

function flattenStageMembers(groups: LogicalStageGroup[]): AnalysisRunStage[] {
  return groups
    .flatMap((g) => g.members)
    .sort(
      (a, b) => a.stageOrder - b.stageOrder || a.familyIndex - b.familyIndex,
    );
}

/**
 * Member row used for run overview log, artifacts, and workflow recap: a
 * running row if any, else first failed row, else last succeeded row, else
 * the first row in pipeline / family order.
 */
export function resolveFocusStage(
  groups: LogicalStageGroup[],
): AnalysisRunStage | undefined {
  const ordered = flattenStageMembers(groups);
  if (ordered.length === 0) {
    return undefined;
  }

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
