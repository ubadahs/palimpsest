"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import type {
  AdjudicateInspectorPayload,
  AttributionDiscoverInspectorPayload,
  ClassifyInspectorPayload,
  CurateInspectorPayload,
  EvidenceInspectorPayload,
  ExtractInspectorPayload,
  LegacyDiscoverInspectorPayload,
  RunStageDetail,
  ScreenInspectorPayload,
} from "palimpsest/contract";

import { ChevronDown } from "lucide-react";

import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ErrorBanner } from "@/components/ui/error-banner";
import { DoiLink, RichText } from "@/lib/rich-text";
import {
  formatVerdictSlug,
  verdictBadgeVariant,
  VERDICT_OPTIONS,
  type VerdictKey,
} from "@/lib/verdict-tokens";
import { cn } from "@/lib/utils";

type DiscoverInspectorPayload =
  | LegacyDiscoverInspectorPayload
  | AttributionDiscoverInspectorPayload;
type TableRow = Record<string, string>;

function LegacyDiscoverInspector({
  payload,
}: {
  payload: LegacyDiscoverInspectorPayload | undefined;
}) {
  const rows: TableRow[] = (payload?.papers ?? []).flatMap((paper) =>
    paper.claims.map((claim) => ({
      rank: claim.rank != null ? String(claim.rank) : "—",
      claimText: claim.claimText,
      section: claim.section,
      claimType: String(claim.claimType),
      confidence: String(claim.confidence),
      directCount: String(claim.directCount),
      indirectCount: String(claim.indirectCount),
    })),
  );
  const column = createColumnHelper<TableRow>();

  return (
    <DataTable<TableRow>
      columns={[
        column.accessor("rank", { header: "Rank" }),
        column.accessor("claimText", { header: "Claim" }),
        column.accessor("section", { header: "Section" }),
        column.accessor("claimType", { header: "Type" }),
        column.accessor("confidence", { header: "Confidence" }),
        column.accessor("directCount", { header: "Direct" }),
        column.accessor("indirectCount", { header: "Indirect" }),
      ]}
      data={rows}
      searchPlaceholder="Filter extracted claims"
    />
  );
}

function AttributionDiscoverInspector({
  payload,
}: {
  payload: AttributionDiscoverInspectorPayload | undefined;
}) {
  const rows: TableRow[] = (payload?.results ?? []).flatMap((result) =>
    result.shortlistEntries.map((entry) => ({
      doi: result.doi,
      trackedClaim:
        typeof entry["trackedClaim"] === "string" ? entry["trackedClaim"] : "",
      grounding:
        typeof entry["seedGroundingStatus"] === "string"
          ? entry["seedGroundingStatus"]
          : "—",
      mentions: String(entry["supportingMentionCount"] ?? 0),
      papers: String(entry["supportingPaperCount"] ?? 0),
    })),
  );
  const column = createColumnHelper<TableRow>();

  return (
    <DataTable<TableRow>
      columns={[
        column.accessor("doi", {
          header: "DOI",
          cell: (info) => <DoiLink doi={info.getValue()} />,
        }),
        column.accessor("trackedClaim", { header: "Tracked Claim" }),
        column.accessor("grounding", { header: "Grounding" }),
        column.accessor("mentions", { header: "Mentions" }),
        column.accessor("papers", { header: "Papers" }),
      ]}
      data={rows}
      searchPlaceholder="Filter shortlisted families"
    />
  );
}

function DiscoverInspector({
  payload,
}: {
  payload: DiscoverInspectorPayload | undefined;
}) {
  if (payload?.strategy === "attribution_first") {
    return <AttributionDiscoverInspector payload={payload} />;
  }
  return <LegacyDiscoverInspector payload={payload} />;
}

