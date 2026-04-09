"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type {
  RunDetail,
  RunStageDetail,
  RunStageGroupDetail,
  StageKey,
} from "palimpsest/ui-contract";

import { ArtifactTabs } from "@/components/artifact-tabs";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { CurrentWorkPanel } from "@/components/current-work-panel";
import { StageInspector } from "@/components/stage-inspector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DoiLink, RichText } from "@/lib/rich-text";
import { cn, fetchJson, formatDuration, formatTime } from "@/lib/utils";

const stageDescriptions: Record<StageKey, string> = {
  discover:
    "Harvests citing-paper mentions, extracts attributed claims, grounds family candidates to the seed, and builds a shortlist for screening.",
  screen:
    "Finds citing papers and checks whether the tracked claim can be grounded in the seed paper.",
  extract: "Extracts citation context from each citing paper's full text.",
  classify: "Classifies citation function and builds evaluation packets.",
  evidence:
    "Retrieves evidence spans from cited papers to compare against citations.",
  curate: "Selects a calibration sample for human review.",
  adjudicate: "Runs LLM adjudication to produce fidelity verdicts.",
};

function getDiscoverDescription(payload: unknown): string {
  const strategy =
    typeof payload === "object" &&
    payload !== null &&
    "strategy" in payload &&
    (payload as Record<string, unknown>)["strategy"];
  if (strategy === "legacy") {
    return "Legacy path: seed-side claim extraction and optional citing-paper engagement ranking.";
  }
  return stageDescriptions.discover;
}

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

function defaultFamilyIndex(group: RunStageGroupDetail): number {
  const running = group.members.find((m) => m.status === "running");
  return running?.familyIndex ?? group.members[0]?.familyIndex ?? 0;
}

type PayloadWithSeed = { seed?: { trackedClaim?: string; doi?: string } };

function extractTrackedClaim(detail: RunStageDetail): string | undefined {
  const payload = detail.inspectorPayload as PayloadWithSeed | undefined;
  return payload?.seed?.trackedClaim;
}

function familyHasFailures(group: RunStageGroupDetail): boolean {
  return group.members.some((m) =>
    ["failed", "cancelled", "interrupted"].includes(m.status),
  );
}

export function StageDetailClient({
  initialRun,
  initialGroup,
}: {
  initialRun: RunDetail;
  initialGroup: RunStageGroupDetail;
}) {
  const [run, setRun] = useState(initialRun);
  const [group, setGroup] = useState(initialGroup);
  const [selectedFamilyIndex, setSelectedFamilyIndex] = useState(() =>
    defaultFamilyIndex(initialGroup),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const detail: RunStageDetail | undefined = useMemo(
    () => group.members.find((m) => m.familyIndex === selectedFamilyIndex),
    [group.members, selectedFamilyIndex],
  );

  useEffect(() => {
    if (!group.members.some((m) => m.familyIndex === selectedFamilyIndex)) {
      setSelectedFamilyIndex(defaultFamilyIndex(group));
    }
  }, [group, selectedFamilyIndex]);

  const anyRunning =
    run.status === "running" ||
    group.members.some((m) => m.status === "running");

  useEffect(() => {
    if (!anyRunning) {
      return;
    }

    const interval = window.setInterval(async () => {
      const [nextRun, nextGroup] = await Promise.all([
        fetchJson<RunDetail>(`/api/runs/${run.id}`),
        fetchJson<RunStageGroupDetail>(
          `/api/runs/${run.id}/stages/${group.stageKey}`,
        ),
      ]);
      setRun(nextRun);
      setGroup(nextGroup);
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [anyRunning, group.stageKey, run.id]);

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

  const screenDeprioritized =
    group.stageKey === "screen" &&
    group.aggregateStatus === "succeeded" &&
    (
      detail.inspectorPayload as
        | { families?: { decision?: string }[] }
        | undefined
    )?.families?.some((f) => f.decision === "deprioritize");

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
              <Badge variant={badgeVariant(group.aggregateStatus)}>
                {group.aggregateStatus}
              </Badge>
              {screenDeprioritized ? (
                <Badge variant="warning">deprioritized</Badge>
              ) : null}
              <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                {group.stageKey}
              </span>
            </div>
            <h2 className="font-[var(--font-instrument)] text-4xl tracking-[-0.03em]">
              {group.stageTitle}
            </h2>
            <p className="max-w-xl text-sm text-[var(--text-muted)]">
              {group.stageKey === "discover"
                ? getDiscoverDescription(detail.inspectorPayload)
                : stageDescriptions[group.stageKey]}
            </p>
            <p className="text-xs text-[var(--text-muted)]" suppressHydrationWarning>
              <DoiLink doi={run.seedDoi} className="text-[var(--text-muted)] hover:text-[var(--accent)] hover:underline" />
              {" · "}
              {formatTime(detail.startedAt)} → {formatTime(detail.finishedAt)}
              {detail.startedAt && detail.finishedAt ? (
                <span className="ml-1 font-semibold">
                  ({formatDuration(detail.startedAt, detail.finishedAt)})
                </span>
              ) : null}
            </p>
            {group.members.length > 1 ? (
              <div className="space-y-2 pt-2">
                <div className="flex items-center gap-1">
                  <span className="mr-2 text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                    {String(group.members.length)} claims
                  </span>
                  {group.members.map((m) => {
                    const isFailed = ["failed", "cancelled", "interrupted"].includes(m.status);
                    return (
                      <button
                        key={m.familyIndex}
                        onClick={() => setSelectedFamilyIndex(m.familyIndex)}
                        type="button"
                        title={extractTrackedClaim(m) ?? `Claim ${m.familyIndex + 1}`}
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition",
                          m.familyIndex === selectedFamilyIndex
                            ? "bg-[var(--accent)] text-white"
                            : "border border-[var(--border)] bg-white/60 text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
                          isFailed &&
                            m.familyIndex !== selectedFamilyIndex &&
                            "border-[rgba(154,64,54,0.4)] text-[var(--danger)]",
                        )}
                      >
                        {m.familyIndex + 1}
                      </button>
                    );
                  })}
                  {familyHasFailures(group) ? (
                    <span className="ml-2 text-xs text-[var(--danger)]">
                      {group.members.filter((m) => ["failed", "cancelled", "interrupted"].includes(m.status)).length} failed
                    </span>
                  ) : null}
                </div>
                {extractTrackedClaim(detail) ? (
                  <RichText
                    html={extractTrackedClaim(detail)!}
                    as="p"
                    className="max-w-2xl text-sm leading-6 text-[var(--text)]"
                  />
                ) : null}
              </div>
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

      <StageInspector detail={detail} />
      <CurrentWorkPanel
        progressVariant={detail.status === "running" ? "live" : "archive"}
        title="Stage workflow"
        workflow={detail.workflow}
      />
      <ArtifactTabs
        artifactPointers={detail.artifactPointers}
        familyIndex={detail.familyIndex}
        runId={run.id}
        stageKey={detail.stageKey}
      />
    </div>
  );
}
