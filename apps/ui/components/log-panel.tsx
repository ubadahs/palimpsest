"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { StageKey } from "palimpsest/ui-contract";

import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, fetchJson } from "@/lib/utils";

export function LogPanel({
  runId,
  stageKey,
  stageTitle,
  active,
  defaultCollapsed = false,
}: {
  runId: string;
  stageKey: StageKey | undefined;
  /** Human-readable stage name for the log header. */
  stageTitle?: string;
  active: boolean;
  defaultCollapsed?: boolean;
}) {
  const [content, setContent] = useState("");
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  useEffect(() => {
    if (!stageKey || collapsed) {
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
  }, [active, collapsed, runId, stageKey]);

  return (
    <Card className="overflow-hidden">
      <button
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
        onClick={() => setCollapsed((v) => !v)}
        type="button"
      >
        <div>
          <p className="text-sm font-semibold text-[var(--text)]">
            {stageTitle ? `${stageTitle} log` : "Stage log"}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {active
              ? "Streaming while the run is active."
              : "Snapshot from the last log write."}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform",
            !collapsed && "rotate-180",
          )}
        />
      </button>
      {!collapsed ? (
        <CardContent className="pt-0">
          <ScrollArea className="h-[360px] rounded-[24px] border border-[var(--border)] bg-[#1f1b17] p-0">
            <pre className="min-h-full whitespace-pre-wrap p-5 text-xs leading-6 text-[#efe6da]">
              {content || "No log output yet."}
            </pre>
          </ScrollArea>
        </CardContent>
      ) : null}
    </Card>
  );
}
