import type {
  AnalysisRunStageStatus,
  AnalysisRunStatus,
  LogicalStageGroup,
} from "palimpsest/ui-contract";

import type { BadgeVariant } from "@/components/ui/badge";

/** Badge variant for top-level run status (dashboard, run detail header). */
export function runBadgeVariant(status: AnalysisRunStatus): BadgeVariant {
  if (status === "running") return "running";
  if (status === "succeeded") return "success";
  if (status === "queued") return "neutral";
  return "failed";
}

/** Badge variant for per-stage aggregate status (stage rail, stage detail). */
export function stageBadgeVariant(
  status: AnalysisRunStageStatus,
): BadgeVariant {
  if (status === "running") return "running";
  if (status === "succeeded") return "success";
  if (status === "stale") return "stale";
  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  ) {
    return "failed";
  }
  return "neutral";
}

/** Background segment color for pipeline progress rails (mini + full stage rail). */
export function railSegmentClass(
  status: LogicalStageGroup["aggregateStatus"],
): string {
  if (status === "succeeded") return "bg-[var(--success)]";
  if (status === "running") return "bg-[var(--accent)] opacity-70";
  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  ) {
    return "bg-[var(--danger)]";
  }
  return "bg-[var(--border-strong)]";
}
