"use client";

import type { StageWorkflowSnapshot } from "palimpsest/ui-contract";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronsRight,
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

type StepStatus = StageWorkflowSnapshot["steps"][number]["status"];

function stepIcon(status: StepStatus, warning?: boolean) {
  if (status === "completed") {
    if (warning) {
      return <AlertTriangle className="h-4 w-4 text-[var(--warning)]" />;
    }
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
  if (status === "skipped") {
    return (
      <ChevronsRight className="h-4 w-4 text-[var(--text-muted)] opacity-50" />
    );
  }

  return <Dot className="h-4 w-4 text-[var(--text-muted)]" />;
}

function stepCardClasses(status: StepStatus, warning?: boolean): string {
  if (status === "running") {
    return "border-[rgba(155,92,65,0.28)] bg-[rgba(155,92,65,0.08)]";
  }
  if (status === "completed" && warning) {
    return "border-[rgba(151,100,44,0.25)] bg-[rgba(151,100,44,0.07)]";
  }
  if (status === "completed") {
    return "border-[rgba(47,111,79,0.18)] bg-[rgba(47,111,79,0.05)]";
  }
  if (status === "failed") {
    return "border-[rgba(154,64,54,0.2)] bg-[rgba(154,64,54,0.06)]";
  }
  if (status === "skipped") {
    return "border-[var(--border)] bg-white/30 opacity-60";
  }
  return "border-[var(--border)] bg-white/60";
}

/** Detects whether the ground_tracked_claim step completed but triggered a deprioritize.
 *  Signal: step with id "ground_tracked_claim" is completed AND at least one later step is skipped. */
function isGroundingWarning(
  steps: StageWorkflowSnapshot["steps"],
  stepIndex: number,
): boolean {
  const step = steps[stepIndex];
  if (
    !step ||
    step.status !== "completed" ||
    step.id !== "ground_tracked_claim"
  ) {
    return false;
  }
  return steps.slice(stepIndex + 1).some((s) => s.status === "skipped");
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
  const hasSkipped = workflow.steps.some((s) => s.status === "skipped");
  const displaySummary =
    hasSkipped && progressVariant === "archive"
      ? (workflow.steps.find((s) => s.id === "ground_tracked_claim")?.detail ??
        workflow.summary)
      : workflow.summary;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-[var(--text)]">{title}</p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {displaySummary}
            </p>
          </div>
          {workflow.counts ? (
            <span className="shrink-0 text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {workflow.counts.current}/{workflow.counts.total}{" "}
              {workflow.counts.label}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {workflow.steps.map((step, index) => {
          const warning = isGroundingWarning(workflow.steps, index);
          return (
            <div
              className={cn(
                "rounded-[24px] border px-4 py-4 transition",
                stepCardClasses(step.status, warning),
              )}
              key={step.id}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">
                  {stepIcon(step.status, warning)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        Step {String(index + 1).padStart(2, "0")}
                      </p>
                      <p
                        className={cn(
                          "mt-1 text-sm font-semibold",
                          step.status === "skipped"
                            ? "text-[var(--text-muted)]"
                            : "text-[var(--text)]",
                        )}
                      >
                        {step.label}
                      </p>
                    </div>
                    {step.status !== "skipped" ? (
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
                    ) : null}
                  </div>
                  {step.detail &&
                  (step.status === "running" ||
                    step.status === "failed" ||
                    warning) ? (
                    <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                      {step.detail}
                    </p>
                  ) : null}
                  {step.status === "skipped" && step.detail ? (
                    <p className="mt-1 text-xs text-[var(--text-muted)] opacity-70">
                      {step.detail}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
