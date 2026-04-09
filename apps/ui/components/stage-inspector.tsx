"use client";

import { useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import type { RunStageDetail } from "palimpsest/ui-contract";

import { ChevronDown } from "lucide-react";

import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DoiLink, RichText } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

type GenericRecord = Record<string, unknown>;

function LegacyDiscoverInspector({ payload }: { payload: GenericRecord }) {
  const papers = (payload["papers"] as GenericRecord[] | undefined) ?? [];
  const rows = papers.flatMap((paper) =>
    ((paper["claims"] as GenericRecord[] | undefined) ?? []).map((claim) => ({
      rank: claim["rank"] != null ? String(claim["rank"]) : "—",
      claimText: String(claim["claimText"] ?? ""),
      section: String(claim["section"] ?? ""),
      claimType: String(claim["claimType"] ?? ""),
      confidence: String(claim["confidence"] ?? ""),
      directCount: String(claim["directCount"] ?? 0),
      indirectCount: String(claim["indirectCount"] ?? 0),
    })),
  );
  const column = createColumnHelper<GenericRecord>();

  return (
    <DataTable
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

function AttributionDiscoverInspector({ payload }: { payload: GenericRecord }) {
  const results = (payload["results"] as GenericRecord[] | undefined) ?? [];

  const rows = results.flatMap((result) =>
    ((result["shortlistEntries"] as GenericRecord[] | undefined) ?? []).map(
      (entry) => ({
        doi: String(result["doi"] ?? ""),
        trackedClaim: String(entry["trackedClaim"] ?? ""),
        grounding: String(entry["seedGroundingStatus"] ?? "—"),
        mentions: String(entry["supportingMentionCount"] ?? 0),
        papers: String(entry["supportingPaperCount"] ?? 0),
      }),
    ),
  );

  const column = createColumnHelper<GenericRecord>();

  return (
    <DataTable
      columns={[
        column.accessor("doi", {
          header: "DOI",
          cell: (info) => (
            <DoiLink doi={String(info.getValue())} />
          ),
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

function DiscoverInspector({ payload }: { payload: GenericRecord }) {
  if (payload["strategy"] === "attribution_first") {
    return <AttributionDiscoverInspector payload={payload} />;
  }
  return <LegacyDiscoverInspector payload={payload} />;
}

function ScreenInspector({ payload }: { payload: GenericRecord }) {
  const families = (payload["families"] as GenericRecord[] | undefined) ?? [];
  const edgeRows = families.flatMap(
    (family) =>
      ((family["edges"] as GenericRecord[] | undefined) ?? []).map((edge) => ({
        seedDoi: String(family["seedDoi"] ?? ""),
        trackedClaim: String(family["trackedClaim"] ?? ""),
        decision: String(family["decision"] ?? ""),
        auditabilityStatus: String(edge["auditabilityStatus"] ?? ""),
        auditabilityReason: String(edge["auditabilityReason"] ?? ""),
        paperType: String(edge["paperType"] ?? "—"),
        citingPaperId: String(edge["citingPaperId"] ?? ""),
      })) as GenericRecord[],
  );
  const column = createColumnHelper<GenericRecord>();

  return (
    <DataTable
      columns={[
        column.accessor("seedDoi", {
          header: "Seed DOI",
          cell: (info) => (
            <DoiLink doi={String(info.getValue())} />
          ),
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

function ExtractInspector({ payload }: { payload: GenericRecord }) {
  const rows = (
    (payload["edgeResults"] as GenericRecord[] | undefined) ?? []
  ).map((edge) => ({
    citingPaperTitle: String(edge["citingPaperTitle"] ?? ""),
    extractionOutcome: String(edge["extractionOutcome"] ?? ""),
    usableForGrounding: String(edge["usableForGrounding"] ?? ""),
    mentionCount: String(edge["mentionCount"] ?? ""),
    failureReason: String(edge["failureReason"] ?? "—"),
  }));
  const column = createColumnHelper<GenericRecord>();

  return (
    <DataTable
      columns={[
        column.accessor("citingPaperTitle", {
          header: "Citing paper",
          cell: (info) => (
            <RichText html={String(info.getValue())} />
          ),
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

function ClassifyInspector({ payload }: { payload: GenericRecord }) {
  const rows = (
    (payload["packets"] as GenericRecord[] | undefined) ?? []
  ).flatMap(
    (packet) =>
      ((packet["tasks"] as GenericRecord[] | undefined) ?? []).map((task) => ({
        citingPaperTitle: String(packet["citingPaperTitle"] ?? ""),
        citingPaperDoi: String(packet["citingPaperDoi"] ?? ""),
        evaluationMode: String(task["evaluationMode"] ?? ""),
        citationRole: String(task["citationRole"] ?? ""),
        mentionCount: String(task["mentionCount"] ?? ""),
        bundled: String(task["bundled"] ?? false),
        reviewMediated: String(task["reviewMediated"] ?? false),
      })) as GenericRecord[],
  );
  const column = createColumnHelper<GenericRecord>();

  return (
    <DataTable
      columns={[
        column.accessor("citingPaperTitle", {
          header: "Citing paper",
          cell: (info) => {
            const row = info.row.original;
            const doi = String(row["citingPaperDoi"] ?? "");
            const title = String(info.getValue());
            return doi ? (
              <DoiLink doi={doi} className="text-[var(--text)] hover:text-[var(--accent)] hover:underline">
                <RichText html={title} />
              </DoiLink>
            ) : (
              <RichText html={title} />
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

function EvidenceInspector({ payload }: { payload: GenericRecord }) {
  const edges = (payload["edges"] as GenericRecord[] | undefined) ?? [];
  const seed = payload["seed"] as GenericRecord | undefined;
  const summary = payload["summary"] as GenericRecord | undefined;
  const tasks = edges.flatMap(
    (edge) =>
      ((edge["tasks"] as GenericRecord[] | undefined) ?? []).map((task) => ({
        citingPaperTitle: String(edge["citingPaperTitle"] ?? ""),
        citedPaperTitle: String(edge["citedPaperTitle"] ?? ""),
        task,
      })) as Array<{
        citingPaperTitle: string;
        citedPaperTitle: string;
        task: GenericRecord;
      }>,
  );
  const [selected, setSelected] = useState(tasks[0] ?? null);

  return (
    <div className="space-y-6">
      {seed ? (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            {seed["doi"] ? (
              <div>
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Cited paper
                </span>{" "}
                <DoiLink doi={String(seed["doi"])} />
              </div>
            ) : null}
            {seed["trackedClaim"] ? (
              <div className="basis-full">
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Tracked claim
                </span>
                <RichText
                  html={String(seed["trackedClaim"])}
                  as="p"
                  className="mt-1 text-sm leading-6 text-[var(--text)]"
                />
              </div>
            ) : null}
            {summary ? (
              <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-sm text-[var(--text-muted)]">
                <span>
                  <strong className="text-[var(--text)]">
                    {String(summary["totalTasks"] ?? 0)}
                  </strong>{" "}
                  tasks
                </span>
                <span>
                  <strong className="text-[var(--text)]">
                    {String(summary["tasksWithEvidence"] ?? 0)}
                  </strong>{" "}
                  with evidence
                </span>
                <span>
                  <strong className="text-[var(--text)]">
                    {String(summary["totalEvidenceSpans"] ?? 0)}
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
            const mentions =
              (entry.task["citingMentions"] as GenericRecord[] | undefined) ??
              [];
            const active = selected?.task === entry.task;
            return (
              <button
                className={`w-full select-text rounded-[24px] border p-4 text-left transition ${
                  active
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : "border-[var(--border)] bg-white/60 hover:border-[var(--border-strong)]"
                }`}
                key={String(entry.task["taskId"] ?? Math.random())}
                onClick={() => setSelected(entry)}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-[var(--text)]">
                    {String(entry.task["evaluationMode"] ?? "")}
                  </p>
                  <Badge variant="neutral">
                    {String(entry.task["evidenceRetrievalStatus"] ?? "")}
                  </Badge>
                </div>
                <RichText
                  html={entry.citingPaperTitle}
                  as="p"
                  className="mt-3 text-sm text-[var(--text-muted)]"
                />
                <p className="mt-3 text-sm leading-6 text-[var(--text)]">
                  {String(
                    mentions[0]?.["rawContext"] ??
                      "No citing context available.",
                  )}
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
                  {String(selected.task["rubricQuestion"] ?? "")}
                </p>
              </div>
              {(
                (selected.task["evidenceSpans"] as
                  | GenericRecord[]
                  | undefined) ?? []
              ).length > 0 ? (
                (
                  (selected.task["evidenceSpans"] as
                    | GenericRecord[]
                    | undefined) ?? []
                ).map((span) => (
                  <div
                    className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4"
                    key={String(span["spanId"] ?? Math.random())}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="neutral">
                        {String(span["blockKind"] ?? "block")}
                      </Badge>
                      <Badge variant="neutral">
                        {String(span["matchMethod"] ?? "")}
                      </Badge>
                      {span["relevanceScore"] != null ? (
                        <span className="text-xs font-semibold text-[var(--accent)]">
                          relevance {Number(span["relevanceScore"]).toFixed(2)}
                        </span>
                      ) : null}
                      <span className="ml-auto text-xs text-[var(--text-muted)]">
                        bm25 {Number(span["bm25Score"] ?? 0).toFixed(2)}
                        {span["rerankScore"] != null
                          ? ` · rerank ${Number(span["rerankScore"]).toFixed(2)}`
                          : ""}
                      </span>
                    </div>
                    <RichText
                      html={String(span["text"] ?? "")}
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

function CurateInspector({ payload }: { payload: GenericRecord }) {
  const rows = ((payload["records"] as GenericRecord[] | undefined) ?? []).map(
    (record) => ({
      evaluationMode: String(record["evaluationMode"] ?? ""),
      citationRole: String(record["citationRole"] ?? ""),
      citingPaperTitle: String(record["citingPaperTitle"] ?? ""),
      excluded: String(record["excluded"] ?? false),
      excludeReason: String(record["excludeReason"] ?? "—"),
      evidenceCount: String(record["evidenceCount"] ?? 0),
    }),
  );
  const column = createColumnHelper<GenericRecord>();

  return (
    <DataTable
      columns={[
        column.accessor("evaluationMode", { header: "Mode" }),
        column.accessor("citationRole", { header: "Role" }),
        column.accessor("citingPaperTitle", {
          header: "Citing paper",
          cell: (info) => (
            <RichText html={String(info.getValue())} />
          ),
        }),
        column.accessor("excluded", { header: "Excluded" }),
        column.accessor("excludeReason", { header: "Exclusion reason" }),
        column.accessor("evidenceCount", { header: "Evidence" }),
      ]}
      data={rows}
      searchPlaceholder="Filter calibration records"
    />
  );
}

const VERDICT_OPTIONS = [
  "supported",
  "partially_supported",
  "overstated_or_generalized",
  "not_supported",
  "cannot_determine",
] as const;

function verdictBadgeVariant(
  verdict: string,
): "success" | "warning" | "failed" | "neutral" {
  if (verdict === "supported") return "success";
  if (verdict === "partially_supported") return "warning";
  if (verdict === "not_supported" || verdict === "overstated_or_generalized")
    return "failed";
  return "neutral";
}

function AdjudicateInspector({ payload }: { payload: GenericRecord }) {
  const records = (payload["records"] as GenericRecord[] | undefined) ?? [];
  const seed = payload["seed"] as GenericRecord | undefined;
  const telemetry = payload["runTelemetry"] as GenericRecord | undefined;
  const defaultFilter = String(
    payload["defaultVerdictFilter"] ?? "partially_supported",
  );
  const [filter, setFilter] = useState(defaultFilter);
  const [expanded, setExpanded] = useState<string | null>(null);
  const filtered = useMemo(
    () =>
      records.filter((record) => String(record["verdict"] ?? "") === filter),
    [filter, records],
  );
  const countByVerdict = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const record of records) {
      const v = String(record["verdict"] ?? "");
      counts[v] = (counts[v] ?? 0) + 1;
    }
    return counts;
  }, [records]);

  const activeRecords = records.filter((r) => !r["excluded"]);
  const avgConfidence = useMemo(() => {
    const confidences = activeRecords
      .map((r) => r["judgeConfidence"])
      .filter((c): c is string => typeof c === "string");
    const levels: Record<string, number> = {
      high: 3,
      medium: 2,
      low: 1,
    };
    if (confidences.length === 0) return undefined;
    const sum = confidences.reduce(
      (acc, c) => acc + (levels[c] ?? 0),
      0,
    );
    const avg = sum / confidences.length;
    if (avg >= 2.5) return "High";
    if (avg >= 1.5) return "Medium";
    return "Low";
  }, [activeRecords]);

  return (
    <div className="space-y-5">
      {seed ? (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            {seed["doi"] ? (
              <div>
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Seed paper
                </span>{" "}
                <DoiLink doi={String(seed["doi"])} />
              </div>
            ) : null}
            {seed["trackedClaim"] ? (
              <div className="basis-full">
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Tracked claim
                </span>
                <RichText
                  html={String(seed["trackedClaim"])}
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
              {avgConfidence ? (
                <span>
                  Avg confidence:{" "}
                  <strong className="text-[var(--text)]">
                    {avgConfidence}
                  </strong>
                </span>
              ) : null}
              {telemetry &&
              typeof telemetry["estimatedCostUsd"] === "number" ? (
                <span>
                  LLM cost:{" "}
                  <strong className="text-[var(--text)]">
                    ${(telemetry["estimatedCostUsd"] as number).toFixed(2)}
                  </strong>
                </span>
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
              {option.replaceAll("_", " ")}
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
          const key = String(record["taskId"] ?? index);
          const isOpen = expanded === key;
          const verdict = String(record["verdict"] ?? "");
          const spans =
            (record["evidenceSpans"] as GenericRecord[] | undefined) ?? [];

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
                      {String(record["evaluationMode"] ?? "")}
                    </span>
                  </div>
                  <RichText
                    html={String(record["citingPaperTitle"] ?? "")}
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
                      {String(record["rationale"] ?? "No rationale recorded.")}
                    </p>
                  </div>

                  {record["citingSpan"] ? (
                    <div className="rounded-[20px] border border-[var(--border)] bg-white/70 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                        Citing context
                      </p>
                      <RichText
                        html={String(record["citingSpan"])}
                        as="p"
                        className="mt-2 text-sm leading-7 text-[var(--text)]"
                      />
                    </div>
                  ) : null}

                  {spans.length > 0 ? (
                    <div className="space-y-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                        Evidence spans ({String(spans.length)})
                      </p>
                      {spans.map((span) => (
                        <div
                          className="rounded-[20px] border border-[var(--border)] bg-white/70 p-4"
                          key={String(span["spanId"] ?? Math.random())}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <Badge variant="neutral">
                              {String(span["blockKind"] ?? "")}
                            </Badge>
                            <p className="text-xs text-[var(--text-muted)]">
                              {String(span["matchMethod"] ?? "")}
                            </p>
                          </div>
                          <RichText
                            html={String(span["text"] ?? "")}
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
  const payload = (detail.inspectorPayload as GenericRecord | undefined) ?? {};

  return (
    <div className="space-y-4">
      {detail.errorMessage ? (
        <div className="rounded-[24px] border border-[rgba(154,64,54,0.2)] bg-[rgba(154,64,54,0.06)] px-5 py-4 text-sm text-[var(--danger)]">
          {detail.errorMessage}
        </div>
      ) : null}
      {detail.stageKey === "discover" ? (
        <DiscoverInspector payload={payload} />
      ) : null}
      {detail.stageKey === "screen" ? (
        <ScreenInspector payload={payload} />
      ) : null}
      {detail.stageKey === "extract" ? (
        <ExtractInspector payload={payload} />
      ) : null}
      {detail.stageKey === "classify" ? (
        <ClassifyInspector payload={payload} />
      ) : null}
      {detail.stageKey === "evidence" ? (
        <EvidenceInspector payload={payload} />
      ) : null}
      {detail.stageKey === "curate" ? (
        <CurateInspector payload={payload} />
      ) : null}
      {detail.stageKey === "adjudicate" ? (
        <AdjudicateInspector payload={payload} />
      ) : null}
    </div>
  );
}
