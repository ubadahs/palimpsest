"use client";

import { useState, useTransition } from "react";
import type {
  RunDetail,
  RunStageGroupDetail,
  StageKey,
} from "palimpsest/contract";

import { ArtifactTabs } from "@/components/artifact-tabs";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { CurrentWorkPanel } from "@/components/current-work-panel";
import { StageInspector } from "@/components/stage-inspector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DoiLink } from "@/lib/rich-text";
import { stageBadgeVariant } from "@/lib/status-variants";
import { usePoll } from "@/lib/use-poll";
import { fetchJson, formatDuration, formatTime } from "@/lib/utils";

const stageDescriptions: Record<StageKey, string> = {
  discover: "Harvests citing-paper mentions and extracts attributed claims.",
  scope:
    "Scopes candidates, materializes seed text, and records grounding annotations.",
  prepare: "Builds complete occurrence-local records for scoped families.",
  evidence:
    "Retrieves deterministic seed-text evidence for every prepared record.",
  adjudicate:
    "Runs one canonical categorical F/D/E/U adjudication per eligible record.",
  report: "Produces the deterministic canonical JSON and Markdown report.",
};

export function StageDetailClient({
  initialRun,
  initialGroup,
}: {
  initialRun: RunDetail;
  initialGroup: RunStageGroupDetail;
}) {
  const [run, setRun] = useState(initialRun);
  const [group, setGroup] = useState(initialGroup);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Canonical runs keep exactly one row per stage.
  const detail = group.members[0];

  const anyRunning =
    run.status === "running" ||
    group.members.some((m) => m.status === "running");

  usePoll({
    fetch: () =>
      Promise.all([
        fetchJson<RunDetail>(`/api/runs/${run.id}`),
        fetchJson<RunStageGroupDetail>(
          `/api/runs/${run.id}/stages/${group.stageKey}`,
        ),
      ]),
    onSuccess: ([nextRun, nextGroup]) => {
      setRun(nextRun);
      setGroup(nextGroup);
    },
    intervalMs: 2_000,
    enabled: anyRunning,
  });

  function rerunStage(): void {
    startTransition(async () => {
      try {
        setError(null);
        await fetchJson<{ ok: true }>(
          `/api/runs/${run.id}/stages/${group.stageKey}/rerun`,
          { method: "POST" },
        );
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    });
  }

  if (!detail) {
    return null;
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs
        crumbs={[
          { label: "Dashboard", href: "/" },
          { label: run.seedDoi, href: `/runs/${run.id}` },
          { label: group.stageTitle },
        ]}
      />
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={stageBadgeVariant(group.aggregateStatus)}>
                {group.aggregateStatus}
              </Badge>
              <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                {group.stageKey}
              </span>
            </div>
            <h2 className="font-[var(--font-instrument)] text-4xl tracking-[-0.03em]">
              {group.stageTitle}
            </h2>
            <p className="max-w-xl text-sm text-[var(--text-muted)]">
              {stageDescriptions[group.stageKey]}
            </p>
            <p
              className="text-xs text-[var(--text-muted)]"
              suppressHydrationWarning
            >
              <DoiLink
                doi={run.seedDoi}
                className="text-[var(--text-muted)] hover:text-[var(--accent)] hover:underline"
              />
              {" · "}
              {formatTime(detail.startedAt)} → {formatTime(detail.finishedAt)}
              {detail.startedAt && detail.finishedAt ? (
                <span className="ml-1 font-semibold">
                  ({formatDuration(detail.startedAt, detail.finishedAt)})
                </span>
              ) : null}
            </p>
            {group.aggregateStatus === "stale" ||
            group.aggregateStatus === "not_started" ||
            group.aggregateStatus === "running" ||
            group.aggregateStatus === "blocked" ? (
              <p className="text-sm text-[var(--text-muted)]">
                Awaiting result for this canonical stage.
              </p>
            ) : null}
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

      <StageInspector detail={detail} runId={run.id} />
      <CurrentWorkPanel
        progressVariant={detail.status === "running" ? "live" : "archive"}
        title="Stage workflow"
        workflow={detail.workflow}
      />
      <ArtifactTabs
        artifactPointers={detail.artifactPointers}
        runId={run.id}
        stageKey={detail.stageKey}
      />
    </div>
  );
}
