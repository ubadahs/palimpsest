import { humanizeCode, type ReportCountLike } from "@/lib/report-format";

import { CountLine, MetricTile, RateCard } from "./metrics";
import type { ReportPayload } from "./types";

export function FunnelOverview({
  funnel,
  rates,
}: {
  funnel: ReportPayload["summary"]["funnel"];
  rates: ReportPayload["summary"]["rates"];
}) {
  const scopeSelection = rates.find(
    (rate) => rate.metricId === "scope_selection_rate",
  );
  const stages: Array<{
    key: string;
    title: string;
    headline: string;
    counts: ReportCountLike[];
    extras?: string[];
  }> = [
    {
      key: "discover",
      title: "Discover",
      headline: `${String(funnel.discover.selectedCandidates.count)} of ${String(funnel.discover.candidateClaims.count)} candidates selected`,
      counts: [
        funnel.discover.returnedCitingPaperObservations,
        funnel.discover.citationOccurrences,
        funnel.discover.candidateClaims,
        funnel.discover.selectedCandidates,
        funnel.discover.deferredCandidates,
        funnel.discover.uniqueCitationGroups,
        funnel.discover.attributedClaimsWithVerifiedSupportSpan,
        funnel.discover.attributedClaimsMissingSupportSpan,
      ],
      extras: [
        `Deferred by family cap: ${String(funnel.discover.deferredByFamilyCap.count)}`,
        `Deferred by record budget: ${String(funnel.discover.deferredByRecordBudget.count)}`,
        `Deferred by novelty: ${String(funnel.discover.deferredByNovelty.count)}`,
      ],
    },
    {
      key: "scope",
      title: "Scope",
      headline: `${String(funnel.scope.families.count)} families frozen`,
      counts: [
        funnel.scope.scopedCandidates,
        funnel.scope.deferredCandidates,
        funnel.scope.families,
      ],
      extras: funnel.scope.groundingStatusCounts.map(
        (item) => `${humanizeCode(item.status)}: ${String(item.count)}`,
      ),
    },
    {
      key: "prepare",
      title: "Prepare",
      headline: `${String(funnel.prepare.preparedRecords.count)} family × occurrence records`,
      counts: [
        funnel.prepare.preparedRecords,
        funnel.prepare.classified,
        funnel.prepare.ambiguous,
        funnel.prepare.manualReview,
      ],
      extras: [
        `Manual review (role ambiguous): ${String(funnel.prepare.manualReviewRoleAmbiguous.count)}`,
        `Manual review (extraction limited): ${String(funnel.prepare.manualReviewExtractionLimited.count)}`,
        "Low-information and manual-review counts may overlap classification statuses.",
      ],
    },
    {
      key: "evidence",
      title: "Evidence",
      headline: `${String(funnel.evidence.recordOutcomes.count)} retrieval outcomes`,
      counts: [
        funnel.evidence.recordOutcomes,
        funnel.evidence.bm25MatchedRuns,
        funnel.evidence.uniqueFinalSelectionsBm25,
        funnel.evidence.uniqueFinalSelectionsReranked,
      ],
      extras: funnel.evidence.retrievalStatusCounts.map(
        (item) => `${humanizeCode(item.status)}: ${String(item.count)}`,
      ),
    },
    {
      key: "adjudicate",
      title: "Adjudicate",
      headline: `${String(funnel.adjudicate.adjudicated.count)} of ${String(funnel.adjudicate.totalRecordOutcomes.count)} records adjudicated`,
      counts: [
        funnel.adjudicate.totalRecordOutcomes,
        funnel.adjudicate.adjudicated,
        funnel.adjudicate.notAdjudicated,
        funnel.adjudicate.uniqueClaimUnits,
        funnel.adjudicate.verdictCounts.F,
        funnel.adjudicate.verdictCounts.D,
      ],
      extras: [
        `Verified support spans: ${String(funnel.adjudicate.packetsWithVerifiedSupportSpans.count)}`,
        `Missing support spans: ${String(funnel.adjudicate.packetsMissingSupportSpans.count)}`,
        `Evidence limited: ${String(funnel.adjudicate.evidenceLimited.count)}`,
        `Figure-only limitation: ${String(funnel.adjudicate.figureOnlyLimitation.count)}`,
        ...funnel.adjudicate.mutationKindCounts.map(
          (item) =>
            `Mutation ${humanizeCode(item.status)}: ${String(item.count)}`,
        ),
        ...funnel.adjudicate.gateCodeCounts.map(
          (item) => `${humanizeCode(item.status)}: ${String(item.count)}`,
        ),
      ],
    },
  ];

  return (
    <div className="space-y-4">
      {scopeSelection ? (
        <div className="grid gap-3 md:grid-cols-3">
          <RateCard rate={scopeSelection} />
          <MetricTile
            label="Prepared records"
            value={funnel.prepare.preparedRecords.count}
            hint={funnel.prepare.preparedRecords.population}
          />
          <MetricTile
            label="Unique citation groups"
            value={funnel.discover.uniqueCitationGroups.count}
            hint={funnel.discover.uniqueCitationGroups.population}
          />
        </div>
      ) : null}
      <div className="grid gap-3 xl:grid-cols-5">
        {stages.map((stage) => (
          <div
            className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4"
            key={stage.key}
          >
            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
              {stage.title}
            </p>
            <p className="mt-2 text-sm font-semibold leading-6 text-[var(--text)]">
              {stage.headline}
            </p>
            <div className="mt-4 space-y-2">
              {stage.counts.map((count) => (
                <CountLine count={count} key={count.metricId} />
              ))}
            </div>
            {stage.extras && stage.extras.length > 0 ? (
              <div className="mt-4 space-y-1 border-t border-[var(--border)] pt-3">
                {stage.extras.map((extra) => (
                  <p
                    className="text-xs leading-5 text-[var(--text-muted)]"
                    key={extra}
                  >
                    {extra}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
