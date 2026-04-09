"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  AdjudicateInspectorPayload,
  RunDetail,
  RunStageGroupDetail,
} from "palimpsest/ui-contract";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { RichText } from "@/lib/rich-text";
import { fetchJson } from "@/lib/utils";

type VerdictCounts = {
  supported: number;
  partially_supported: number;
  overstated_or_generalized: number;
  not_supported: number;
  cannot_determine: number;
  total: number;
};

const VERDICT_LABELS: Record<string, string> = {
  supported: "Supported",
  partially_supported: "Partially supported",
  overstated_or_generalized: "Overstated",
  not_supported: "Not supported",
  cannot_determine: "Unclear",
};

const VERDICT_COLORS: Record<string, string> = {
  supported: "bg-[var(--success)]",
  partially_supported: "bg-[var(--warning)]",
  overstated_or_generalized: "bg-[rgba(151,100,44,0.6)]",
  not_supported: "bg-[var(--danger)]",
  cannot_determine: "bg-[var(--border-strong)]",
};

const VERDICT_TEXT_COLORS: Record<string, string> = {
  supported: "text-[var(--success)]",
  partially_supported: "text-[var(--warning)]",
  overstated_or_generalized: "text-[rgba(151,100,44,0.9)]",
  not_supported: "text-[var(--danger)]",
  cannot_determine: "text-[var(--text-muted)]",
};

function countVerdicts(
  records: AdjudicateInspectorPayload["records"],
): VerdictCounts {
  let supported = 0;
  let partially_supported = 0;
  let overstated_or_generalized = 0;
  let not_supported = 0;
  let cannot_determine = 0;
  let total = 0;

  for (const record of records) {
    if (record.excluded) continue;
    total++;
    const v = record.verdict ?? "";
    if (v === "supported") supported++;
    else if (v === "partially_supported") partially_supported++;
    else if (v === "overstated_or_generalized") overstated_or_generalized++;
    else if (v === "not_supported") not_supported++;
    else if (v === "cannot_determine") cannot_determine++;
  }

  return {
    supported,
    partially_supported,
    overstated_or_generalized,
    not_supported,
    cannot_determine,
    total,
  };
}

function buildHeadline(counts: VerdictCounts): string {
  const { total, supported, partially_supported } = counts;
  const faithful = supported + partially_supported;
  if (total === 0) return "No verdicts recorded.";
  return `${String(faithful)} of ${String(total)} adjudicated citations faithfully represent the claim.`;
}

export function RunResultsSummary({ run }: { run: RunDetail }) {
  const [group, setGroup] = useState<RunStageGroupDetail<"adjudicate"> | null>(
    null,
  );

  useEffect(() => {
    void fetchJson<RunStageGroupDetail<"adjudicate">>(
      `/api/runs/${run.id}/stages/adjudicate`,
    )
      .then(setGroup)
      .catch(() => null);
  }, [run.id]);

  if (!group) {
    return null;
  }

  const records = group.members.flatMap((member) => member.inspectorPayload?.records ?? []);
  if (records.length === 0) return null;

  const counts = countVerdicts(records);
  const headline = buildHeadline(counts);

  const VERDICT_ORDER = [
    "supported",
    "partially_supported",
    "overstated_or_generalized",
    "not_supported",
    "cannot_determine",
  ] as const;

  // Flagged = not_supported or overstated
  const flagged = records.filter((record) => {
    const verdict = record.verdict ?? "";
    return (
      (verdict === "not_supported" ||
        verdict === "overstated_or_generalized") &&
      !record.excluded
    );
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          Results
        </p>
        <h2 className="mt-2 font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
          {headline}
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-[var(--text-muted)]">
          {run.trackedClaim}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Verdict distribution */}
        <div>
          <div className="mb-3 flex gap-1 overflow-hidden rounded-full">
            {VERDICT_ORDER.map((v) => {
              const count = counts[v];
              if (count === 0 || counts.total === 0) return null;
              const pct = (count / counts.total) * 100;
              return (
                <div
                  key={v}
                  className={`h-3 ${VERDICT_COLORS[v]}`}
                  style={{ width: `${pct}%` }}
                  title={`${VERDICT_LABELS[v]}: ${String(count)}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-4">
            {VERDICT_ORDER.map((v) => {
              const count = counts[v];
              if (count === 0) return null;
              return (
                <div key={v} className="flex items-center gap-2">
                  <span
                    className={`text-lg font-bold ${VERDICT_TEXT_COLORS[v]}`}
                  >
                    {String(count)}
                  </span>
                  <span className="text-sm text-[var(--text-muted)]">
                    {VERDICT_LABELS[v]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Flagged citations */}
        {flagged.length > 0 ? (
          <div>
            <p className="mb-3 text-sm font-semibold text-[var(--text)]">
              Citations needing attention
            </p>
            <div className="space-y-2">
              {flagged.slice(0, 5).map((record) => (
                <div
                  className="rounded-[20px] border border-[rgba(154,64,54,0.15)] bg-[rgba(154,64,54,0.04)] p-4"
                  key={record.taskId}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--danger)]">
                        {VERDICT_LABELS[record.verdict ?? ""] ??
                          (record.verdict ?? "")}
                      </p>
                      <RichText
                        html={record.citingPaperTitle}
                        as="p"
                        className="mt-1 text-sm font-semibold text-[var(--text)]"
                      />
                      {record.citingSpan ? (
                        <p className="mt-2 line-clamp-2 text-sm text-[var(--text-muted)]">
                          {record.citingSpan}
                        </p>
                      ) : null}
                    </div>
                    <Link
                      className="shrink-0 text-sm font-semibold text-[var(--accent)] hover:underline"
                      href={`/runs/${run.id}/stages/adjudicate`}
                    >
                      View
                    </Link>
                  </div>
                </div>
              ))}
              {flagged.length > 5 ? (
                <p className="text-sm text-[var(--text-muted)]">
                  +{String(flagged.length - 5)} more —{" "}
                  <Link
                    className="font-semibold text-[var(--accent)]"
                    href={`/runs/${run.id}/stages/adjudicate`}
                  >
                    view all in adjudicate stage
                  </Link>
                </p>
              ) : null}
            </div>
          </div>
        ) : counts.not_supported === 0 &&
          counts.overstated_or_generalized === 0 ? (
          <p className="text-sm text-[var(--success)]">
            No citations were flagged as not supported or overstated.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
