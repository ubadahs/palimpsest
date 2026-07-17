import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import {
  getStageDefinition,
  stageDefinitions,
  type LogicalStageGroup,
  type RunDetail,
} from "palimpsest/contract";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { railSegmentClass, stageBadgeVariant } from "@/lib/status-variants";
import { formatDuration } from "@/lib/utils";

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
  const targetOrder = getStageDefinition(run.targetStage).order;
  const groups = stageDefinitions.map(
    (definition) =>
      run.stages.find((group) => group.stageKey === definition.key) ?? {
        stageKey: definition.key,
        stageOrder: definition.order,
        aggregateStatus: "not_started" as const,
        members: [],
      },
  );
  const targetedGroups = groups.filter(
    (group) => group.stageOrder <= targetOrder,
  );
  const total = targetedGroups.length;
  const completed = targetedGroups.filter(
    (g) => g.aggregateStatus === "succeeded",
  ).length;
  const allDone = run.status === "succeeded" && completed === total;
  const completionLabel =
    run.targetStage === "report"
      ? `All ${String(total)} stages complete`
      : `All ${String(total)} targeted stages complete through ${getStageDefinition(run.targetStage).title}`;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-5 py-3">
        <div className="flex items-center gap-2">
          {allDone ? (
            <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
          ) : null}
          <span className="text-sm font-semibold text-[var(--text)]">
            {allDone
              ? completionLabel
              : run.status === "running"
                ? `Running…`
                : `${String(completed)} of ${String(total)} stages complete`}
          </span>
        </div>
        {!allDone ? (
          <div className="flex gap-1">
            {groups.map((group) => (
              <div
                key={group.stageKey}
                className={`h-1.5 w-6 rounded-full transition-colors ${railSegmentClass(group.aggregateStatus)}`}
                title={getStageDefinition(group.stageKey).title}
              />
            ))}
          </div>
        ) : null}
      </div>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-3 md:grid-cols-3 xl:grid-cols-6">
        {groups.map((group) => {
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
                  <Badge variant={stageBadgeVariant(group.aggregateStatus)}>
                    {group.aggregateStatus}
                  </Badge>
                </div>
              </div>
              <p className="mt-3 text-base font-semibold text-[var(--text)]">
                {getStageDefinition(group.stageKey).title}
              </p>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
                {group.stageKey}
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
