import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getStageDefinition, type RunDetail } from "palimpsest/ui-contract";

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

export function StageRail({ run }: { run: RunDetail }) {
  const total = run.stages.length;
  const completed = run.stages.filter((s) => s.status === "succeeded").length;
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
            {run.stages.map((stage) => (
              <div
                key={stage.stageKey}
                className={`h-1.5 w-6 rounded-full transition-colors ${
                  stage.status === "succeeded"
                    ? "bg-[var(--success)]"
                    : stage.status === "running"
                      ? "bg-[var(--accent)] opacity-70"
                      : stage.status === "failed" ||
                          stage.status === "cancelled"
                        ? "bg-[var(--danger)]"
                        : "bg-[var(--border-strong)]"
                }`}
                title={getStageDefinition(stage.stageKey).title}
              />
            ))}
          </div>
        ) : null}
      </div>
      <CardContent className="grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-6">
        {run.stages.map((stage) => {
          // Detect screen stage that succeeded but deprioritized (Greenlit=0)
          const greenlitMetric = stage.summary?.metrics.find(
            (m) => m.label === "Greenlit",
          );
          const isDeprioritized =
            stage.stageKey === "screen" &&
            stage.status === "succeeded" &&
            greenlitMetric != null &&
            Number(greenlitMetric.value) === 0;

          return (
          <Link
            href={`/runs/${run.id}/stages/${stage.stageKey}`}
            key={stage.stageKey}
            className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4 transition hover:border-[var(--border-strong)] hover:bg-white/80"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-[var(--text-muted)]">
                {stage.stageOrder.toString().padStart(2, "0")}
              </p>
              <div className="flex items-center gap-1.5">
                <Badge variant={isDeprioritized ? "warning" : badgeVariant(stage.status)}>
                  {isDeprioritized ? "deprioritized" : stage.status}
                </Badge>
              </div>
            </div>
            <p className="mt-3 text-base font-semibold text-[var(--text)]">
              {getStageDefinition(stage.stageKey).title}
            </p>
            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
              {stage.stageKey}
            </p>
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              {stage.summary?.headline ?? "Awaiting execution"}
            </p>
            <p className="mt-4 text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {formatDuration(stage.startedAt, stage.finishedAt)}
            </p>
          </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
