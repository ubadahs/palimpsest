"use client";

import { useEffect, useState } from "react";
import type {
  RunStageDetail,
  StageInspectorPayload,
} from "palimpsest/contract";

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
  markdownUrl,
}: {
  payload: StageInspectorPayload;
  markdownUrl?: string;
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
      return (
        <ReportInspector
          payload={payload}
          {...(markdownUrl ? { markdownUrl } : {})}
        />
      );
  }
}

function ReportInspector({
  payload,
  markdownUrl,
}: {
  payload: StageInspectorPayload<"report">;
  markdownUrl?: string;
}) {
  const [markdown, setMarkdown] = useState<string>();

  useEffect(() => {
    if (!markdownUrl) return;
    void fetch(markdownUrl)
      .then((response) => (response.ok ? response.text() : undefined))
      .then(setMarkdown)
      .catch(() => undefined);
  }, [markdownUrl]);

  return (
    <>
      <Summary
        entries={[["Interpretation", payload.summary.interpretationStatus]]}
      />
      <section className="space-y-2">
        <h3 className="font-semibold text-[var(--text)]">Report JSON</h3>
        <PayloadJson payload={payload} />
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold text-[var(--text)]">Report Markdown</h3>
        <pre className="max-h-[540px] overflow-auto rounded-[20px] border border-[var(--border)] bg-[#1f1b17] p-5 text-xs leading-6 text-[#efe6da]">
          {markdown ?? "Markdown is available in the report artifact tab."}
        </pre>
      </section>
    </>
  );
}

export function StageInspector({
  detail,
  runId,
}: {
  detail: RunStageDetail;
  runId: string;
}) {
  const markdownUrl =
    detail.stageKey === "report"
      ? `/api/runs/${runId}/stages/report/artifacts/report`
      : undefined;
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
              {...(markdownUrl ? { markdownUrl } : {})}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
