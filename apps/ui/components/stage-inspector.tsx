"use client";

import type {
  RunStageDetail,
  StageInspectorPayload,
} from "palimpsest/contract";

import { ReportInspector } from "@/components/report-inspector";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ErrorBanner } from "@/components/ui/error-banner";

function PayloadJson({ payload }: { payload: StageInspectorPayload }) {
  return (
    <pre className="max-h-[540px] overflow-auto rounded-[20px] border border-[var(--border)] bg-[#1f1b17] p-5 text-xs leading-6 text-[#efe6da]">
      {JSON.stringify(payload.rawArtifact, null, 2)}
    </pre>
  );
}

function Summary({ entries }: { entries: Array<[string, string | number]> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {entries.map(([label, value]) => (
        <div
          className="rounded-[20px] border border-[var(--border)] bg-white/60 p-4"
          key={label}
        >
          <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
            {label}
          </p>
          <p className="mt-1 text-lg font-semibold text-[var(--text)]">
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}

function CanonicalInspector({
  payload,
  runId,
}: {
  payload: StageInspectorPayload;
  runId: string;
}) {
  switch (payload.stageKey) {
    case "discover":
      return (
        <>
          <Summary entries={Object.entries(payload.summary)} />
          <PayloadJson payload={payload} />
        </>
      );
    case "scope":
      return (
        <>
          <Summary entries={Object.entries(payload.summary)} />
          <PayloadJson payload={payload} />
        </>
      );
    case "prepare":
      return (
        <>
          <Summary entries={Object.entries(payload.summary)} />
          <PayloadJson payload={payload} />
        </>
      );
    case "evidence":
      return (
        <>
          <Summary
            entries={[
              ["Records", payload.summary.records],
              ["Selections", payload.summary.selections],
              ["BM25 runs", payload.summary.bm25Runs],
              ["Rerank runs", payload.summary.rerankRuns],
            ]}
          />
          <PayloadJson payload={payload} />
        </>
      );
    case "adjudicate":
      return (
        <>
          <Summary
            entries={[
              ["Records", payload.summary.records],
              ["F", payload.summary.F],
              ["D", payload.summary.D],
              ["E", payload.summary.E],
              ["U", payload.summary.U],
              ["Not adjudicated", payload.summary.notAdjudicated],
              ["Adjudication failed", payload.summary.adjudicationFailed],
              ["Invalid output", payload.summary.invalidOutput],
            ]}
          />
          <PayloadJson payload={payload} />
        </>
      );
    case "report":
      return <ReportInspector payload={payload} runId={runId} />;
  }
}

export function StageInspector({
  detail,
  runId,
}: {
  detail: RunStageDetail;
  runId: string;
}) {
  if (detail.stageKey === "report" && detail.inspectorPayload) {
    return (
      <div className="space-y-4">
        {detail.errorMessage ? (
          <ErrorBanner>{detail.errorMessage}</ErrorBanner>
        ) : null}
        <CanonicalInspector payload={detail.inspectorPayload} runId={runId} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {detail.errorMessage ? (
        <ErrorBanner>{detail.errorMessage}</ErrorBanner>
      ) : null}
      {detail.inspectorPayload ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-semibold text-[var(--text)]">
              Canonical {detail.stageTitle} inspector
            </h3>
          </CardHeader>
          <CardContent className="space-y-5">
            <CanonicalInspector
              payload={detail.inspectorPayload}
              runId={runId}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
