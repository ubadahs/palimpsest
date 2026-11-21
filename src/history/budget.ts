import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { artifactIdSchema } from "../contract/artifacts/primitives.js";
import {
  rebuildRunCostSummary,
  type RunCostSummary,
} from "../pipeline/cost-summary.js";

export function hasUnresolvedSpend(summary: RunCostSummary): boolean {
  return (
    summary.unknownCostCalls > 0 ||
    (summary.unresolvedModelAttempts ?? 0) > 0 ||
    (summary.incompleteJournals ?? 0) > 0
  );
}

export function remainingBudget(
  limit: number,
  summary: RunCostSummary,
): number {
  return hasUnresolvedSpend(summary)
    ? 0
    : Math.max(0, limit - summary.totalEstimatedCostUsd);
}

/** A combined run pays for histories of superseded Reports as well. The active
 * Report's own history tracker subtracts its prior spend during the handoff. */
export function budgetAfterOtherHistories(
  runRoot: string,
  limit: number,
  excludeReportId?: string,
): number {
  const root = resolve(runRoot, "history");
  if (!existsSync(root)) return limit;
  let remaining = limit;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      entry.name !== excludeReportId &&
      artifactIdSchema.safeParse(entry.name).success
    ) {
      remaining = remainingBudget(
        remaining,
        rebuildRunCostSummary(resolve(root, entry.name)),
      );
    }
  }
  return remaining;
}
