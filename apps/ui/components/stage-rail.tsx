import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import {
  getStageDefinition,
  type LogicalStageGroup,
  type RunDetail,
} from "palimpsest/ui-contract";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDuration } from "@/lib/utils";

function badgeVariant(
  status: string,
): "neutral" | "running" | "success" | "failed" | "stale" {
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

function railSegmentClass(
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

function groupTimeBounds(group: LogicalStageGroup): {
  startedAt: string | undefined;
  finishedAt: string | undefined;
} {
  const started = group.members
    .map((m) => m.startedAt)
    .filter((t): t is string => Boolean(t))
    .sort()[0];
  const finishedTimes = group.members
    .map((m) => m.finishedAt)
    .filter((t): t is string => Boolean(t));
  const finished =
    finishedTimes.length > 0 ? finishedTimes.sort().at(-1) : undefined;
  return { startedAt: started, finishedAt: finished };
}

export function StageRail({ run }: { run: RunDetail }) {
  const total = run.stages.length;
  const completed = run.stages.filter(
    (g) => g.aggregateStatus === "succeeded",
  ).length;
  const allDone = run.status === "succeeded";

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-5 py-3">
        <div className="flex items-center gap-2">
          {allDone ? (
            <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
          ) : null}
          <span className="text-sm font-semibold text-[var(--text)]">
            {allDone
              ? `All ${String(total)} stages complete`
              : run.status === "running"
                ? `Running…`
                : `${String(completed)} of ${String(total)} stages complete`}
          </span>
        </div>
        {!allDone ? (
          <div className="flex gap-1">
            {run.stages.map((group) => (
              <div
                key={group.stageKey}
                className={`h-1.5 w-6 rounded-full transition-colors ${railSegmentClass(group.aggregateStatus)}`}
                title={getStageDefinition(group.stageKey).title}
              />
            ))}
          </div>
        ) : null}
      </div>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7">
        {run.stages.map((group) => {
          const greenlitMetric = group.summary?.metrics.find(
            (m) => m.label === "Greenlit",
          );
          const isDeprioritized =
            group.stageKey === "screen" &&
            group.aggregateStatus === "succeeded" &&
            greenlitMetric != null &&
            Number(greenlitMetric.value) === 0;

          const { startedAt, finishedAt } = groupTimeBounds(group);

          return (
            <Link
              href={`/runs/${run.id}/stages/${group.stageKey}`}
              key={group.stageKey}
              className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4 transition hover:border-[var(--border-strong)] hover:bg-white/80"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-[var(--text-muted)]">
                  {group.stageOrder.toString().padStart(2, "0")}
                </p>
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant={
                      isDeprioritized
                        ? "warning"
                        : badgeVariant(group.aggregateStatus)
                    }
                  >
                    {isDeprioritized ? "deprioritized" : group.aggregateStatus}
                  </Badge>
                </div>
              </div>
              <p className="mt-3 text-base font-semibold text-[var(--text)]">
                {getStageDefinition(group.stageKey).title}
              </p>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
                {group.stageKey}
                {group.members.length > 1 ? (
                  <span className="ml-1 text-[var(--text-muted)]">
                    · {String(group.members.length)} families
                  </span>
                ) : null}
              </p>
              <p className="mt-2 text-sm text-[var(--text-muted)]">
                {group.summary?.headline ?? "Awaiting execution"}
              </p>
              <p className="mt-4 text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                {formatDuration(startedAt, finishedAt)}
              </p>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
