"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DashboardStats } from "palimpsest/contract";
import type { EnvironmentHealthSummary } from "palimpsest/contract/server";

import { DashboardRibbon } from "@/components/dashboard-ribbon";
import { DashboardRunSections } from "@/components/dashboard-run-sections";
import type { DashboardPollPayload } from "@/lib/run-queries";
import { usePoll } from "@/lib/use-poll";
import { fetchJson } from "@/lib/utils";

export function DashboardHomeClient({
  workspaceRoot,
  initialHealth,
  initialStats,
  initialRuns,
}: {
  workspaceRoot: string;
  initialHealth: EnvironmentHealthSummary;
  initialStats: DashboardStats;
  initialRuns: DashboardPollPayload["runs"];
}) {
  const [health, setHealth] = useState(initialHealth);
  const [stats, setStats] = useState(initialStats);
  const [runs, setRuns] = useState(initialRuns);
  const [waiting, setWaiting] = useState(0);

  // Grading requests are the one thing here that waits on the reader.
  useEffect(() => {
    fetchJson<{ openRequests: number }[]>("/api/evaluations")
      .then((datasets) =>
        setWaiting(
          datasets.reduce((sum, dataset) => sum + dataset.openRequests, 0),
        ),
      )
      .catch(() => setWaiting(0));
  }, []);

  usePoll({
    fetch: () => fetchJson<DashboardPollPayload>("/api/runs"),
    onSuccess: (next) => {
      setHealth(next.health);
      setStats(next.stats);
      setRuns(next.runs);
    },
    intervalMs: 10_000,
  });

  const hasRuns = runs.length > 0;

  return (
    <div className="space-y-6">
      {waiting ? (
        <Link
          className="flex items-center justify-between gap-4 rounded-[24px] border border-[var(--accent)] bg-[var(--accent-soft)] px-6 py-4 text-sm transition hover:bg-[rgba(155,92,65,0.18)]"
          href="/evaluations"
        >
          <strong>
            {waiting === 1
              ? "1 grading request is waiting for you."
              : `${String(waiting)} grading requests are waiting for you.`}
          </strong>
          <span className="font-semibold text-[var(--accent)]">Grade →</span>
        </Link>
      ) : null}
      {hasRuns ? (
        <DashboardRibbon
          health={health}
          stats={stats}
          workspaceRoot={workspaceRoot}
        />
      ) : null}
      <DashboardRunSections runs={runs} />
    </div>
  );
}
