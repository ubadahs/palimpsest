"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  MutationFamilyView,
  ReportInspectorRecordRow,
} from "palimpsest/contract";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { humanizeCode, recordOutcomeLabel, shortId } from "@/lib/report-format";
import { DoiLink } from "@/lib/rich-text";
import { cn } from "@/lib/utils";
import { VERDICT_ORDER, VERDICT_TEXT_COLORS } from "@/lib/verdict-tokens";

import { EvidencePassages, outcomeBadgeVariant } from "./record-details";
import { matchesRecordFilter } from "./record-filters";
import type { RecordFilter } from "./types";

function FamilyVerdictChips({ family }: { family: MutationFamilyView }) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {VERDICT_ORDER.map((verdict) => {
        const count = family.verdictCounts[verdict];
        if (count === 0) return null;
        return (
          <span
            className={cn(
              "font-semibold tabular-nums",
              VERDICT_TEXT_COLORS[verdict],
            )}
            key={verdict}
          >
            {verdict} {count}
          </span>
        );
      })}
      {family.verdictCounts.not_adjudicated > 0 ? (
        <span className="text-[var(--text-muted)]">
          gated {family.verdictCounts.not_adjudicated}
        </span>
      ) : null}
      {family.verdictCounts.failed > 0 ? (
        <span className="text-[var(--danger)]">
          failed {family.verdictCounts.failed}
        </span>
      ) : null}
    </div>
  );
}

