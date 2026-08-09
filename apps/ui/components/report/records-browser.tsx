"use client";

import { useMemo, useState } from "react";
import type { ReportInspectorRecordRow } from "palimpsest/contract";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { VERDICT_ORDER } from "@/lib/verdict-tokens";

import { matchesRecordFilter } from "./record-filters";
import { RecordCard } from "./record-details";
import type { RecordFilter } from "./types";

export function RecordsBrowser({
  records,
}: {
  records: ReportInspectorRecordRow[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RecordFilter>("all");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((record) => {
      if (!matchesRecordFilter(record, filter)) return false;
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
              aria-pressed={filter === item.id}
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
