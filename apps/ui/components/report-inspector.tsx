"use client";

import { useMemo, useState } from "react";
import type {
  ReportInspectorRecordRow,
  StageInspectorPayload,
} from "palimpsest/contract";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  formatRateFraction,
  formatRateValue,
  humanizeCode,
  rateLabel,
  recordOutcomeLabel,
  shortId,
  type ReportCountLike,
  type ReportRateLike,
} from "@/lib/report-format";
import { DoiLink } from "@/lib/rich-text";
import { cn } from "@/lib/utils";
import {
  VERDICT_BG_COLORS,
  VERDICT_LABELS,
  VERDICT_ORDER,
  VERDICT_TEXT_COLORS,
} from "@/lib/verdict-tokens";

type ReportPayload = StageInspectorPayload<"report">;

type RecordFilter =
  | "all"
  | "F"
  | "D"
  | "E"
  | "U"
  | "not_adjudicated"
  | "failed";

function MetricTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div
      className="rounded-[20px] border border-[var(--border)] bg-white/60 p-4"
      title={hint}
    >
      <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-[var(--text)]">
        {value}
      </p>
    </div>
  );
}

function CountLine({ count }: { count: ReportCountLike }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-[var(--text-muted)]" title={count.population}>
        {humanizeCode(count.metricId.split(".").at(-1) ?? count.metricId)}
      </span>
      <span className="font-semibold tabular-nums text-[var(--text)]">
        {count.count}
      </span>
    </div>
  );
}