function MutationRecordCard({
  record,
  selected,
  onSelect,
}: {
  record: ReportInspectorRecordRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <details
      className={cn(
        "group rounded-[22px] border bg-white/60 open:bg-white/80",
        selected
          ? "border-[var(--border-strong)] ring-1 ring-[rgba(151,100,44,0.25)]"
          : "border-[var(--border)]",
      )}
      id={`mutation-record-${record.recordId}`}
    >
      <summary
        className="cursor-pointer list-none px-4 py-4 [&::-webkit-details-marker]:hidden"
        onClick={onSelect}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={outcomeBadgeVariant(record)}>
                {recordOutcomeLabel(record)}
              </Badge>
              {record.citingPaperYear != null ? (
                <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  {record.citingPaperYear}
                </span>
              ) : null}
            </div>
            <p className="text-sm font-semibold leading-6 text-[var(--text)]">
              {record.evaluatedClaimText}
            </p>
            <p className="text-sm text-[var(--text-muted)]">
              {record.citingPaperTitle}
              {record.seedRefLabel ? ` · ${record.seedRefLabel}` : ""}
            </p>
          </div>
          <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
            {selected ? "Selected" : "Open"}
          </span>
        </div>
      </summary>
      <div className="space-y-4 border-t border-[var(--border)] px-4 py-4">
        {record.citingPaperDoi ? (
          <DoiLink
            className="text-sm text-[var(--accent)] hover:underline"
            doi={record.citingPaperDoi}
          />
        ) : null}
        <blockquote className="rounded-[18px] border border-[var(--border)] bg-[var(--panel-muted)] px-4 py-3 text-sm leading-7 text-[var(--text)]">
          {record.citationContext}
        </blockquote>
        <EvidencePassages record={record} />
        {record.rationale ||
        record.citingAssertion ||
        record.operationalReason ? (
          <div className="space-y-2 text-sm leading-7 text-[var(--text)]">
            {record.citingAssertion ? (
              <p>
                <span className="font-semibold">Citing:</span>{" "}
                {record.citingAssertion}
              </p>
            ) : null}
            {record.sourceStatement ? (
              <p>
                <span className="font-semibold">Seed:</span>{" "}
                {record.sourceStatement}
              </p>
            ) : null}
            {record.mutationKinds && record.mutationKinds.length > 0 ? (
              <p className="text-[var(--text-muted)]">
                {record.direction}:{" "}
                {record.mutationKinds
                  .map((kind) => kind.replace(/_/g, " "))
                  .join(", ")}
              </p>
            ) : null}
            {record.rationale ? <p>{record.rationale}</p> : null}
            {record.operationalReason ? (
              <p className="text-[var(--text-muted)]">
                {record.operationalReason}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function FamiliesBrowser({
  families,
  selectedFamilyId,
  selectedRecordId,
  onSelect,
}: {
  families: MutationFamilyView[];
  selectedFamilyId?: string;
  selectedRecordId?: string;
  onSelect: (familyId: string, recordId?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RecordFilter>("all");

  const activeFamilyId =
    selectedFamilyId &&
    families.some((family) => family.familyId === selectedFamilyId)
      ? selectedFamilyId
      : families[0]?.familyId;

  const activeFamily =
    families.find((family) => family.familyId === activeFamilyId) ??
    families[0];

  const filteredRecords = useMemo(() => {
    if (!activeFamily) return [];
    const needle = query.trim().toLowerCase();
    return activeFamily.records.filter((record) => {
      if (!matchesRecordFilter(record, filter)) return false;
      if (!needle) return true;
      const haystack = [
        record.evaluatedClaimText,
        record.citingPaperTitle,
        record.citationContext,
        record.rationale ?? "",
        record.verdict ?? "",
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [activeFamily, filter, query]);

  useEffect(() => {
    if (!selectedRecordId) return;
    const node = document.getElementById(
      `mutation-record-${selectedRecordId}`,
    ) as HTMLDetailsElement | null;
    if (node) {
      node.open = true;
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedRecordId, activeFamilyId]);

  if (!activeFamily) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-[var(--text-muted)]">
          No families available in this report.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
      <div className="space-y-3 xl:sticky xl:top-4 xl:self-start">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          Families ({String(families.length)})
        </p>
        <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
          {families.map((family) => {
            const selected = family.familyId === activeFamily.familyId;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "w-full rounded-[22px] border px-4 py-3 text-left transition",
                  selected
                    ? "border-[var(--border-strong)] bg-white shadow-sm"
                    : "border-[var(--border)] bg-white/50 hover:bg-white/80",
                )}
                key={family.familyId}
                onClick={() => onSelect(family.familyId)}
                type="button"
              >
                <p className="text-sm font-semibold leading-6 text-[var(--text)]">
                  {family.trackedClaim}
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {family.recordCount} records · {shortId(family.familyId)}
                </p>
                <div className="mt-2">
                  <FamilyVerdictChips family={family} />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-4">
        <Card className="overflow-hidden xl:sticky xl:top-4 xl:z-10">
          <CardHeader className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              Seed claim family
            </p>
            <h3 className="font-[var(--font-instrument)] text-2xl tracking-[-0.03em] text-[var(--text)]">
              {activeFamily.trackedClaim}
            </h3>
            <div className="space-y-1 text-sm text-[var(--text-muted)]">
              <p>{activeFamily.seedTitle}</p>
              {activeFamily.seedDoi ? (
                <DoiLink
                  className="text-[var(--accent)] hover:underline"
                  doi={activeFamily.seedDoi}
                />
              ) : null}
              {activeFamily.groundingStatus ? (
                <p>Grounding: {humanizeCode(activeFamily.groundingStatus)}</p>
              ) : null}
            </div>
            <FamilyVerdictChips family={activeFamily} />
          </CardHeader>
          <CardContent className="space-y-3">
            {activeFamily.verifiedSeedGroundingSpans.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                No verified seed grounding spans for this family.
              </p>
            ) : (
              activeFamily.verifiedSeedGroundingSpans.map((span, index) => (
                <blockquote
                  className="rounded-[18px] border border-[var(--border)] bg-[var(--panel-muted)] px-4 py-3 text-sm leading-7 text-[var(--text)]"
                  key={`${span.blockId}-${String(index)}`}
                >
                  {span.text}
                  {span.sectionTitle ? (
                    <span className="mt-2 block text-xs text-[var(--text-muted)]">
                      {span.sectionTitle}
                    </span>
                  ) : null}
                </blockquote>
              ))
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Input
            aria-label="Search family restatements"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search citing restatements…"
            value={query}
          />
          <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
            {(
              [
                "all",
                ...VERDICT_ORDER,
                "not_adjudicated",
                "failed",
              ] as RecordFilter[]
            ).map((id) => (
              <button
                aria-pressed={filter === id}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                  filter === id
                    ? "border-[var(--border-strong)] bg-[var(--text)] text-white"
                    : "border-[var(--border)] bg-white/60 text-[var(--text-muted)] hover:bg-white/80",
                )}
                key={id}
                onClick={() => setFilter(id)}
                type="button"
              >
                {id === "not_adjudicated" ? "Gated" : id === "all" ? "All" : id}
              </button>
            ))}
          </div>
        </div>

        <p className="text-sm text-[var(--text-muted)]">
          Chronological citing restatements · showing{" "}
          {String(filteredRecords.length)} of{" "}
          {String(activeFamily.records.length)}
        </p>

        <div className="space-y-3">
          {filteredRecords.map((record) => (
            <MutationRecordCard
              key={record.recordId}
              onSelect={() => onSelect(activeFamily.familyId, record.recordId)}
              record={record}
              selected={selectedRecordId === record.recordId}
            />
          ))}
          {filteredRecords.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-sm text-[var(--text-muted)]">
                No restatements match this filter.
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
