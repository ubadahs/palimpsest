"use client";

import { useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import type { RunStageDetail } from "palimpsest/ui-contract";

import { ChevronDown } from "lucide-react";

import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type GenericRecord = Record<string, unknown>;

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
        column.accessor("seedDoi", { header: "Seed DOI" }),
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
        column.accessor("citingPaperTitle", { header: "Citing paper" }),
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
        column.accessor("citingPaperTitle", { header: "Citing paper" }),
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
                className={`w-full rounded-[24px] border p-4 text-left transition ${
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
                <p className="mt-3 text-sm text-[var(--text-muted)]">
                  {entry.citingPaperTitle}
                </p>
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
                    <div className="flex items-center justify-between gap-3">
                      <Badge variant="neutral">
                        {String(span["blockKind"] ?? "block")}
                      </Badge>
                      <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        {String(span["matchMethod"] ?? "")} · bm25{" "}
                        {String(span["bm25Score"] ?? "")}
                        {span["rerankScore"] != null
                          ? ` · rerank ${String(span["rerankScore"])}`
                          : ""}
                      </p>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-[var(--text)]">
                      {String(span["text"] ?? "")}
                    </p>
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
        column.accessor("citingPaperTitle", { header: "Citing paper" }),
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

  return (
    <div className="space-y-5">
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
              <button
                className="flex w-full items-center gap-4 p-4 text-left transition hover:bg-white/80"
                onClick={() => setExpanded(isOpen ? null : key)}
                type="button"
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
                  <p className="mt-2 text-sm font-semibold text-[var(--text)]">
                    {String(record["citingPaperTitle"] ?? "")}
                  </p>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform",
                    isOpen && "rotate-180",
                  )}
                />
              </button>

              {isOpen ? (
                <div className="space-y-4 border-t border-[var(--border)] p-4">
                  <div className="rounded-[20px] border border-[var(--border)] bg-white/70 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                      Rationale
                    </p>
                    <p className="mt-2 text-sm leading-7 text-[var(--text)]">
                      {String(
                        record["rationale"] ?? "No rationale recorded.",
                      )}
                    </p>
                  </div>

                  {record["citingSpan"] ? (
                    <div className="rounded-[20px] border border-[var(--border)] bg-white/70 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                        Citing context
                      </p>
                      <p className="mt-2 text-sm leading-7 text-[var(--text)]">
                        {String(record["citingSpan"])}
                      </p>
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
                          <p className="mt-2 text-sm leading-7 text-[var(--text)]">
                            {String(span["text"] ?? "")}
                          </p>
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
