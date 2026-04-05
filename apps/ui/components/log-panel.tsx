"use client";

import { useEffect, useState } from "react";
import type { StageKey } from "citation-fidelity/ui-contract";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchJson } from "@/lib/utils";

export function LogPanel({
  runId,
  stageKey,
  stageTitle,
  active,
}: {
  runId: string;
  stageKey: StageKey | undefined;
  /** Human-readable stage name for the log header. */
  stageTitle?: string;
  active: boolean;
}) {
  const [content, setContent] = useState("");

  useEffect(() => {
    if (!stageKey) {
      setContent("");
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      const next = await fetchJson<{ content: string }>(
        `/api/runs/${runId}/stages/${stageKey}/log`,
      );
      if (!cancelled) {
        setContent(next.content);
      }
    }

    void load();
    if (!active) {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => {
      void load();
    }, 2_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [active, runId, stageKey]);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          Stage log
        </p>
        <h3 className="mt-2 font-[var(--font-instrument)] text-2xl tracking-[-0.03em]">
          {stageTitle ? `${stageTitle} output` : "Stage output"}
        </h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          {active
            ? "Streaming while the run is active."
            : "Snapshot from the last log write for this stage."}
        </p>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[360px] rounded-[24px] border border-[var(--border)] bg-[#1f1b17] p-0">
          <pre className="min-h-full whitespace-pre-wrap p-5 text-xs leading-6 text-[#efe6da]">
            {content || "No log output yet."}
          </pre>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
