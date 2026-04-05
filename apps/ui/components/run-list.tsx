"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { RunSummary } from "citation-fidelity/ui-contract";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { fetchJson, formatDateTime } from "@/lib/utils";

function variantForStatus(status: RunSummary["status"]): "neutral" | "running" | "success" | "failed" {
  if (status === "running") {
    return "running";
  }
  if (status === "succeeded") {
    return "success";
  }
  if (status === "queued") {
    return "neutral";
  }
  return "failed";
}

export function RunList({ initialRuns }: { initialRuns: RunSummary[] }) {
  const [runs, setRuns] = useState(initialRuns);

  useEffect(() => {
    const interval = window.setInterval(async () => {
      const nextRuns = await fetchJson<RunSummary[]>("/api/runs");
      setRuns(nextRuns);
    }, 10_000);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            Recent Runs
          </p>
          <h2 className="mt-2 font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
            Active lineage and historical output
          </h2>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {runs.length === 0 ? (
          <div className="rounded-[24px] border border-dashed border-[var(--border)] px-6 py-10 text-center text-sm text-[var(--text-muted)]">
            No runs yet. Create one seed DOI and tracked claim to start.
          </div>
        ) : (
          runs.map((run) => (
            <Link
              href={`/runs/${run.id}`}
              key={run.id}
              className="block rounded-[24px] border border-[var(--border)] bg-white/60 p-5 transition hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:bg-white/80"
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Badge variant={variantForStatus(run.status)}>{run.status}</Badge>
                    <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                      {run.currentStage ?? "not started"}
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-[var(--text)]">
                    {run.seedDoi}
                  </h3>
                  <p className="max-w-3xl text-sm text-[var(--text-muted)]">
                    {run.trackedClaim}
                  </p>
                </div>
                <div className="grid gap-3 text-sm text-[var(--text-muted)] md:min-w-[260px]">
                  <div className="flex items-center justify-between gap-4">
                    <span>Health</span>
                    <span className="text-right text-[var(--text)]">{run.healthSummary}</span>
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
          ))
        )}
      </CardContent>
    </Card>
  );
}