function ScreenInspector({
  payload,
}: {
  payload: ScreenInspectorPayload | undefined;
}) {
  const edgeRows: TableRow[] = (payload?.families ?? []).flatMap((family) =>
    family.edges.map((edge) => ({
      seedDoi: family.seedDoi,
      trackedClaim: family.trackedClaim,
      decision: String(family.decision),
      auditabilityStatus: String(edge.auditabilityStatus),
      auditabilityReason: edge.auditabilityReason,
      paperType: edge.paperType ?? "—",
      citingPaperId: edge.citingPaperId,
    })),
  );
  const column = createColumnHelper<TableRow>();

  return (
    <DataTable<TableRow>
      columns={[
        column.accessor("seedDoi", {
          header: "Seed DOI",
          cell: (info) => <DoiLink doi={info.getValue()} />,
        }),
        column.accessor("trackedClaim", { header: "Tracked claim" }),
        column.accessor("decision", { header: "Decision" }),
        column.accessor("auditabilityStatus", { header: "Auditability" }),
        column.accessor("paperType", { header: "Paper type" }),
        column.accessor("auditabilityReason", { header: "Reason" }),
      ]}
      data={edgeRows}
      searchPlaceholder="Filter family edges"
    />
  );
}

function ExtractInspector({
  payload,
}: {
  payload: ExtractInspectorPayload | undefined;
}) {
  const rows: TableRow[] = (payload?.edgeResults ?? []).map((edge) => ({
    citingPaperTitle: edge.citingPaperTitle,
    extractionOutcome: String(edge.extractionOutcome),
    usableForGrounding: String(edge.usableForGrounding),
    mentionCount: String(edge.mentionCount),
    failureReason: edge.failureReason ?? "—",
  }));
  const column = createColumnHelper<TableRow>();

  return (
    <DataTable<TableRow>
      columns={[
        column.accessor("citingPaperTitle", {
          header: "Citing paper",
          cell: (info) => <RichText html={info.getValue()} />,
        }),
        column.accessor("extractionOutcome", { header: "Outcome" }),
        column.accessor("usableForGrounding", { header: "Usable" }),
        column.accessor("mentionCount", { header: "Mentions" }),
        column.accessor("failureReason", { header: "Failure" }),
      ]}
      data={rows}
      searchPlaceholder="Filter extraction outcomes"
    />
  );
}

function ClassifyInspector({
  payload,
}: {
  payload: ClassifyInspectorPayload | undefined;
}) {
  const rows: TableRow[] = (payload?.packets ?? []).flatMap((packet) =>
    packet.tasks.map((task) => ({
      citingPaperTitle: packet.citingPaperTitle,
      citingPaperDoi: packet.citingPaperDoi ?? "",
      evaluationMode: String(task.evaluationMode),
      citationRole: String(task.citationRole),
      mentionCount: String(task.mentionCount),
      bundled: String(task.bundled),
      reviewMediated: String(task.reviewMediated),
    })),
  );
  const column = createColumnHelper<TableRow>();

  return (
    <DataTable<TableRow>
      columns={[
        column.accessor("citingPaperTitle", {
          header: "Citing paper",
          cell: (info) => {
            const row = info.row.original;
            return row.citingPaperDoi ? (
              <DoiLink
                doi={row.citingPaperDoi}
                className="text-[var(--text)] hover:text-[var(--accent)] hover:underline"
              >
                <RichText html={info.getValue()} />
              </DoiLink>
            ) : (
              <RichText html={info.getValue()} />
            );
          },
        }),
        column.accessor("evaluationMode", { header: "Evaluation mode" }),
        column.accessor("citationRole", { header: "Citation role" }),
        column.accessor("bundled", { header: "Bundled" }),
        column.accessor("reviewMediated", { header: "Review-mediated" }),
        column.accessor("mentionCount", { header: "Mentions" }),
      ]}
      data={rows}
      searchPlaceholder="Filter evaluation tasks"
    />
  );
}

type EvidenceTaskEntry = {
  citingPaperTitle: string;
  citedPaperTitle: string;
  task: EvidenceInspectorPayload["edges"][number]["tasks"][number];
};

