"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  getStageDefinition,
  type RunSummary,
  type StageKey,
} from "palimpsest/ui-contract";

import { MiniStageRail } from "@/components/mini-stage-rail";
import { MiniVerdictBar } from "@/components/mini-verdict-bar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { runBadgeVariant } from "@/lib/status-variants";
import { cn, formatDateTime } from "@/lib/utils";

function lastSucceededStageKey(run: RunSummary): StageKey | undefined {
  for (let i = run.stages.length - 1; i >= 0; i--) {
    const group = run.stages[i]!;
    if (group.aggregateStatus === "succeeded") {
      return group.stageKey;
    }
  }
  return undefined;
}

function headlineStageTitle(run: RunSummary): string {
  if (run.status === "succeeded") {
    const key = run.currentStage ?? lastSucceededStageKey(run);
    const title = key ? getStageDefinition(key).title : undefined;
    return title ? `Through ${title}` : "Complete";
  }
  if (run.currentStage) {
    return getStageDefinition(run.currentStage).title;
  }
  if (run.status === "running") {
    const active = run.stages.find((g) => g.aggregateStatus === "running");
    return active ? getStageDefinition(active.stageKey).title : "Running";
  }
  if (run.status === "queued") {
    return "Not started";
  }
  const problem = run.stages.find((g) =>
    ["failed", "cancelled", "interrupted"].includes(g.aggregateStatus),
  );
  return problem ? getStageDefinition(problem.stageKey).title : "Not started";
}

function stageProgressLabel(run: RunSummary): string {
  const total = run.stages.length;
  const done = run.stages.filter(
    (g) => g.aggregateStatus === "succeeded",
  ).length;
  return `${String(done)}/${String(total)} stages`;
}

function sortByUpdatedDesc(a: RunSummary, b: RunSummary): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function RunRowCard({
  run,
  emphasizeActive,
}: {
  run: RunSummary;
  emphasizeActive: boolean;
}) {
  const verdictSummary = run.verdictSummary;
  const showVerdictRow = run.status === "succeeded" && verdictSummary;
  const showStageRail =
    run.status !== "succeeded" ||
    (run.status === "succeeded" && !verdictSummary);

  return (
    <Link
      href={`/runs/${run.id}`}
      className={cn(
        "block rounded-[24px] border border-[var(--border)] bg-white/60 p-5 transition hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:bg-white/80",
        emphasizeActive &&
          "ring-2 ring-[var(--accent)]/35 ring-offset-2 ring-offset-[var(--background)] animate-pulse",
      )}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={runBadgeVariant(run.status)}>{run.status}</Badge>
            <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {headlineStageTitle(run)}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {stageProgressLabel(run)}
            </span>
          </div>
          {/*
            Plain DOI text: the card is a single <Link>, so we avoid nested <a>
            (DoiLink) which would be invalid HTML and hurt accessibility.
          */}
          <h3 className="text-lg font-semibold text-[var(--text)]">
            {run.seedDoi}
          </h3>
          <p className="max-w-3xl text-sm text-[var(--text-muted)]">
            {run.trackedClaim ?? "Auto-discover"}
          </p>
          {showVerdictRow && verdictSummary ? (
            <div className="space-y-1.5 pt-1">
              <MiniVerdictBar summary={verdictSummary} />
              <p className="text-[11px] text-[var(--text-muted)]">
                {verdictSummary.total} citation
                {verdictSummary.total === 1 ? "" : "s"} adjudicated
              </p>
            </div>
          ) : null}
          {showStageRail ? (
            <div className="pt-1">
              <MiniStageRail stages={run.stages} />
            </div>
          ) : null}
        </div>
        <div className="grid gap-3 text-sm text-[var(--text-muted)] md:min-w-[260px]">
          <div className="flex items-center justify-between gap-4">
            <span>Health</span>
            <span className="text-right text-[var(--text)]">
              {run.healthSummary}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span>Updated</span>
            <span className="text-right text-[var(--text)]">
              {formatDateTime(run.updatedAt)}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            {eyebrow}
          </p>
          <h2 className="mt-2 font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
            {title}
          </h2>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

export function DashboardRunSections({ runs }: { runs: RunSummary[] }) {
  const [failedExpanded, setFailedExpanded] = useState(false);

  const { active, completed, failed } = useMemo(() => {
    const active = runs
      .filter((r) => r.status === "running" || r.status === "queued")
      .sort(sortByUpdatedDesc);
    const completed = runs
      .filter((r) => r.status === "succeeded")
      .sort(sortByUpdatedDesc);
    const failed = runs
      .filter((r) => ["failed", "cancelled", "interrupted"].includes(r.status))
      .sort(sortByUpdatedDesc);
    return { active, completed, failed };
  }, [runs]);

  if (runs.length === 0) {
    return (
      <div className="rounded-[28px] border border-dashed border-[var(--border)] bg-[var(--panel)]/40 px-6 py-14 text-center shadow-[var(--shadow)]">
        <p className="text-sm font-semibold text-[var(--text)]">
          No analysis runs yet.
        </p>
        <p className="mx-auto mt-3 max-w-md text-sm text-[var(--text-muted)]">
          This tool checks whether papers that cite a study faithfully represent
          its findings. Provide the DOI of the original paper and the specific
          claim you want to track across the literature.
        </p>
        <a
          className="mt-5 inline-flex h-10 items-center justify-center rounded-full bg-[var(--text)] px-5 text-sm font-semibold text-white transition hover:bg-[#2b241d]"
          href="/runs/new"
        >
          Start your first analysis
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {active.length > 0 ? (
        <Section eyebrow="In progress" title="Active runs">
          {active.map((run) => (
            <RunRowCard emphasizeActive key={run.id} run={run} />
          ))}
        </Section>
      ) : null}

      {completed.length > 0 ? (
        <Section eyebrow="Finished" title="Completed">
          {completed.map((run) => (
            <RunRowCard emphasizeActive={false} key={run.id} run={run} />
          ))}
        </Section>
      ) : null}

      {failed.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
                Needs attention
              </p>
              <h2 className="mt-2 font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
                Failed or stopped
              </h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                {failed.length} run{failed.length === 1 ? "" : "s"}
              </p>
            </div>
            {!failedExpanded ? (
              <button
                className="rounded-full border border-[var(--border)] bg-white/60 px-4 py-2 text-sm font-semibold text-[var(--text)] transition hover:bg-white/80"
                onClick={() => setFailedExpanded(true)}
                type="button"
              >
                Show
              </button>
            ) : (
              <button
                className="rounded-full border border-[var(--border)] bg-white/60 px-4 py-2 text-sm font-semibold text-[var(--text)] transition hover:bg-white/80"
                onClick={() => setFailedExpanded(false)}
                type="button"
              >
                Hide
              </button>
            )}
          </CardHeader>
          {failedExpanded ? (
            <CardContent className="space-y-3">
              {failed.map((run) => (
                <RunRowCard emphasizeActive={false} key={run.id} run={run} />
              ))}
            </CardContent>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
