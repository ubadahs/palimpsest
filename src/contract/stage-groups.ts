import { stageDefinitions } from "./stages.js";
import type {
  AnalysisRunStage,
  AnalysisRunStageStatus,
  AnalysisStageSummary,
  LogicalStageGroup,
  StageKey,
} from "./run-types.js";

const TERMINAL: ReadonlySet<AnalysisRunStageStatus> = new Set([
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Roll up per-family stage rows into one status for the stage rail / overview.
 */
export function computeAggregateStageStatus(
  members: AnalysisRunStage[],
): AnalysisRunStageStatus {
  if (members.length === 0) {
    return "not_started";
  }
  const ordered = [...members].sort((a, b) => a.familyIndex - b.familyIndex);
  if (ordered.some((m) => m.status === "running")) {
    return "running";
  }
  const terminal = ordered.find((m) => TERMINAL.has(m.status));
  if (terminal) {
    return terminal.status;
  }
  if (ordered.every((m) => m.status === "succeeded")) {
    return "succeeded";
  }
  if (ordered.some((m) => m.status === "stale")) {
    return "stale";
  }
  if (ordered.some((m) => m.status === "blocked")) {
    return "blocked";
  }
  return ordered[0]!.status;
}

function mergeGroupSummary(
  members: AnalysisRunStage[],
  aggregateStatus: AnalysisRunStageStatus,
): AnalysisStageSummary | undefined {
  if (members.length === 1) {
    return members[0]!.summary;
  }

  const succ = members.filter((m) => m.status === "succeeded").length;
  const run = members.filter((m) => m.status === "running").length;
  const fail = members.filter((m) => TERMINAL.has(m.status)).length;
  const stale = members.filter((m) => m.status === "stale").length;

  let headline: string;
  if (run > 0) {
    headline = `${String(run)} family pipeline(s) running`;
  } else if (fail > 0) {
    headline = `${String(fail)} family pipeline(s) stopped with errors`;
  } else if (aggregateStatus === "stale" || stale > 0) {
    headline = "Some family outputs are stale — rerun upstream stages";
  } else if (succ === members.length) {
    headline = `All ${String(members.length)} families complete`;
  } else {
    headline = `${String(succ)}/${String(members.length)} families complete`;
  }

  const metrics = [
    { label: "Families", value: String(members.length) },
    { label: "Succeeded", value: String(succ) },
  ];
  if (run > 0) {
    metrics.push({ label: "Running", value: String(run) });
  }
  if (fail > 0) {
    metrics.push({ label: "Failed", value: String(fail) });
  }

  const artifacts =
    members.find((m) => m.familyIndex === 0)?.summary?.artifacts ?? [];

  return { headline, metrics, artifacts };
}

/**
 * Group flat DB stage rows into one logical stage per canonical stage key.
 */
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
    const members = (byKey.get(def.key) ?? []).sort(
      (a, b) => a.familyIndex - b.familyIndex,
    );
    if (members.length === 0) {
      return [];
    }
    const aggregateStatus = computeAggregateStageStatus(members);
    const summary = mergeGroupSummary(members, aggregateStatus);
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
