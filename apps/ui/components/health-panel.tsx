import type { EnvironmentHealthSummary } from "citation-fidelity/ui-contract/server";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            Environment Health
          </p>
          <h2 className="mt-2 font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
            Local dependencies and stage blockers
          </h2>
        </div>
        <p className="max-w-lg text-sm text-[var(--text-muted)]">
          Blocking services stop only the stages that depend on them. Optional
          services degrade inspection quality, not the whole app.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-4">
        {checks.map((check) => (
          <div
            key={check.label}
            className="rounded-[24px] border border-[var(--border)] bg-white/55 p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[var(--text)]">
                {check.label}
              </p>
              <Badge variant={variantForStatus(check.status)}>
                {check.status}
              </Badge>
            </div>
            <p className="mt-4 text-sm text-[var(--text-muted)]">
              {check.detail}
            </p>
            <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {check.blocking ? "blocking" : "optional"}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
