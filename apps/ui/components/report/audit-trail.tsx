import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { humanizeCode, shortId } from "@/lib/report-format";

import { MetricTile } from "./metrics";
import type { ReportPayload } from "./types";

export function AuditTrail({
  payload,
  runId,
}: {
  payload: ReportPayload;
  runId: string;
}) {
  const { summary } = payload;
  const lineageEntries = [
    ["Discover", summary.lineage.discoverArtifact],
    ["Scope", summary.lineage.scopeArtifact],
    ["Prepare", summary.lineage.prepareArtifact],
    ["Evidence", summary.lineage.evidenceArtifact],
    ["Adjudicate", summary.lineage.adjudicateArtifact],
  ] as const;

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader>
          <h3 className="font-semibold text-[var(--text)]">Method</h3>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile label="Method" value={summary.method.methodId} />
          <MetricTile label="Strategy" value={summary.method.strategy} />
          <MetricTile
            label="Calibration"
            value={summary.method.calibrationStatus}
          />
          <MetricTile label="Outputs" value={summary.method.outputs} />
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <h3 className="font-semibold text-[var(--text)]">Lineage</h3>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Tamper-verified upstream artifacts for run {summary.lineage.runId}.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {lineageEntries.map(([label, artifact]) => (
            <div
              className="rounded-[20px] border border-[var(--border)] bg-white/60 px-4 py-3"
              key={label}
            >
              <p className="text-sm font-semibold text-[var(--text)]">
                {label}
              </p>
              <p
                className="mt-1 text-xs text-[var(--text-muted)]"
                title={artifact.artifactId}
              >
                {shortId(artifact.artifactId)}
              </p>
              <p
                className="mt-1 break-all font-mono text-[11px] text-[var(--text-muted)]"
                title={artifact.contentHash}
              >
                {artifact.contentHash}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <h3 className="font-semibold text-[var(--text)]">
            Decision summaries
          </h3>
        </CardHeader>
        <CardContent className="space-y-2">
          {summary.decisionSummaries.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              No decision summaries recorded.
            </p>
          ) : (
            summary.decisionSummaries.map((item) => (
              <div
                className="flex items-baseline justify-between gap-3 text-sm"
                key={`${item.stage}-${item.decisionType}-${item.outcome}`}
              >
                <span className="text-[var(--text-muted)]">
                  {item.stage} · {humanizeCode(item.decisionType)} ·{" "}
                  {humanizeCode(item.outcome)}
                </span>
                <span className="font-semibold tabular-nums text-[var(--text)]">
                  {item.count}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <h3 className="font-semibold text-[var(--text)]">
            Exclusion summaries
          </h3>
        </CardHeader>
        <CardContent className="space-y-2">
          {summary.exclusionSummaries.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              No upstream exclusions summarized.
            </p>
          ) : (
            summary.exclusionSummaries.map((item) => (
              <div
                className="flex items-baseline justify-between gap-3 text-sm"
                key={`${item.stage}-${item.reasonCode}`}
              >
                <span className="text-[var(--text-muted)]">
                  {item.stage} · {humanizeCode(item.reasonCode)}
                </span>
                <span className="font-semibold tabular-nums text-[var(--text)]">
                  {item.count}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <h3 className="font-semibold text-[var(--text)]">
            Authoritative artifacts
          </h3>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 text-sm">
          <a
            className="rounded-full border border-[var(--border)] bg-white/70 px-4 py-2 font-semibold text-[var(--accent)] hover:bg-white"
            href={`/api/runs/${runId}/stages/report/artifacts/primary`}
          >
            Report JSON
          </a>
          <a
            className="rounded-full border border-[var(--border)] bg-white/70 px-4 py-2 font-semibold text-[var(--accent)] hover:bg-white"
            href={`/api/runs/${runId}/stages/report/artifacts/report`}
          >
            Report Markdown
          </a>
          <a
            className="rounded-full border border-[var(--border)] bg-white/70 px-4 py-2 font-semibold text-[var(--accent)] hover:bg-white"
            href={`/api/runs/${runId}/stages/report/artifacts/manifest`}
          >
            Manifest
          </a>
        </CardContent>
      </Card>

      <details className="rounded-[28px] border border-[var(--border)] bg-[var(--panel)]">
        <summary className="cursor-pointer list-none px-6 py-5 font-semibold text-[var(--text)] [&::-webkit-details-marker]:hidden">
          Raw report JSON
        </summary>
        <div className="border-t border-[var(--border)] px-6 py-5">
          <pre className="max-h-[540px] overflow-auto rounded-[20px] border border-[var(--border)] bg-[#1f1b17] p-5 text-xs leading-6 text-[#efe6da]">
            {JSON.stringify(payload.rawArtifact, null, 2)}
          </pre>
        </div>
      </details>
    </div>
  );
}
