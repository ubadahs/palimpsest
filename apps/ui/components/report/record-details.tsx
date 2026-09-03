import type { ReportInspectorRecordRow } from "palimpsest/contract";

import { Badge } from "@/components/ui/badge";
import { humanizeCode, recordOutcomeLabel, shortId } from "@/lib/report-format";
import { DoiLink } from "@/lib/rich-text";

export function outcomeBadgeVariant(
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

export function EvidencePassages({
  record,
  hideMachineJudgment = false,
  heading = "Selected evidence",
}: {
  record: ReportInspectorRecordRow;
  /** While blinded, hide which passages the adjudicator cited and how they were ranked. */
  hideMachineJudgment?: boolean;
  heading?: string;
}) {
  if (record.evidencePassages.length === 0) {
    return null;
  }
  return (
    <section className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
        {heading}
        {record.rankingSource && !hideMachineJudgment
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
            {passage.pinned ? <Badge variant="neutral">Pinned</Badge> : null}
            {passage.modelCited && !hideMachineJudgment ? (
              <Badge variant="running">Model cited</Badge>
            ) : null}
            {passage.sourceSectionTitle ? (
              <span className="text-[11px] text-[var(--text-muted)]">
                {passage.sourceSectionTitle}
              </span>
            ) : null}
          </div>
          <p className="text-sm leading-7 text-[var(--text)]">{passage.text}</p>
        </div>
      ))}
    </section>
  );
}

function RecordDetails({
  record,
  showTechnicalIds = true,
}: {
  record: ReportInspectorRecordRow;
  showTechnicalIds?: boolean;
}) {
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          Citing paper
        </h4>
        <p className="text-sm text-[var(--text)]">{record.citingPaperTitle}</p>
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

      <EvidencePassages record={record} />

      {record.citingAssertion ||
      record.rationale ||
      record.operationalReason ? (
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Adjudication
          </h4>
          {record.citingAssertion ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold text-[var(--text-muted)]">
                  Citing paper asserts
                </p>
                <p className="mt-1 text-sm leading-7 text-[var(--text)]">
                  {record.citingAssertion}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text-muted)]">
                  Seed evidence says
                </p>
                <p className="mt-1 text-sm leading-7 text-[var(--text)]">
                  {record.sourceStatement}
                </p>
              </div>
            </div>
          ) : null}
          {record.mutationKinds && record.mutationKinds.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-[var(--text-muted)]">
                Mutation
              </p>
              <p className="mt-1 text-sm leading-7 text-[var(--text)]">
                {record.direction ? `${record.direction}: ` : ""}
                {record.mutationKinds
                  .map((kind) => kind.replace(/_/g, " "))
                  .join(", ")}
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

      {showTechnicalIds ? (
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
      ) : null}
    </div>
  );
}

export function RecordCard({ record }: { record: ReportInspectorRecordRow }) {
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
      <div className="border-t border-[var(--border)] px-5 py-5">
        <RecordDetails record={record} />
      </div>
    </details>
  );
}