function RateCard({ rate }: { rate: ReportRateLike }) {
  const pct =
    rate.value == null || rate.denominator === 0 ? 0 : rate.value * 100;
  return (
    <div
      className="rounded-[20px] border border-[var(--border)] bg-white/60 p-4"
      title={`${rate.numeratorDefinition} / ${rate.denominatorDefinition}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
            {rateLabel(rate.metricId)}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-[var(--text)]">
            {formatRateValue(rate)}
          </p>
        </div>
        <p className="text-xs tabular-nums text-[var(--text-muted)]">
          {formatRateFraction(rate)}
        </p>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--panel-muted)]">
        <div
          className="h-full rounded-full bg-[var(--accent)]"
          style={{ width: `${String(Math.min(100, pct))}%` }}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
        {rate.populationLabel}
      </p>
    </div>
  );
}

function VerdictOverview({
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

function FunnelOverview({
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

function outcomeBadgeVariant(
  record: ReportInspectorRecordRow,
): "success" | "failed" | "warning" | "neutral" | "stale" {
  if (record.adjudicationStatus === "adjudicated") {
    if (record.verdict === "F") return "success";
    if (record.verdict === "D" || record.verdict === "E") return "failed";
    return "stale";
  }
  if (record.adjudicationStatus === "not_adjudicated") return "warning";
  return "failed";
}

function matchesFilter(
  record: ReportInspectorRecordRow,
  filter: RecordFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "not_adjudicated") {
    return record.adjudicationStatus === "not_adjudicated";
  }
  if (filter === "failed") {
    return (
      record.adjudicationStatus === "adjudication_failed" ||
      record.adjudicationStatus === "invalid_output"
    );
  }
  return (
    record.adjudicationStatus === "adjudicated" && record.verdict === filter
  );
}

function RecordCard({ record }: { record: ReportInspectorRecordRow }) {
  return (
    <details className="group rounded-[24px] border border-[var(--border)] bg-white/60 open:bg-white/80">
      <summary className="cursor-pointer list-none px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={outcomeBadgeVariant(record)}>
                {recordOutcomeLabel(record)}
              </Badge>
              {record.confidence ? (
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  {record.confidence} confidence
                </span>
              ) : null}
              {record.citationRole ? (
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  {humanizeCode(record.citationRole)}
                </span>
              ) : null}
              <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                {humanizeCode(record.retrievalStatus)}
              </span>
            </div>
            <p className="text-sm font-semibold leading-6 text-[var(--text)]">
              {record.evaluatedClaimText}
            </p>
            <p className="text-sm text-[var(--text-muted)]">
              {record.citingPaperTitle}
              {record.citingPaperYear != null
                ? ` (${String(record.citingPaperYear)})`
                : ""}
              {record.seedRefLabel ? ` · ${record.seedRefLabel}` : ""}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)] group-open:bg-[var(--panel-muted)] group-open:text-[var(--text)]">
            <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span>
          </span>
        </div>
      </summary>
      <div className="space-y-5 border-t border-[var(--border)] px-5 py-5">
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Citing paper
          </h4>
          <p className="text-sm text-[var(--text)]">
            {record.citingPaperTitle}
          </p>
          {record.citingPaperDoi ? (
            <DoiLink
              className="text-sm text-[var(--accent)] hover:underline"
              doi={record.citingPaperDoi}
            />
          ) : null}
          {record.sectionTitle ? (
            <p className="text-sm text-[var(--text-muted)]">
              Section: {record.sectionTitle}
            </p>
          ) : null}
        </section>

        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Tracked family claim
          </h4>
          <p className="text-sm leading-6 text-[var(--text)]">
            {record.trackedClaim}
          </p>
          {record.groundingStatus ? (
            <p className="text-xs text-[var(--text-muted)]">
              Grounding: {humanizeCode(record.groundingStatus)}
            </p>
          ) : null}
        </section>

        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Citation context
          </h4>
          <blockquote className="rounded-[20px] border border-[var(--border)] bg-[var(--panel-muted)] px-4 py-3 text-sm leading-7 text-[var(--text)]">
            {record.citationContext}
          </blockquote>
        </section>

        {record.evidencePassages.length > 0 ? (
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              Selected evidence
              {record.rankingSource
                ? ` · ${humanizeCode(record.rankingSource)}`
                : ""}
            </h4>
            {record.evidencePassages.map((passage, index) => (
              <div
                className="rounded-[20px] border border-[var(--border)] bg-white/70 px-4 py-3"
                key={passage.chunkId}
              >
                <div className="mb-2 flex flex-wrap gap-2">
                  <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                    Passage {String(index + 1)}
                  </span>
                  {passage.pinned ? (
                    <Badge variant="neutral">Pinned</Badge>
                  ) : null}
                  {passage.modelCited ? (
                    <Badge variant="running">Model cited</Badge>
                  ) : null}
                  {passage.sourceSectionTitle ? (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {passage.sourceSectionTitle}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm leading-7 text-[var(--text)]">
                  {passage.text}
                </p>
              </div>
            ))}
          </section>
        ) : null}

        {record.comparison || record.rationale || record.operationalReason ? (
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              Adjudication
            </h4>
            {record.comparison ? (
              <div>
                <p className="text-xs font-semibold text-[var(--text-muted)]">
                  Comparison
                </p>
                <p className="mt-1 text-sm leading-7 text-[var(--text)]">
                  {record.comparison}
                </p>
              </div>
            ) : null}
            {record.rationale ? (
              <div>
                <p className="text-xs font-semibold text-[var(--text-muted)]">
                  Rationale
                </p>
                <p className="mt-1 text-sm leading-7 text-[var(--text)]">
                  {record.rationale}
                </p>
              </div>
            ) : null}
            {record.operationalReason ? (
              <div>
                <p className="text-xs font-semibold text-[var(--text-muted)]">
                  Operational reason
                </p>
                <p className="mt-1 text-sm leading-7 text-[var(--text)]">
                  {record.operationalReason}
                </p>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Technical IDs
          </h4>
          <div className="grid gap-2 text-xs text-[var(--text-muted)] sm:grid-cols-2">
            <p title={record.recordId}>record: {shortId(record.recordId)}</p>
            <p title={record.familyId}>family: {shortId(record.familyId)}</p>
            <p title={record.citationOccurrenceId}>
              occurrence: {shortId(record.citationOccurrenceId)}
            </p>
            {record.evaluationMode ? (
              <p>evaluation: {humanizeCode(record.evaluationMode)}</p>
            ) : null}
          </div>
        </section>
      </div>
    </details>
  );
}

function RecordsBrowser({ records }: { records: ReportInspectorRecordRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RecordFilter>("all");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((record) => {
      if (!matchesFilter(record, filter)) return false;
      if (!needle) return true;
      const haystack = [
        record.evaluatedClaimText,
        record.trackedClaim,
        record.citingPaperTitle,
        record.citingPaperDoi ?? "",
        record.seedRefLabel ?? "",
        record.citationContext,
        record.rationale ?? "",
        record.comparison ?? "",
        record.operationalReason ?? "",
        record.gateCode ?? "",
        record.verdict ?? "",
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [filter, query, records]);

  const filters: Array<{ id: RecordFilter; label: string }> = [
    { id: "all", label: `All (${String(records.length)})` },
    ...VERDICT_ORDER.map((verdict) => ({
      id: verdict as RecordFilter,
      label: `${verdict} (${String(records.filter((r) => r.verdict === verdict).length)})`,
    })),
    {
      id: "not_adjudicated",
      label: `Gated (${String(records.filter((r) => r.adjudicationStatus === "not_adjudicated").length)})`,
    },
    {
      id: "failed",
      label: `Failed (${String(records.filter((r) => r.adjudicationStatus === "adjudication_failed" || r.adjudicationStatus === "invalid_output").length)})`,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Input
          aria-label="Search report records"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search claims, papers, rationales…"
          value={query}
        />
        <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
          {filters.map((item) => (
            <button
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                filter === item.id
                  ? "border-[var(--border-strong)] bg-[var(--text)] text-white"
                  : "border-[var(--border)] bg-white/60 text-[var(--text-muted)] hover:bg-white/80",
              )}
              key={item.id}
              onClick={() => setFilter(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-[var(--text-muted)]">
        Showing {String(filtered.length)} of {String(records.length)} records
      </p>
      <div className="space-y-3">
        {filtered.map((record) => (
          <RecordCard key={record.recordId} record={record} />
        ))}
        {filtered.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-[var(--text-muted)]">
              No records match this filter.
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function AuditTrail({
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

export function ReportInspector({
  payload,
  runId,
  defaultTab = "overview",
}: {
  payload: ReportPayload;
  runId: string;
  defaultTab?: "overview" | "records" | "audit";
}) {
  const { summary } = payload;
  const verdictRates = summary.rates.filter((rate) =>
    rate.metricId.startsWith("verdict_"),
  );

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-[rgba(151,100,44,0.28)]">
        <CardContent className="space-y-3 py-5">
          <Badge variant="warning">{summary.interpretationStatus}</Badge>
          <p className="font-[var(--font-instrument)] text-2xl tracking-[-0.03em] text-[var(--text)]">
            Uncalibrated research output
          </p>
          <p className="max-w-4xl text-sm leading-7 text-[var(--text-muted)]">
            {summary.interpretationWarning}
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue={defaultTab}>
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="records">
              Records ({String(summary.records.length)})
            </TabsTrigger>
            <TabsTrigger value="audit">Audit trail</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-4">
          <VerdictOverview funnel={summary.funnel} rates={summary.rates} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {verdictRates.map((rate) => (
              <RateCard key={rate.metricId} rate={rate} />
            ))}
          </div>
          <FunnelOverview funnel={summary.funnel} rates={summary.rates} />
        </TabsContent>

        <TabsContent value="records">
          <RecordsBrowser records={summary.records} />
        </TabsContent>

        <TabsContent value="audit">
          <AuditTrail payload={payload} runId={runId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
