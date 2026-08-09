"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AuditTrail } from "@/components/report/audit-trail";
import { FamiliesBrowser } from "@/components/report/families-browser";
import { FunnelOverview } from "@/components/report/funnel-overview";
import { RateCard } from "@/components/report/metrics";
import { RecordsBrowser } from "@/components/report/records-browser";
import { ReviewWorkspace } from "@/components/report/review-workspace";
import type { ReportPayload, ReportTab } from "@/components/report/types";
import { VerdictOverview } from "@/components/report/verdict-overview";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const REPORT_TABS: ReportTab[] = [
  "overview",
  "families",
  "records",
  "review",
  "audit",
];

function parseTab(value: string | null | undefined): ReportTab {
  if (value && REPORT_TABS.includes(value as ReportTab)) {
    return value as ReportTab;
  }
  return "overview";
}

function readDeepLink(defaultTab: ReportTab): {
  tab: ReportTab;
  familyId?: string;
  recordId?: string;
} {
  if (typeof window === "undefined") {
    return { tab: defaultTab };
  }
  const params = new URLSearchParams(window.location.search);
  const family = params.get("family");
  const record = params.get("record");
  return {
    tab: parseTab(params.get("tab") ?? defaultTab),
    ...(family ? { familyId: family } : {}),
    ...(record ? { recordId: record } : {}),
  };
}

export function ReportInspector({
  payload,
  runId,
  defaultTab = "overview",
}: {
  payload: ReportPayload;
  runId: string;
  defaultTab?: ReportTab;
}) {
  const { summary } = payload;
  const [tab, setTab] = useState<ReportTab>(defaultTab);
  const [familyId, setFamilyId] = useState<string | undefined>();
  const [recordId, setRecordId] = useState<string | undefined>();
  const [reviewDirty, setReviewDirty] = useState(false);

  useEffect(() => {
    const syncFromUrl = () => {
      const next = readDeepLink(defaultTab);
      setTab(next.tab);
      setFamilyId(next.familyId);
      setRecordId(next.recordId);
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [defaultTab]);

  const updateQuery = useCallback(
    (next: {
      tab?: ReportTab;
      family?: string | null;
      record?: string | null;
    }) => {
      const nextTab = next.tab ?? tab;
      const nextFamily =
        next.family !== undefined ? (next.family ?? undefined) : familyId;
      const nextRecord =
        next.record !== undefined ? (next.record ?? undefined) : recordId;
      const params = new URLSearchParams(window.location.search);
      params.set("tab", nextTab);
      if (nextFamily) {
        params.set("family", nextFamily);
      } else {
        params.delete("family");
      }
      if (nextRecord) {
        params.set("record", nextRecord);
      } else {
        params.delete("record");
      }
      const query = params.toString();
      const url = query
        ? `${window.location.pathname}?${query}`
        : window.location.pathname;
      window.history.replaceState(window.history.state, "", url);
      if (next.tab) setTab(next.tab);
      if (next.family !== undefined) setFamilyId(next.family ?? undefined);
      if (next.record !== undefined) setRecordId(next.record ?? undefined);
    },
    [familyId, recordId, tab],
  );

  const verdictRates = useMemo(
    () => summary.rates.filter((rate) => rate.metricId.startsWith("verdict_")),
    [summary.rates],
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

      <Tabs
        onValueChange={(value) => {
          const nextTab = parseTab(value);
          if (
            tab === "review" &&
            nextTab !== "review" &&
            reviewDirty &&
            !window.confirm("Discard unsaved review changes?")
          ) {
            return;
          }
          updateQuery({ tab: nextTab });
        }}
        value={tab}
      >
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="families">
              Families ({String(summary.families.length)})
            </TabsTrigger>
            <TabsTrigger value="records">
              Records ({String(summary.records.length)})
            </TabsTrigger>
            <TabsTrigger value="review">Review</TabsTrigger>
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

        <TabsContent value="families">
          <FamiliesBrowser
            families={summary.families}
            onSelect={(nextFamilyId, nextRecordId) =>
              updateQuery({
                tab: "families",
                family: nextFamilyId,
                record: nextRecordId ?? null,
              })
            }
            {...(familyId ? { selectedFamilyId: familyId } : {})}
            {...(recordId ? { selectedRecordId: recordId } : {})}
          />
        </TabsContent>

        <TabsContent value="records">
          <RecordsBrowser records={summary.records} />
        </TabsContent>

        <TabsContent value="review">
          <ReviewWorkspace
            onDirtyChange={setReviewDirty}
            onSelectRecord={(nextRecordId) => {
              const record = summary.records.find(
                (item) => item.recordId === nextRecordId,
              );
              updateQuery({
                tab: "review",
                family: record?.familyId ?? null,
                record: nextRecordId,
              });
            }}
            records={summary.records}
            reportArtifactId={payload.rawArtifact.artifactId}
            reportContentHash={payload.rawArtifact.contentHash}
            runId={runId}
            {...(recordId ? { selectedRecordId: recordId } : {})}
          />
        </TabsContent>

        <TabsContent value="audit">
          <AuditTrail payload={payload} runId={runId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
