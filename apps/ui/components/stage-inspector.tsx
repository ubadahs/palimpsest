"use client";

import { useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import type { RunStageDetail } from "citation-fidelity/ui-contract";

import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type GenericRecord = Record<string, unknown>;

function PreScreenInspector({ payload }: { payload: GenericRecord }) {
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

function M2Inspector({ payload }: { payload: GenericRecord }) {
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

function M3Inspector({ payload }: { payload: GenericRecord }) {
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

function M4Inspector({ payload }: { payload: GenericRecord }) {
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

function M5Inspector({ payload }: { payload: GenericRecord }) {
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

function M6Inspector({ payload }: { payload: GenericRecord }) {
  const records = (payload["records"] as GenericRecord[] | undefined) ?? [];
  const defaultFilter = String(
    payload["defaultVerdictFilter"] ?? "partially_supported",
  );
  const [filter, setFilter] = useState(defaultFilter);
  const filtered = useMemo(
    () =>
      records.filter((record) => String(record["verdict"] ?? "") === filter),
    [filter, records],
  );
  const column = createColumnHelper<GenericRecord>();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {[
          "supported",
          "partially_supported",
          "overstated_or_generalized",
          "not_supported",
          "cannot_determine",
        ].map((option) => (
          <Button
            className="capitalize"
            key={option}
            onClick={() => setFilter(option)}
            type="button"
            variant={filter === option ? "default" : "secondary"}
          >
            {option.replaceAll("_", " ")}
          </Button>
        ))}
      </div>
      <DataTable
        columns={[
          column.accessor("evaluationMode", { header: "Mode" }),
          column.accessor("citationRole", { header: "Role" }),
          column.accessor("citingPaperTitle", { header: "Citing paper" }),
          column.accessor("verdict", { header: "Verdict" }),
          column.display({
            id: "detail",
            header: "Detail",
            cell: ({ row }) => (
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm" variant="secondary">
                    Open rationale
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <div className="space-y-6">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
                        Verdict detail
                      </p>
                      <DialogTitle asChild>
                        <h3 className="mt-2 font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
                          {String(row.original["verdict"] ?? "No verdict")}
                        </h3>
                      </DialogTitle>
                    </div>
                    <div className="rounded-[24px] border border-[var(--border)] bg-white/70 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        Rationale
                      </p>
                      <p className="mt-3 text-sm leading-7 text-[var(--text)]">
                        {String(
                          row.original["rationale"] ?? "No rationale recorded.",
                        )}
                      </p>
                    </div>
                    <div className="rounded-[24px] border border-[var(--border)] bg-white/70 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        Citing context
                      </p>
                      <p className="mt-3 text-sm leading-7 text-[var(--text)]">
                        {String(row.original["citingSpan"] ?? "")}
                      </p>
                    </div>
                    {(
                      (row.original["evidenceSpans"] as
                        | GenericRecord[]
                        | undefined) ?? []
                    ).map((span) => (
                      <div
                        className="rounded-[24px] border border-[var(--border)] bg-white/70 p-4"
                        key={String(span["spanId"] ?? Math.random())}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <Badge variant="neutral">
                            {String(span["blockKind"] ?? "")}
                          </Badge>
                          <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                            {String(span["matchMethod"] ?? "")}
                          </p>
                        </div>
                        <p className="mt-3 text-sm leading-7 text-[var(--text)]">
                          {String(span["text"] ?? "")}
                        </p>
                      </div>
                    ))}
                  </div>
                </DialogContent>
              </Dialog>
            ),
          }),
        ]}
        data={filtered}
        searchPlaceholder="Filter verdict rows"
      />
    </div>
  );
}

export function StageInspector({ detail }: { detail: RunStageDetail }) {
  const payload = (detail.inspectorPayload as GenericRecord | undefined) ?? {};

  return (
    <div className="space-y-6">
      <Tabs defaultValue="structured">
        <TabsList>
          <TabsTrigger value="structured">Structured</TabsTrigger>
          <TabsTrigger value="notes">Inspector</TabsTrigger>
        </TabsList>
        <TabsContent value="structured">
          {detail.stageKey === "pre-screen" ? (
            <PreScreenInspector payload={payload} />
          ) : null}
          {detail.stageKey === "m2-extract" ? (
            <M2Inspector payload={payload} />
          ) : null}
          {detail.stageKey === "m3-classify" ? (
            <M3Inspector payload={payload} />
          ) : null}
          {detail.stageKey === "m4-evidence" ? (
            <M4Inspector payload={payload} />
          ) : null}
          {detail.stageKey === "m5-adjudicate" ? (
            <M5Inspector payload={payload} />
          ) : null}
          {detail.stageKey === "m6-llm-judge" ? (
            <M6Inspector payload={payload} />
          ) : null}
        </TabsContent>
        <TabsContent value="notes">
          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  Status
                </p>
                <p className="mt-2 text-sm text-[var(--text)]">
                  {detail.status}
                </p>
              </div>
              {detail.errorMessage ? (
                <div className="rounded-[24px] border border-[rgba(154,64,54,0.2)] bg-[rgba(154,64,54,0.06)] p-4 text-sm text-[var(--danger)]">
                  {detail.errorMessage}
                </div>
              ) : (
                <div className="rounded-[24px] border border-[var(--border)] bg-white/60 p-4 text-sm text-[var(--text-muted)]">
                  The structured view is the primary surface for this stage. Raw
                  artifact tabs live below.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
