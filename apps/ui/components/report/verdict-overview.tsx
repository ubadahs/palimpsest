import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  VERDICT_BG_COLORS,
  VERDICT_LABELS,
  VERDICT_ORDER,
  VERDICT_TEXT_COLORS,
} from "@/lib/verdict-tokens";

import { RateCard } from "./metrics";
import type { ReportPayload } from "./types";

export function VerdictOverview({
  funnel,
  rates,
}: {
  funnel: ReportPayload["summary"]["funnel"];
  rates: ReportPayload["summary"]["rates"];
}) {
  const adjudicated = funnel.adjudicate.adjudicated.count;
  const counts = {
    F: funnel.adjudicate.verdictCounts.F.count,
    D: funnel.adjudicate.verdictCounts.D.count,
    E: funnel.adjudicate.verdictCounts.E.count,
    U: funnel.adjudicate.verdictCounts.U.count,
  } as const;
  const coverage = rates.find(
    (rate) => rate.metricId === "adjudication_coverage",
  );
  const retrieval = rates.find(
    (rate) => rate.metricId === "retrieval_coverage",
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          Verdict distribution
        </p>
        <h3 className="mt-2 font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
          {String(counts.F)} of {String(adjudicated)} adjudicated records
          received F
        </h3>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          Rates use the adjudicated-record denominator only. Operational
          non-verdicts are excluded.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div
          aria-label="Adjudicated verdict distribution"
          className="flex gap-1 overflow-hidden rounded-full"
          role="img"
        >
          {VERDICT_ORDER.map((verdict) => {
            const count = counts[verdict];
            if (count === 0 || adjudicated === 0) return null;
            return (
              <div
                className={`h-3 ${VERDICT_BG_COLORS[verdict]}`}
                key={verdict}
                style={{ width: `${String((count / adjudicated) * 100)}%` }}
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
                {counts[verdict]}
              </span>
              <span className="ml-2 text-sm text-[var(--text-muted)]">
                {verdict} · {VERDICT_LABELS[verdict]}
              </span>
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {retrieval ? <RateCard rate={retrieval} /> : null}
          {coverage ? <RateCard rate={coverage} /> : null}
        </div>
        <p className="text-sm text-[var(--text-muted)]">
          Operational non-verdicts: {funnel.adjudicate.notAdjudicated.count} not
          adjudicated, {funnel.adjudicate.adjudicationFailed.count} failed, and{" "}
          {funnel.adjudicate.invalidOutput.count} invalid output.
        </p>
      </CardContent>
    </Card>
  );
}
