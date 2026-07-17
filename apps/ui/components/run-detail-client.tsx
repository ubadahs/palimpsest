"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  getStageDefinition,
  type LogicalStageGroup,
  type RunDetail,
} from "palimpsest/contract";

import { ArtifactTabs } from "@/components/artifact-tabs";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { CurrentWorkPanel } from "@/components/current-work-panel";
import { LogPanel } from "@/components/log-panel";
import { RunResultsSummary } from "@/components/run-results-summary";
import { StageRail } from "@/components/stage-rail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DoiLink } from "@/lib/rich-text";
import { resolveFocusStage } from "@/lib/run-focus-stage";
import { runBadgeVariant } from "@/lib/status-variants";
import { usePoll } from "@/lib/use-poll";
import { fetchJson, formatDateCompact, formatDuration } from "@/lib/utils";

function sortGroups(groups: LogicalStageGroup[]): LogicalStageGroup[] {
  return [...groups].sort((a, b) => a.stageOrder - b.stageOrder);
}

function nextPendingGroup(
  groups: LogicalStageGroup[],
): LogicalStageGroup | undefined {
  return sortGroups(groups).find((g) =>
    ["not_started", "blocked", "stale"].includes(g.aggregateStatus),
  );
}

function stageGroupCardHeadline(group: LogicalStageGroup): string {
  if (group.aggregateStatus === "not_started") {
    return "Not run yet.";
  }
  return group.summary?.headline ?? "No summary for this stage yet.";
}

function runTimeBounds(run: RunDetail): {
  startedAt: string | undefined;
  finishedAt: string | undefined;
} {
  const allStarts = run.stages
    .flatMap((g) => g.members.map((m) => m.startedAt))
    .filter((t): t is string => Boolean(t))
    .sort();
  const allFinishes = run.stages
    .flatMap((g) => g.members.map((m) => m.finishedAt))
    .filter((t): t is string => Boolean(t))
    .sort();
  return {
    startedAt: allStarts[0],
    finishedAt: allFinishes.at(-1),
  };
}

