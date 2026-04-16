import type { EnvironmentHealthSummary } from "palimpsest/contract/server";

import { Badge } from "@/components/ui/badge";
import { pathRelativeToWorkspace } from "@/lib/path-display";

function healthCheckBadgeVariant(
  status: string,
): "success" | "failed" | "warning" {
  if (status === "ok") {
    return "success";
  }

  if (status === "not_configured") {
    return "warning";
  }

  return "failed";
}

export type HealthCheckRow = {
  label: string;
  status: string;
  detail: string;
  blocking: boolean;
};

export function buildHealthCheckRows(
  health: EnvironmentHealthSummary,
  workspaceRoot: string,
): HealthCheckRow[] {
  return [
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
}

export function summarizeHealthChecks(checks: HealthCheckRow[]): {
  allOk: boolean;
  blockingIssues: number;
  optionalIssues: number;
} {
  const blockingIssues = checks.filter(
    (c) => c.blocking && c.status !== "ok",
  ).length;
  const optionalIssues = checks.filter(
    (c) => !c.blocking && c.status !== "ok" && c.status !== "not_configured",
  ).length;
  const allOk = blockingIssues === 0 && optionalIssues === 0;
  return { allOk, blockingIssues, optionalIssues };
}

export function HealthChecksGrid({ checks }: { checks: HealthCheckRow[] }) {
  return (
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
            <Badge variant={healthCheckBadgeVariant(check.status)}>
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
  );
}
