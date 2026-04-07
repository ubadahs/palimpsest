"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import type { EnvironmentHealthSummary } from "palimpsest/ui-contract/server";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { pathRelativeToWorkspace } from "@/lib/path-display";

function variantForStatus(status: string): "success" | "failed" | "warning" {
  if (status === "ok") {
    return "success";
  }

  if (status === "not_configured") {
    return "warning";
  }

  return "failed";
}

export function HealthPanel({
  health,
  workspaceRoot,
}: {
  health: EnvironmentHealthSummary;
  workspaceRoot: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const checks = [
    {
      label: "Database",
      status: health.health.database.status,
      detail: pathRelativeToWorkspace(health.databasePath, workspaceRoot),
      blocking: true,
    },
    {
      label: "GROBID",
      status: health.health.grobid.status,
      detail: health.health.grobid.detail ?? health.providerBaseUrls.grobid,
      blocking: true,
    },
    {
      label: "Anthropic",
      status: health.health.anthropic.status,
      detail:
        health.health.anthropic.detail ??
        (health.anthropicConfigured ? "Configured" : "Missing API key"),
      blocking: false,
    },
    {
      label: "Local reranker",
      status: health.health.reranker.status,
      detail:
        health.health.reranker.detail ??
        health.localRerankerBaseUrl ??
        "Optional service",
      blocking: false,
    },
  ];

  const blockingIssues = checks.filter(
    (c) => c.blocking && c.status !== "ok",
  ).length;
  const optionalIssues = checks.filter(
    (c) => !c.blocking && c.status !== "ok" && c.status !== "not_configured",
  ).length;
  const allOk = blockingIssues === 0 && optionalIssues === 0;

  return (
    <div className="overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <button
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <div className="flex items-center gap-3">
          {allOk ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--warning)]" />
          )}
          <span className="text-sm font-semibold text-[var(--text)]">
            {allOk
              ? "All systems ready"
              : blockingIssues > 0
                ? `${String(blockingIssues)} blocking issue${blockingIssues > 1 ? "s" : ""}`
                : "Optional service unavailable"}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            System status
          </span>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div className="border-t border-[var(--border)]">
          <div className="grid gap-3 p-4 lg:grid-cols-4">
            {checks.map((check) => (
              <div
                key={check.label}
                className="rounded-[20px] border border-[var(--border)] bg-white/55 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-[var(--text)]">
                    {check.label}
                  </p>
                  <Badge variant={variantForStatus(check.status)}>
                    {check.status}
                  </Badge>
                </div>
                <p className="mt-3 text-sm text-[var(--text-muted)]">
                  {check.detail}
                </p>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  {check.blocking ? "blocking" : "optional"}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
