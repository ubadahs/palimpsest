"use client";

import type { RunDetail, RunVerdictSummary } from "palimpsest/contract";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  VERDICT_BG_COLORS,
  VERDICT_LABELS,
  VERDICT_ORDER,
  VERDICT_TEXT_COLORS,
} from "@/lib/verdict-tokens";

function headline(summary: RunVerdictSummary): string {
  if (summary.total === 0) return "No adjudicated records.";
  return `${String(summary.F)} of ${String(summary.total)} adjudicated records are faithful.`;
}

export function RunResultsSummary({ run }: { run: RunDetail }) {
  const verdicts = run.verdictSummary;
  if (!verdicts) return null;
  if (verdicts.total === 0 && verdicts.notAdjudicated === 0) return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          Canonical results
        </p>
        <h2 className="mt-2 font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
          {headline(verdicts)}
        </h2>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex gap-1 overflow-hidden rounded-full">
          {VERDICT_ORDER.map((verdict) => {
            const count = verdicts[verdict];
            if (count === 0 || verdicts.total === 0) return null;
            return (
              <div
                className={`h-3 ${VERDICT_BG_COLORS[verdict]}`}
                key={verdict}
                style={{ width: `${String((count / verdicts.total) * 100)}%` }}
                title={`${VERDICT_LABELS[verdict]}: ${String(count)}`}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap gap-5">
          {VERDICT_ORDER.map((verdict) => (
            <div key={verdict}>
              <span
                className={`text-lg font-bold ${VERDICT_TEXT_COLORS[verdict]}`}
              >
                {verdicts[verdict]}
              </span>
              <span className="ml-2 text-sm text-[var(--text-muted)]">
                {verdict} · {VERDICT_LABELS[verdict]}
              </span>
            </div>
          ))}
        </div>
        <p className="text-sm text-[var(--text-muted)]">
          Operational non-verdicts: {verdicts.notAdjudicated} not adjudicated,{" "}
          {verdicts.adjudicationFailed} failed, and {verdicts.invalidOutput}{" "}
          invalid output.
        </p>
      </CardContent>
    </Card>
  );
}
