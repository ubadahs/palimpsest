"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import type { RunDetail, RunStageDetail } from "citation-fidelity/ui-contract";

import { ArtifactTabs } from "@/components/artifact-tabs";
import { CurrentWorkPanel } from "@/components/current-work-panel";
import { StageInspector } from "@/components/stage-inspector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { fetchJson, formatDateTime } from "@/lib/utils";

function badgeVariant(
  status: string,
): "neutral" | "running" | "success" | "failed" | "stale" {
  if (status === "running") return "running";
  if (status === "succeeded") return "success";
  if (status === "stale") return "stale";
  if (status === "failed" || status === "cancelled" || status === "interrupted")
    return "failed";
  return "neutral";
}

export function StageDetailClient({
  initialRun,
  initialDetail,
}: {
  initialRun: RunDetail;
  initialDetail: RunStageDetail;
}) {
  const [run, setRun] = useState(initialRun);
  const [detail, setDetail] = useState(initialDetail);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (run.status !== "running" && detail.status !== "running") {
      return;
    }

    const interval = window.setInterval(async () => {
      const [nextRun, nextDetail] = await Promise.all([
        fetchJson<RunDetail>(`/api/runs/${run.id}`),
        fetchJson<RunStageDetail>(
          `/api/runs/${run.id}/stages/${detail.stageKey}`,
        ),
      ]);
      setRun(nextRun);
      setDetail(nextDetail);
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [detail.stageKey, detail.status, run.id, run.status]);

  function rerunStage(): void {
    startTransition(async () => {
      try {
        setError(null);
        await fetchJson<{ ok: true }>(
          `/api/runs/${run.id}/stages/${detail.stageKey}/rerun`,
          { method: "POST" },
        );
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Badge variant={badgeVariant(detail.status)}>
                {detail.status}
              </Badge>
              <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                {detail.stageKey}
              </span>
            </div>
            <h2 className="font-[var(--font-instrument)] text-4xl tracking-[-0.03em]">
              {detail.stageTitle}
            </h2>
            <p className="text-sm text-[var(--text-muted)]">
              {run.seedDoi} · {formatDateTime(detail.startedAt)} →{" "}
              {formatDateTime(detail.finishedAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              className="inline-flex h-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition hover:bg-[var(--panel-muted)]"
              href={`/runs/${run.id}`}
            >
              Back to run
            </Link>
            <Button
              disabled={isPending || run.status === "running"}
              onClick={rerunStage}
              variant="default"
            >
              Rerun stage
            </Button>
          </div>
        </CardHeader>
        {error ? (
          <CardContent className="border-t border-[var(--border)] pt-4 text-sm text-[var(--danger)]">
            {error}
          </CardContent>
        ) : null}
      </Card>

      <CurrentWorkPanel
        progressVariant={detail.status === "running" ? "live" : "archive"}
        title="Stage workflow"
        workflow={detail.workflow}
      />
      <StageInspector detail={detail} />
      <ArtifactTabs
        artifactPointers={detail.artifactPointers}
        runId={run.id}
        stageKey={detail.stageKey}
      />
    </div>
  );
}
