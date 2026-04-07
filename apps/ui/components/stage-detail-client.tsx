"use client";

import { useEffect, useState, useTransition } from "react";
import type { RunDetail, RunStageDetail, StageKey } from "palimpsest/ui-contract";

import { ArtifactTabs } from "@/components/artifact-tabs";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { CurrentWorkPanel } from "@/components/current-work-panel";
import { StageInspector } from "@/components/stage-inspector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { fetchJson, formatDateTime } from "@/lib/utils";

const stageDescriptions: Record<StageKey, string> = {
  screen:
    "Finds citing papers and checks whether the tracked claim can be grounded in the seed paper.",
  extract: "Extracts citation context from each citing paper's full text.",
  classify: "Classifies citation function and builds evaluation packets.",
  evidence:
    "Retrieves evidence spans from cited papers to compare against citations.",
  curate: "Selects a calibration sample for human review.",
  adjudicate: "Runs LLM adjudication to produce fidelity verdicts.",
};

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
      <Breadcrumbs
        crumbs={[
          { label: "Dashboard", href: "/" },
          { label: run.seedDoi, href: `/runs/${run.id}` },
          { label: detail.stageTitle },
        ]}
      />
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Badge variant={badgeVariant(detail.status)}>
                {detail.status}
              </Badge>
              {detail.stageKey === "screen" &&
              detail.status === "succeeded" &&
              (detail.inspectorPayload as { families?: { decision?: string }[] } | undefined)
                ?.families?.[0]?.decision === "deprioritize" ? (
                <Badge variant="warning">deprioritized</Badge>
              ) : null}
              <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                {detail.stageKey}
              </span>
            </div>
            <h2 className="font-[var(--font-instrument)] text-4xl tracking-[-0.03em]">
              {detail.stageTitle}
            </h2>
            <p className="max-w-xl text-sm text-[var(--text-muted)]">
              {stageDescriptions[detail.stageKey]}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {run.seedDoi} · {formatDateTime(detail.startedAt)} →{" "}
              {formatDateTime(detail.finishedAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
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
