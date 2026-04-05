import Link from "next/link";
import type { RunDetail } from "citation-fidelity/ui-contract";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDuration } from "@/lib/utils";

function badgeVariant(status: string): "neutral" | "running" | "success" | "failed" | "stale" {
  if (status === "running") return "running";
  if (status === "succeeded") return "success";
  if (status === "stale") return "stale";
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return "failed";
  }
  return "neutral";
}

export function StageRail({ run }: { run: RunDetail }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-6">
        {run.stages.map((stage) => (
          <Link
            href={`/runs/${run.id}/stages/${stage.stageKey}`}
            key={stage.stageKey}
            className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4 transition hover:border-[var(--border-strong)] hover:bg-white/80"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[var(--text)]">
                {stage.stageOrder.toString().padStart(2, "0")}
              </p>
              <Badge variant={badgeVariant(stage.status)}>{stage.status}</Badge>
            </div>
            <p className="mt-4 text-base font-semibold text-[var(--text)]">
              {stage.stageKey}
            </p>
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              {stage.summary?.headline ?? "Awaiting execution"}
            </p>
            <p className="mt-4 text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {formatDuration(stage.startedAt, stage.finishedAt)}
            </p>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