function EvidenceInspector({
  payload,
}: {
  payload: EvidenceInspectorPayload | undefined;
}) {
  const tasks: EvidenceTaskEntry[] = (payload?.edges ?? []).flatMap((edge) =>
    edge.tasks.map((task) => ({
      citingPaperTitle: edge.citingPaperTitle,
      citedPaperTitle: edge.citedPaperTitle,
      task,
    })),
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    tasks[0]?.task.taskId ?? null,
  );

  useEffect(() => {
    if (!tasks.some((entry) => entry.task.taskId === selectedTaskId)) {
      setSelectedTaskId(tasks[0]?.task.taskId ?? null);
    }
  }, [selectedTaskId, tasks]);

  const selected =
    tasks.find((entry) => entry.task.taskId === selectedTaskId) ?? null;

  return (
    <div className="space-y-6">
      {payload?.seed ? (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            {payload.seed.doi ? (
              <div>
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Cited paper
                </span>{" "}
                <DoiLink doi={payload.seed.doi} />
              </div>
            ) : null}
            {payload.seed.trackedClaim ? (
              <div className="basis-full">
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Tracked claim
                </span>
                <RichText
                  html={payload.seed.trackedClaim}
                  as="p"
                  className="mt-1 text-sm leading-6 text-[var(--text)]"
                />
              </div>
            ) : null}
            {payload.summary ? (
              <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-sm text-[var(--text-muted)]">
                <span>
                  <strong className="text-[var(--text)]">
                    {String(payload.summary.totalTasks)}
                  </strong>{" "}
                  tasks
                </span>
                <span>
                  <strong className="text-[var(--text)]">
                    {String(payload.summary.tasksWithEvidence)}
                  </strong>{" "}
                  with evidence
                </span>
                <span>
                  <strong className="text-[var(--text)]">
                    {String(payload.summary.totalEvidenceSpans)}
                  </strong>{" "}
                  spans retrieved
                </span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="overflow-hidden">
          <CardHeader>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
              Citing context
            </p>
            <h3 className="mt-2 font-[var(--font-instrument)] text-2xl tracking-[-0.03em]">
              Evaluation tasks
            </h3>
          </CardHeader>
          <CardContent className="space-y-3">
            {tasks.map((entry) => {
              const mentions = entry.task.citingMentions;
              const active = selectedTaskId === entry.task.taskId;
              return (
                <button
                  className={`w-full select-text rounded-[24px] border p-4 text-left transition ${
                    active
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-[var(--border)] bg-white/60 hover:border-[var(--border-strong)]"
                  }`}
                  key={entry.task.taskId}
                  onClick={() => setSelectedTaskId(entry.task.taskId)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-[var(--text)]">
                      {entry.task.evaluationMode}
                    </p>
                    <Badge variant="neutral">
                      {entry.task.evidenceRetrievalStatus}
                    </Badge>
                  </div>
                  <RichText
                    html={entry.citingPaperTitle}
                    as="p"
                    className="mt-3 text-sm text-[var(--text-muted)]"
                  />
                  <p className="mt-3 text-sm leading-6 text-[var(--text)]">
                    {mentions[0]?.rawContext ?? "No citing context available."}
                  </p>
                </button>
              );
            })}
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
              Cited evidence
            </p>
            <h3 className="mt-2 font-[var(--font-instrument)] text-2xl tracking-[-0.03em]">
              Retrieved blocks
            </h3>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected ? (
              <>
                <div className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                    Rubric question
                  </p>
                  <p className="mt-2 text-sm leading-6 text-[var(--text)]">
                    {selected.task.rubricQuestion}
                  </p>
                </div>
                {selected.task.evidenceSpans.length > 0 ? (
                  selected.task.evidenceSpans.map((span) => (
                    <div
                      className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4"
                      key={span.spanId}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="neutral">{span.blockKind}</Badge>
                        <Badge variant="neutral">{span.matchMethod}</Badge>
                        <span className="text-xs font-semibold text-[var(--accent)]">
                          relevance {span.relevanceScore.toFixed(2)}
                        </span>
                        <span className="ml-auto text-xs text-[var(--text-muted)]">
                          bm25 {span.bm25Score.toFixed(2)}
                          {span.rerankScore != null
                            ? ` · rerank ${span.rerankScore.toFixed(2)}`
                            : ""}
                        </span>
                      </div>
                      <RichText
                        html={span.text}
                        as="p"
                        className="mt-3 text-sm leading-6 text-[var(--text)]"
                      />
                    </div>
                  ))
                ) : (
                  <div className="rounded-[24px] border border-dashed border-[var(--border)] p-6 text-sm text-[var(--text-muted)]">
                    No evidence spans were retrieved for this task.
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-[24px] border border-dashed border-[var(--border)] p-6 text-sm text-[var(--text-muted)]">
                Select a task to inspect its retrieved evidence blocks.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CurateInspector({
  payload,
}: {
  payload: CurateInspectorPayload | undefined;
}) {
  const rows: TableRow[] = (payload?.records ?? []).map((record) => ({
    evaluationMode: String(record.evaluationMode),
    citationRole: String(record.citationRole),
    citingPaperTitle: record.citingPaperTitle,
    excluded: String(record.excluded ?? false),
    excludeReason: record.excludeReason ?? "—",
    evidenceCount: String(record.evidenceCount),
  }));
  const column = createColumnHelper<TableRow>();

  return (
    <DataTable<TableRow>
      columns={[
        column.accessor("evaluationMode", { header: "Mode" }),
        column.accessor("citationRole", { header: "Role" }),
        column.accessor("citingPaperTitle", {
          header: "Citing paper",
          cell: (info) => <RichText html={info.getValue()} />,
        }),
        column.accessor("excluded", { header: "Excluded" }),
        column.accessor("excludeReason", { header: "Exclusion reason" }),
        column.accessor("evidenceCount", { header: "Evidence" }),
      ]}
      data={rows}
      searchPlaceholder="Filter audit records"
    />
  );
}

function AdjudicateInspector({
  payload,
}: {
  payload: AdjudicateInspectorPayload | undefined;
}) {
  const records = payload?.records ?? [];
  const defaultFilter = payload?.defaultVerdictFilter ?? "partially_supported";
  const [filter, setFilter] = useState<VerdictKey>(defaultFilter);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setFilter(defaultFilter);
  }, [defaultFilter]);

  const filtered = useMemo(
    () => records.filter((record) => record.verdict === filter),
    [filter, records],
  );
  const countByVerdict = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const record of records) {
      const verdict = record.verdict ?? "";
      counts[verdict] = (counts[verdict] ?? 0) + 1;
    }
    return counts;
  }, [records]);

  const activeRecords = records.filter((record) => !record.excluded);
  return (
    <div className="space-y-5">
      {payload?.seed ? (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            {payload.seed.doi ? (
              <div>
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Seed paper
                </span>{" "}
                <DoiLink doi={payload.seed.doi} />
              </div>
            ) : null}
            {payload.seed.trackedClaim ? (
              <div className="basis-full">
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Tracked claim
                </span>
                <RichText
                  html={payload.seed.trackedClaim}
                  as="p"
                  className="mt-1 text-sm leading-6 text-[var(--text)]"
                />
              </div>
            ) : null}
            <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-sm text-[var(--text-muted)]">
              <span>
                <strong className="text-[var(--text)]">
                  {String(activeRecords.length)}
                </strong>{" "}
                active records
              </span>
              {payload.runTelemetry ? (
                <span>
                  LLM cost:{" "}
                  <strong className="text-[var(--text)]">
                    ${payload.runTelemetry.estimatedCostUsd.toFixed(2)}
                  </strong>
                </span>
              ) : null}
              {payload.advisor ? (
                <>
                  <span>
                    Advisor:{" "}
                    <strong className="text-[var(--text)]">
                      {String(payload.advisor.escalationCount)}
                    </strong>{" "}
                    escalated
                  </span>
                  {payload.advisor.firstPassTelemetry ? (
                    <span>
                      1st pass:{" "}
                      <strong className="text-[var(--text)]">
                        $
                        {payload.advisor.firstPassTelemetry.estimatedCostUsd.toFixed(
                          2,
                        )}
                      </strong>
                    </span>
                  ) : null}
                  {payload.advisor.escalationTelemetry ? (
                    <span>
                      Escalation:{" "}
                      <strong className="text-[var(--text)]">
                        $
                        {payload.advisor.escalationTelemetry.estimatedCostUsd.toFixed(
                          2,
                        )}
                      </strong>
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {VERDICT_OPTIONS.map((option) => {
          const count = countByVerdict[option] ?? 0;
          return (
            <Button
              className="capitalize"
              key={option}
              onClick={() => setFilter(option)}
              type="button"
              variant={filter === option ? "default" : "secondary"}
            >
              {formatVerdictSlug(option)}
              {count > 0 ? (
                <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] font-bold">
                  {count}
                </span>
              ) : null}
            </Button>
          );
        })}
      </div>
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="rounded-[24px] border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">
            No records with this verdict.
          </div>
        ) : null}
        {filtered.map((record, index) => {
          const key = record.taskId || String(index);
          const isOpen = expanded === key;
          const verdict = record.verdict ?? "";

          return (
            <div
              className="overflow-hidden rounded-[24px] border border-[var(--border)] bg-white/60"
              key={key}
            >
              <div
                className="flex w-full cursor-pointer select-text items-center gap-4 p-4 text-left transition hover:bg-white/80"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  const selection = window.getSelection();
                  if (selection && selection.toString().length > 0) return;
                  setExpanded(isOpen ? null : key);
                  e.currentTarget.blur();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    setExpanded(isOpen ? null : key);
                  }
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <Badge variant={verdictBadgeVariant(verdict)}>
                      {verdict.replaceAll("_", " ")}
                    </Badge>
                    <span className="text-xs text-[var(--text-muted)]">
                      {record.evaluationMode}
                    </span>
                  </div>
                  <RichText
                    html={record.citingPaperTitle}
                    as="p"
                    className="mt-2 text-sm font-semibold text-[var(--text)]"
                  />
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform",
                    isOpen && "rotate-180",
                  )}
                />
              </div>

              {isOpen ? (
                <div className="space-y-4 border-t border-[var(--border)] p-4">
                  <div className="rounded-[20px] border border-[var(--border)] bg-white/70 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                      Rationale
                    </p>
                    <p className="mt-2 text-sm leading-7 text-[var(--text)]">
                      {record.rationale ?? "No rationale recorded."}
                    </p>
                  </div>

                  {record.citingSpan ? (
                    <div className="rounded-[20px] border border-[var(--border)] bg-white/70 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                        Citing context
                      </p>
                      <RichText
                        html={record.citingSpan}
                        as="p"
                        className="mt-2 text-sm leading-7 text-[var(--text)]"
                      />
                    </div>
                  ) : null}

                  {record.evidenceSpans.length > 0 ? (
                    <div className="space-y-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                        Evidence spans ({String(record.evidenceSpans.length)})
                      </p>
                      {record.evidenceSpans.map((span) => (
                        <div
                          className="rounded-[20px] border border-[var(--border)] bg-white/70 p-4"
                          key={span.spanId}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <Badge variant="neutral">{span.blockKind}</Badge>
                            <p className="text-xs text-[var(--text-muted)]">
                              {span.matchMethod}
                            </p>
                          </div>
                          <RichText
                            html={span.text}
                            as="p"
                            className="mt-2 text-sm leading-7 text-[var(--text)]"
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function StageInspector({ detail }: { detail: RunStageDetail }) {
  let content: ReactNode = null;

  switch (detail.stageKey) {
    case "discover":
      content = <DiscoverInspector payload={detail.inspectorPayload} />;
      break;
    case "screen":
      content = <ScreenInspector payload={detail.inspectorPayload} />;
      break;
    case "extract":
      content = <ExtractInspector payload={detail.inspectorPayload} />;
      break;
    case "classify":
      content = <ClassifyInspector payload={detail.inspectorPayload} />;
      break;
    case "evidence":
      content = <EvidenceInspector payload={detail.inspectorPayload} />;
      break;
    case "curate":
      content = <CurateInspector payload={detail.inspectorPayload} />;
      break;
    case "adjudicate":
      content = <AdjudicateInspector payload={detail.inspectorPayload} />;
      break;
  }

  return (
    <div className="space-y-4">
      {detail.errorMessage ? (
        <ErrorBanner>{detail.errorMessage}</ErrorBanner>
      ) : null}
      {content}
    </div>
  );
}