export function RunDetailClient({ initialRun }: { initialRun: RunDetail }) {
  const [run, setRun] = useState(initialRun);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [costUsd, setCostUsd] = useState<number | undefined>(undefined);
  const [costSource, setCostSource] = useState<string>("pipeline");

  const focusStage = useMemo(() => resolveFocusStage(run.stages), [run.stages]);

  const focusStageTitle = focusStage
    ? getStageDefinition(focusStage.stageKey).title
    : undefined;

  const nextGroup = useMemo(() => nextPendingGroup(run.stages), [run.stages]);
  const nextStageTitle = nextGroup
    ? getStageDefinition(nextGroup.stageKey).title
    : undefined;

  const { startedAt: runStart, finishedAt: runFinish } = useMemo(
    () => runTimeBounds(run),
    [run],
  );

  usePoll({
    fetch: () => fetchJson<RunDetail>(`/api/runs/${run.id}`),
    onSuccess: setRun,
    intervalMs: 2_000,
    enabled: run.status === "queued" || run.status === "running",
  });

  useEffect(() => {
    if (run.status !== "succeeded") return;
    void fetchJson<{
      totalEstimatedCostUsd: number;
      source: string;
    } | null>(`/api/runs/${run.id}/cost`)
      .then((cost) => {
        if (cost && typeof cost.totalEstimatedCostUsd === "number") {
          setCostUsd(cost.totalEstimatedCostUsd);
          setCostSource(
            cost.source === "cost_file" ? "pipeline" : "adjudication only",
          );
        }
      })
      .catch(() => null);
  }, [run.id, run.status]);

  async function trigger(
    _action: "start" | "cancel",
    path: string,
    body?: unknown,
  ): Promise<void> {
    setError(null);
    startTransition(async () => {
      try {
        await fetchJson<{ ok: true }>(path, {
          method: "POST",
          ...(body != null
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        });
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
  const targetComplete = run.status === "succeeded";
  const fullPipelineComplete = targetComplete && run.targetStage === "report";

  return (
    <div className="space-y-6">
      <Breadcrumbs
        crumbs={[{ label: "Dashboard", href: "/" }, { label: run.seedDoi }]}
      />
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Badge variant={runBadgeVariant(run.status)}>{run.status}</Badge>
              <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                target {run.targetStage}
              </span>
            </div>
            <h2 className="font-[var(--font-instrument)] text-4xl tracking-[-0.03em]">
              <DoiLink
                doi={run.seedDoi}
                className="text-[var(--text)] hover:text-[var(--accent)] hover:underline"
              />
            </h2>
            <p className="max-w-4xl text-sm leading-7 text-[var(--text-muted)]">
              Canonical DOI-first audit: discover citing-side attributions,
              scope families, prepare records, retrieve evidence, adjudicate,
              and report.
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div
              className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm text-[var(--text-muted)]"
              suppressHydrationWarning
            >
              <div suppressHydrationWarning>
                <span className="text-[11px] uppercase tracking-[0.14em]">
                  Created
                </span>{" "}
                {formatDateCompact(run.createdAt)}
              </div>
              {targetComplete && runStart && runFinish ? (
                <div>
                  <span className="text-[11px] uppercase tracking-[0.14em]">
                    Duration
                  </span>{" "}
                  <span className="font-semibold text-[var(--text)]">
                    {formatDuration(runStart, runFinish)}
                  </span>
                </div>
              ) : (
                <div suppressHydrationWarning>
                  <span className="text-[11px] uppercase tracking-[0.14em]">
                    Updated
                  </span>{" "}
                  {formatDateCompact(run.updatedAt)}
                </div>
              )}
              {costUsd != null ? (
                <div
                  title={
                    costSource === "pipeline"
                      ? "Total LLM cost across all pipeline stages"
                      : "Adjudication LLM cost only — run again to capture full pipeline cost"
                  }
                >
                  <span className="text-[11px] uppercase tracking-[0.14em]">
                    Est. LLM cost
                  </span>{" "}
                  <span className="font-semibold text-[var(--text)]">
                    ${costUsd.toFixed(2)}
                  </span>
                  {costSource !== "pipeline" ? (
                    <span className="ml-1 text-[10px] text-[var(--text-muted)]">
                      ({costSource})
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {!fullPipelineComplete ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={isPending || isRunning}
                    title={
                      isRunning
                        ? "Continue is unavailable while a stage is running."
                        : "Start or resume the next pending stage in pipeline order."
                    }
                    onClick={() =>
                      trigger(
                        "start",
                        `/api/runs/${run.id}/start`,
                        targetComplete && nextGroup
                          ? { targetStage: nextGroup.stageKey }
                          : undefined,
                      )
                    }
                    variant="default"
                  >
                    {targetComplete && nextStageTitle
                      ? `Continue to ${nextStageTitle}`
                      : "Continue"}
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
                    Continue picks up at {nextStageTitle} when earlier stages
                    have finished successfully.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </CardHeader>
        {error ? (
          <CardContent className="border-t border-[var(--border)] pt-4 text-sm text-[var(--danger)]">
            {error}
          </CardContent>
        ) : null}
      </Card>

      {targetComplete ? <RunResultsSummary run={run} /> : null}

      <StageRail run={run} />

      {!targetComplete ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-6">
            {run.activeWorkflow ? (
              <CurrentWorkPanel
                progressVariant={isRunning ? "live" : "archive"}
                title={isRunning ? "Current work" : "Latest stage"}
                workflow={run.activeWorkflow}
              />
            ) : null}
          </div>
          <LogPanel
            active={isRunning}
            defaultCollapsed={!isRunning}
            runId={run.id}
            stageKey={focusStage?.stageKey}
            {...(focusStageTitle ? { stageTitle: focusStageTitle } : {})}
          />
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <details className="group" open={targetComplete}>
          <summary className="flex cursor-pointer list-none flex-col gap-2 border-b border-[var(--border)] px-6 py-5 [&::-webkit-details-marker]:hidden">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-[var(--font-instrument)] text-2xl tracking-[-0.03em]">
                  Stage Details
                </h3>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  {String(run.stages.length)} pipeline stages
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)] group-open:bg-[var(--panel-muted)] group-open:text-[var(--text)]">
                <span className="group-open:hidden">Show</span>
                <span className="hidden group-open:inline">Hide</span>
              </span>
            </div>
          </summary>
          <CardContent className="space-y-3 pt-5">
            {run.stages.map((group) => (
              <div
                className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4"
                key={group.stageKey}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--text)]">
                      {getStageDefinition(group.stageKey).title}
                    </p>
                    <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                      {group.stageKey}
                    </p>
                    <p className="mt-2 text-sm text-[var(--text-muted)]">
                      {stageGroupCardHeadline(group)}
                    </p>
                  </div>
                  <Link
                    className="shrink-0 text-sm font-semibold text-[var(--accent)]"
                    href={`/runs/${run.id}/stages/${group.stageKey}`}
                  >
                    View details
                  </Link>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  {(group.summary?.metrics ?? []).slice(0, 3).map((metric) => (
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
