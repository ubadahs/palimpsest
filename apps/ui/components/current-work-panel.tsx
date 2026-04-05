"use client";

import type { StageWorkflowSnapshot } from "citation-fidelity/ui-contract";
import {
  AlertCircle,
  CheckCircle2,
  Dot,
  Info,
  LoaderCircle,
} from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function stepIcon(status: StageWorkflowSnapshot["steps"][number]["status"]) {
  if (status === "completed") {
    return <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />;
  }
  if (status === "failed") {
    return <AlertCircle className="h-4 w-4 text-[var(--danger)]" />;
  }
  if (status === "running") {
    return (
      <LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent)]" />
    );
  }

  return <Dot className="h-4 w-4 text-[var(--text-muted)]" />;
}

function sourceLabel(
  source: StageWorkflowSnapshot["source"],
  variant: "live" | "archive",
): string {
  if (source === "telemetry") {
    return variant === "live"
      ? "Live progress from stage telemetry"
      : "Saved telemetry from this stage";
  }
  return variant === "live"
    ? "Workflow inferred from stage status"
    : "Workflow inferred from saved stage status";
}

export function CurrentWorkPanel({
  workflow,
  title = "Current work",
  progressVariant = "live",
}: {
  workflow: StageWorkflowSnapshot;
  title?: string;
  /** `live` while a stage is running; `archive` for completed or idle recap. */
  progressVariant?: "live" | "archive";
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
              {title}
            </p>
            <h3 className="mt-2 font-[var(--font-instrument)] text-2xl tracking-[-0.03em] text-[var(--text)]">
              {workflow.summary}
            </h3>
          </div>
          {workflow.counts ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                {workflow.counts.current}/{workflow.counts.total}{" "}
                {workflow.counts.label}
              </span>
            </div>
          ) : null}
        </div>
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">
          {sourceLabel(workflow.source, progressVariant)}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {workflow.steps.map((step, index) => (
          <div
            className={cn(
              "rounded-[24px] border px-4 py-4 transition",
              step.status === "running"
                ? "border-[rgba(155,92,65,0.28)] bg-[rgba(155,92,65,0.08)]"
                : step.status === "completed"
                  ? "border-[rgba(47,111,79,0.18)] bg-[rgba(47,111,79,0.05)]"
                  : step.status === "failed"
                    ? "border-[rgba(154,64,54,0.2)] bg-[rgba(154,64,54,0.06)]"
                    : "border-[var(--border)] bg-white/60",
            )}
            key={step.id}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0">{stepIcon(step.status)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                      Step {String(index + 1).padStart(2, "0")}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-[var(--text)]">
                      {step.label}
                    </p>
                  </div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        aria-label={`More about ${step.label}`}
                        className="h-8 w-8 shrink-0 rounded-full p-0"
                        size="sm"
                        variant="ghost"
                      >
                        <Info className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end">
                      <p>{step.description}</p>
                      {step.detail ? (
                        <p className="mt-3 border-t border-[var(--border)] pt-3 text-[13px] text-[var(--text-muted)]">
                          {step.detail}
                        </p>
                      ) : null}
                    </PopoverContent>
                  </Popover>
                </div>
                {step.detail &&
                (step.status === "running" || step.status === "failed") ? (
                  <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                    {step.detail}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
