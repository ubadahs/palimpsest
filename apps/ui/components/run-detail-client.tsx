"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import type {
  AnalysisRunStage,
  RunDetail,
} from "citation-fidelity/ui-contract";
import { getStageDefinition } from "citation-fidelity/ui-contract";

import { ArtifactTabs } from "@/components/artifact-tabs";
import { CurrentWorkPanel } from "@/components/current-work-panel";
import { LogPanel } from "@/components/log-panel";
import { StageRail } from "@/components/stage-rail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { resolveFocusStage } from "@/lib/run-focus-stage";
import { fetchJson, formatDateTime } from "@/lib/utils";

function badgeVariant(
  status: string,
): "neutral" | "running" | "success" | "failed" {
  if (status === "running") return "running";
  if (status === "succeeded") return "success";
  if (status === "queued") return "neutral";
  return "failed";
}

function sortStages(stages: AnalysisRunStage[]): AnalysisRunStage[] {
  return [...stages].sort((a, b) => a.stageOrder - b.stageOrder);
}

function nextPendingStage(
  stages: AnalysisRunStage[],
): AnalysisRunStage | undefined {
  return sortStages(stages).find((stage) =>
    ["not_started", "blocked", "stale"].includes(stage.status),
  );
}

function stageCardHeadline(stage: AnalysisRunStage): string {
  if (stage.status === "not_started") {
    return "Not run yet.";
  }
  return stage.summary?.headline ?? "No summary for this stage yet.";
}

export function RunDetailClient({ initialRun }: { initialRun: RunDetail }) {
  const [run, setRun] = useState(initialRun);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const focusStage = useMemo(() => resolveFocusStage(run.stages), [run.stages]);

  const focusStageTitle = focusStage
    ? getStageDefinition(focusStage.stageKey).title
    : undefined;

  const nextStage = useMemo(() => nextPendingStage(run.stages), [run.stages]);
  const nextStageTitle = nextStage
    ? getStageDefinition(nextStage.stageKey).title
    : undefined;

  useEffect(() => {
    if (run.status !== "running") {
      return;
    }

    const interval = window.setInterval(async () => {
      const nextRun = await fetchJson<RunDetail>(`/api/runs/${run.id}`);
      setRun(nextRun);
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [run.id, run.status]);

  async function trigger(
    _action: "start" | "cancel",
    path: string,
  ): Promise<void> {
    setError(null);
    startTransition(async () => {
      try {
        await fetchJson<{ ok: true }>(path, { method: "POST" });
        const nextRun = await fetchJson<RunDetail>(`/api/runs/${run.id}`);
        setRun(nextRun);
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    });
  }

  const isRunning = run.status === "running";

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Badge variant={badgeVariant(run.status)}>{run.status}</Badge>
              <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                target {run.targetStage}
              </span>
            </div>
            <h2 className="font-[var(--font-instrument)] text-4xl tracking-[-0.03em]">
              {run.seedDoi}
            </h2>
            <p className="max-w-4xl text-sm leading-7 text-[var(--text-muted)]">
              {run.trackedClaim}
            </p>
          </div>
          <div className="flex flex-col items-start gap-3">
            <div className="grid gap-2 text-sm text-[var(--text-muted)]">
              <div>Created {formatDateTime(run.createdAt)}</div>
              <div>Updated {formatDateTime(run.updatedAt)}</div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={isPending || isRunning}
                  title={
                    isRunning
                      ? "Continue is unavailable while a stage is running."
                      : "Start or resume the next pending stage in pipeline order."
                  }
                  onClick={() => trigger("start", `/api/runs/${run.id}/start`)}
                  variant="default"
                >
                  Continue
                </Button>
                <Button
                  disabled={isPending || !isRunning}
                  title={
                    isRunning
                      ? "Request cancellation of the current CLI stage (best effort)."
                      : "Nothing is running to cancel."
                  }
                  onClick={() =>
                    trigger("cancel", `/api/runs/${run.id}/cancel`)
                  }
                  variant="danger"
                >
                  Cancel current stage
                </Button>
              </div>
              {!isRunning && nextStageTitle ? (
                <p className="max-w-xs text-xs leading-5 text-[var(--text-muted)]">
                  Continue picks up at {nextStageTitle} when earlier stages have
                  finished successfully.
                </p>
              ) : null}
            </div>
          </div>
        </CardHeader>
        {error ? (
          <CardContent className="border-t border-[var(--border)] pt-4 text-sm text-[var(--danger)]">
            {error}
          </CardContent>
        ) : null}
      </Card>

      <StageRail run={run} />

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <LogPanel
          active={isRunning}
          runId={run.id}
          stageKey={focusStage?.stageKey}
          {...(focusStageTitle ? { stageTitle: focusStageTitle } : {})}
        />
        <div className="space-y-6">
          {run.activeWorkflow ? (
            <CurrentWorkPanel
              progressVariant={isRunning ? "live" : "archive"}
              title={isRunning ? "Current work" : "Latest stage"}
              workflow={run.activeWorkflow}
            />
          ) : null}
          <Card className="overflow-hidden">
            <details className="group">
              <summary className="flex cursor-pointer list-none flex-col gap-2 border-b border-[var(--border)] px-6 py-5 [&::-webkit-details-marker]:hidden">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
                      All stages
                    </p>
                    <h3 className="mt-2 font-[var(--font-instrument)] text-2xl tracking-[-0.03em]">
                      Summaries and inspect links
                    </h3>
                  </div>
                  <span className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)] group-open:bg-[var(--panel-muted)] group-open:text-[var(--text)]">
                    <span className="group-open:hidden">Show</span>
                    <span className="hidden group-open:inline">Hide</span>
                  </span>
                </div>
                <p className="text-sm text-[var(--text-muted)]">
                  {String(run.stages.length)} stages — expand for per-stage
                  metrics and drill-downs.
                </p>
              </summary>
              <CardContent className="space-y-3 pt-5">
                {run.stages.map((stage) => (
                  <div
                    className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4"
                    key={stage.stageKey}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[var(--text)]">
                          {stage.stageKey}
                        </p>
                        <p className="mt-2 text-sm text-[var(--text-muted)]">
                          {stageCardHeadline(stage)}
                        </p>
                      </div>
                      <Link
                        className="text-sm font-semibold text-[var(--accent)]"
                        href={`/runs/${run.id}/stages/${stage.stageKey}`}
                      >
                        Inspect
                      </Link>
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      {(stage.summary?.metrics ?? [])
                        .slice(0, 3)
                        .map((metric) => (
                          <div key={metric.label}>
                            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
                              {metric.label}
                            </p>
                            <p className="mt-1 text-sm font-semibold text-[var(--text)]">
                              {metric.value}
                            </p>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </details>
          </Card>
        </div>
      </div>

      {focusStage ? (
        <ArtifactTabs
          artifactPointers={focusStage.summary?.artifacts ?? []}
          runId={run.id}
          stageKey={focusStage.stageKey}
          {...(focusStageTitle ? { stageTitle: focusStageTitle } : {})}
        />
      ) : null}
    </div>
  );
}
