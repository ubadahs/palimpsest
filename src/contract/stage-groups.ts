import { stageDefinitions, type StageKey } from "./lean-stages.js";
import type {
  AnalysisRunStage,
  AnalysisRunStageStatus,
  AnalysisStageSummary,
  LogicalStageGroup,
} from "./run-types.js";

const TERMINAL: ReadonlySet<AnalysisRunStageStatus> = new Set([
  "failed",
  "cancelled",
  "interrupted",
]);

/** Resolve the status for a canonical stage's single registry row. */
export function computeAggregateStageStatus(
  members: AnalysisRunStage[],
): AnalysisRunStageStatus {
  if (members.length === 0) {
    return "not_started";
  }
  if (members.some((m) => m.status === "running")) {
    return "running";
  }
  const terminal = members.find((m) => TERMINAL.has(m.status));
  if (terminal) {
    return terminal.status;
  }
  if (members.every((m) => m.status === "succeeded")) {
    return "succeeded";
  }
  if (members.some((m) => m.status === "stale")) {
    return "stale";
  }
  if (members.some((m) => m.status === "blocked")) {
    return "blocked";
  }
  return members[0]!.status;
}

function mergeGroupSummary(
  members: AnalysisRunStage[],
): AnalysisStageSummary | undefined {
  return members[0]?.summary;
}

/** Group the six flat DB rows into one logical entry per canonical stage. */
export function buildLogicalStageGroups(
  flat: AnalysisRunStage[],
): LogicalStageGroup[] {
  const byKey = new Map<StageKey, AnalysisRunStage[]>();
  for (const row of flat) {
    const list = byKey.get(row.stageKey) ?? [];
    list.push(row);
    byKey.set(row.stageKey, list);
  }

  return stageDefinitions.flatMap((def) => {
    const members = byKey.get(def.key) ?? [];
    if (members.length === 0) {
      return [];
    }
    if (members.length !== 1) {
      throw new Error(
        `Canonical stage ${def.key} must have exactly one registry row`,
      );
    }
    const aggregateStatus = computeAggregateStageStatus(members);
    const summary = mergeGroupSummary(members);
    const group: LogicalStageGroup = {
      stageKey: def.key,
      stageOrder: def.order,
      aggregateStatus,
      members,
      ...(summary !== undefined ? { summary } : {}),
    };
    return [group];
  });
}
