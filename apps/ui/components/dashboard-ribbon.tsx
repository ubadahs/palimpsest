"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import type { DashboardStats } from "palimpsest/contract";
import type { EnvironmentHealthSummary } from "palimpsest/contract/server";

import {
  buildHealthCheckRows,
  HealthChecksGrid,
  summarizeHealthChecks,
} from "@/components/health-checks";
import { cn } from "@/lib/utils";

/** Equal-weight stat tiles: same corner radius and grid column width (avoids circle vs pill mismatch from `rounded-full`). */
function StatTile({
  value,
  label,
  description,
}: {
  value: number;
  label: string;
  /** Shown as native tooltip; use for the short-label tile that needs extra context. */
  description?: string;
}) {
  return (
    <div
      className="flex min-h-[4.5rem] min-w-0 flex-col justify-end rounded-2xl border border-[var(--border)] bg-white/55 p-3 shadow-sm backdrop-blur-sm"
      title={description}
    >
      <p className="text-2xl font-semibold tabular-nums leading-none tracking-tight text-[var(--text)]">
        {value}
      </p>
      <p className="mt-2 line-clamp-2 text-xs font-medium leading-snug text-[var(--text-muted)]">
        {label}
      </p>
    </div>
  );
}

export function DashboardRibbon({
  health,
  stats,
  workspaceRoot,
}: {
  health: EnvironmentHealthSummary;
  stats: DashboardStats;
  workspaceRoot: string;
}) {
  const [healthExpanded, setHealthExpanded] = useState(false);
  const checks = buildHealthCheckRows(health, workspaceRoot);
  const { allOk, blockingIssues } = summarizeHealthChecks(checks);

  const healthLabel = allOk
    ? "All systems ready"
    : blockingIssues > 0
      ? `${String(blockingIssues)} blocking`
      : "Optional issue";

  return (
    <div className="overflow-hidden rounded-[24px] border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex flex-col gap-4 p-4 md:flex-row md:items-stretch md:justify-between md:gap-4">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Total runs" value={stats.totalRuns} />
          <StatTile label="Active" value={stats.activeRuns} />
          <StatTile label="Completed" value={stats.completedRuns} />
          <StatTile
            description="Total citations adjudicated across completed runs (non-excluded records)"
            label="Citations"
            value={stats.adjudicatedCitationTotal}
          />
        </div>

        <button
          aria-expanded={healthExpanded}
          className="flex shrink-0 items-center justify-between gap-3 rounded-full border border-[var(--border)] bg-white/55 px-4 py-2 text-left transition hover:bg-white/75 md:max-w-sm"
          onClick={() => setHealthExpanded((v) => !v)}
          type="button"
        >
          <div className="flex min-w-0 items-center gap-2">
            {allOk ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--warning)]" />
            )}
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-[var(--text)]">
                {healthLabel}
              </p>
              <p className="text-[10px] text-[var(--text-muted)]">
                System status
              </p>
            </div>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform",
              healthExpanded && "rotate-180",
            )}
          />
        </button>
      </div>

      {healthExpanded ? (
        <div className="border-t border-[var(--border)]">
          <HealthChecksGrid checks={checks} />
        </div>
      ) : null}
    </div>
  );
}
