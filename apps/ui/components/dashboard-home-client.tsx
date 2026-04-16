"use client";

import { useState } from "react";
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
