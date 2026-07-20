import { z } from "zod";

import { stageKeyValues } from "./stages.js";

const stageKeySchema = z.enum(stageKeyValues);
type StageKey = (typeof stageKeyValues)[number];
type StageStatusForWorkflow =
  | "not_started"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale"
  | "blocked"
  | "interrupted";

export const stageWorkflowStepStatusValues = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;
export const stageWorkflowStepStatusSchema = z.enum(
  stageWorkflowStepStatusValues,
);
export type StageWorkflowStepStatus = z.infer<
  typeof stageWorkflowStepStatusSchema
>;
export const stageWorkflowSourceValues = ["telemetry", "fallback"] as const;
export const stageWorkflowSourceSchema = z.enum(stageWorkflowSourceValues);
export type StageWorkflowSource = z.infer<typeof stageWorkflowSourceSchema>;
export const stageWorkflowCountSchema = z
  .object({
    current: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    label: z.string().min(1),
  })
  .passthrough();
export type StageWorkflowCount = z.infer<typeof stageWorkflowCountSchema>;
export const stageWorkflowStepSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    status: stageWorkflowStepStatusSchema,
    detail: z.string().optional(),
  })
  .passthrough();
export type StageWorkflowStep = z.infer<typeof stageWorkflowStepSchema>;
export const stageWorkflowSnapshotSchema = z
  .object({
    stageKey: stageKeySchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    source: stageWorkflowSourceSchema,
    counts: stageWorkflowCountSchema.optional(),
    steps: z.array(stageWorkflowStepSchema),
  })
  .passthrough();
export type StageWorkflowSnapshot = z.infer<typeof stageWorkflowSnapshotSchema>;
export const stageProgressEventSchema = z
  .object({
    stage: stageKeySchema,
    step: z.string().min(1),
    status: z.enum(["running", "completed", "failed", "skipped"]),
    detail: z.string().optional(),
    current: z.number().int().nonnegative().optional(),
    total: z.number().int().positive().optional(),
    summary: z.string().optional(),
  })
  .passthrough()
  .refine(
    (event) =>
      (event.current == null && event.total == null) ||
      (event.current != null && event.total != null),
    { message: "current and total must be provided together" },
  );
export type StageProgressEvent = z.infer<typeof stageProgressEventSchema>;
export const progressLogPrefix = "CF_PROGRESS ";

type WorkflowStepDefinition = {
  id: string;
  label: string;
  description: string;
};
type StageWorkflowDefinition = {
  stageKey: StageKey;
  title: string;
  pendingSummary: string;
  completedSummary: string;
  failedSummary: string;
  steps: readonly WorkflowStepDefinition[];
};

const workflowDefinitions = [
  {
    stageKey: "discover",
    title: "Discover",
    pendingSummary: "Discover has not started.",
    completedSummary: "Citing-neighborhood discovery is complete.",
    failedSummary: "Discover stopped before its ledger was finalized.",
    steps: [
      {
        id: "resolve_seeds",
        label: "Resolve seed metadata",
        description: "Resolve DOI seed identities.",
      },
      {
        id: "enumerate_neighborhood",
        label: "Enumerate citing neighborhood",
        description: "Record all declared citing-paper observations.",
      },
      {
        id: "harvest_occurrences",
        label: "Harvest citation occurrences",
        description: "Materialize and inspect selected citing papers.",
      },
      {
        id: "extract_claims",
        label: "Extract attributed claims",
        description: "Extract occurrence-local claims without grounding them.",
      },
      {
        id: "select_candidates",
        label: "Select scope candidates",
        description:
          "Record candidate dispositions without dropping the ledger.",
      },
    ],
  },
  {
    stageKey: "scope",
    title: "Scope",
    pendingSummary: "Scope has not started.",
    completedSummary: "Families and seed-grounding annotations are frozen.",
    failedSummary: "Scope stopped before family membership was finalized.",
    steps: [
      {
        id: "account_candidates",
        label: "Account for candidates",
        description: "Preserve a disposition for every Discover candidate.",
      },
      {
        id: "materialize_seed_text",
        label: "Materialize seed text",
        description: "Acquire and parse seed text once per seed.",
      },
      {
        id: "ground_families",
        label: "Annotate grounding",
        description:
          "Ground selected claims without using grounding as an exclusion.",
      },
      {
        id: "freeze_membership",
        label: "Freeze family membership",
        description:
          "Freeze source claims and citation occurrences for each family.",
      },
    ],
  },
  {
    stageKey: "prepare",
    title: "Prepare",
    pendingSummary: "Prepare has not started.",
    completedSummary:
      "Complete occurrence-local records are ready for evidence.",
    failedSummary: "Prepare stopped before records were finalized.",
    steps: [
      {
        id: "load_lineage",
        label: "Verify Scope and Discover",
        description: "Verify exact ancestor artifacts and lineage.",
      },
      {
        id: "build_records",
        label: "Build occurrence records",
        description:
          "Emit one record per scoped family and citation occurrence.",
      },
      {
        id: "classify_records",
        label: "Classify records",
        description:
          "Attach deterministic classification outcomes without dropping failures.",
      },
    ],
  },
  {
    stageKey: "evidence",
    title: "Evidence",
    pendingSummary: "Evidence retrieval has not started.",
    completedSummary:
      "Evidence outcomes are recorded for every Prepare record.",
    failedSummary: "Evidence retrieval stopped before outcomes were finalized.",
    steps: [
      {
        id: "verify_lineage",
        label: "Verify Prepare and Scope",
        description: "Verify exact input artifacts before retrieval.",
      },
      {
        id: "chunk_seed_text",
        label: "Build seed-text corpus",
        description:
          "Create deterministic fixed-window chunks from Scope text.",
      },
      {
        id: "run_bm25",
        label: "Retrieve BM25 evidence",
        description:
          "Retrieve from occurrence-local claims with the scoped family claim as fallback.",
      },
      {
        id: "rerank_if_enabled",
        label: "Rerank evidence if enabled",
        description: "Record a separate relevance-only reranking outcome.",
      },
    ],
  },
  {
    stageKey: "adjudicate",
    title: "Adjudicate",
    pendingSummary: "Adjudication has not started.",
    completedSummary:
      "Canonical F/D/E/U outcomes and operational gates are recorded.",
    failedSummary: "Adjudication stopped before outcomes were finalized.",
    steps: [
      {
        id: "verify_lineage",
        label: "Verify Evidence and Prepare",
        description: "Verify exact input artifacts before model execution.",
      },
      {
        id: "apply_gates",
        label: "Apply deterministic gates",
        description: "Record ineligible records as operational non-verdicts.",
      },
      {
        id: "adjudicate_eligible",
        label: "Adjudicate eligible records",
        description: "Run one categorical model request per eligible record.",
      },
      {
        id: "record_outcomes",
        label: "Record outcomes",
        description: "Persist F/D/E/U verdicts and typed nonfatal failures.",
      },
    ],
  },
  {
    stageKey: "report",
    title: "Report",
    pendingSummary: "Report has not started.",
    completedSummary: "The deterministic canonical report is complete.",
    failedSummary: "Report stopped before its canonical chain was summarized.",
    steps: [
      {
        id: "verify_chain",
        label: "Verify canonical chain",
        description: "Tamper-verify all five direct ancestor artifacts.",
      },
      {
        id: "compute_funnel",
        label: "Compute funnel and rates",
        description: "Compute authoritative counts and rate objects.",
      },
      {
        id: "write_report",
        label: "Write JSON and Markdown",
        description: "Write JSON first, then render Markdown from it.",
      },
    ],
  },
] as const satisfies readonly StageWorkflowDefinition[];

const workflowDefinitionsByStage = Object.fromEntries(
  workflowDefinitions.map((definition) => [definition.stageKey, definition]),
) as unknown as Record<StageKey, StageWorkflowDefinition>;
export function getStageWorkflowDefinition(
  stageKey: StageKey,
): StageWorkflowDefinition {
  return workflowDefinitionsByStage[stageKey];
}
export function serializeProgressEvent(event: StageProgressEvent): string {
  return `${progressLogPrefix}${JSON.stringify(event)}`;
}
export function parseProgressEventLine(
  line: string,
): StageProgressEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(progressLogPrefix)) return undefined;
  try {
    return stageProgressEventSchema.parse(
      JSON.parse(trimmed.slice(progressLogPrefix.length)) as unknown,
    );
  } catch {
    return undefined;
  }
}
export function isGenericStageErrorMessage(
  message: string | undefined,
): boolean {
  return message != null && /^Command exited with code \d+\.$/.test(message);
}
export function summarizeFailureDetail(detail: string): string {
  const lines = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return detail.trim();
  return isGenericStageErrorMessage(lines[0]) && lines[1]
    ? lines[1]
    : lines[0]!;
}
export function extractStageFailureDetailFromLog(input: {
  stageKey: StageKey;
  logContent?: string;
}): string | undefined {
  const lines = (input.logContent ?? "").split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const event = parseProgressEventLine(lines[index]!);
    if (
      event?.stage === input.stageKey &&
      event.status === "failed" &&
      event.detail
    )
      return event.detail;
  }
  return undefined;
}
function pendingSteps(stageKey: StageKey): StageWorkflowStep[] {
  return getStageWorkflowDefinition(stageKey).steps.map((step) => ({
    ...step,
    status: "pending",
  }));
}
function fallbackSummary(
  stageKey: StageKey,
  status: StageStatusForWorkflow,
  errorMessage?: string,
): string {
  const definition = getStageWorkflowDefinition(stageKey);
  if (status === "succeeded") return definition.completedSummary;
  if (["failed", "cancelled", "interrupted"].includes(status))
    return errorMessage && !isGenericStageErrorMessage(errorMessage)
      ? summarizeFailureDetail(errorMessage)
      : definition.failedSummary;
  return status === "running"
    ? (definition.steps[0]?.label ?? definition.pendingSummary)
    : definition.pendingSummary;
}
export function buildFallbackStageWorkflowSnapshot(input: {
  stageKey: StageKey;
  stageStatus: StageStatusForWorkflow;
  errorMessage?: string;
}): StageWorkflowSnapshot {
  const definition = getStageWorkflowDefinition(input.stageKey);
  const steps = pendingSteps(input.stageKey);
  if (input.stageStatus === "running")
    steps[0] = {
      ...steps[0]!,
      status: "running",
      detail: "Waiting for structured telemetry from this stage.",
    };
  if (input.stageStatus === "succeeded")
    for (const step of steps) step.status = "completed";
  if (["failed", "cancelled", "interrupted"].includes(input.stageStatus))
    steps[0] = {
      ...steps[0]!,
      status: "failed",
      detail: input.errorMessage ?? definition.failedSummary,
    };
  return {
    stageKey: input.stageKey,
    title: definition.title,
    summary: fallbackSummary(
      input.stageKey,
      input.stageStatus,
      input.errorMessage,
    ),
    source: "fallback",
    steps,
  };
}
export function buildStageWorkflowSnapshot(input: {
  stageKey: StageKey;
  stageStatus: StageStatusForWorkflow;
  logContent?: string;
  errorMessage?: string;
}): StageWorkflowSnapshot {
  const events = (input.logContent ?? "")
    .split("\n")
    .map(parseProgressEventLine)
    .filter(
      (event): event is StageProgressEvent =>
        event != null && event.stage === input.stageKey,
    );
  if (events.length === 0) return buildFallbackStageWorkflowSnapshot(input);
  const definition = getStageWorkflowDefinition(input.stageKey);
  const steps = pendingSteps(input.stageKey);
  let summary: string | undefined;
  let counts: StageWorkflowCount | undefined;
  for (const event of events) {
    const index = steps.findIndex((step) => step.id === event.step);
    if (index < 0) continue;
    for (let earlier = 0; earlier < index; earlier++)
      if (steps[earlier]?.status === "pending")
        steps[earlier] = { ...steps[earlier]!, status: "completed" };
    steps[index] = {
      ...steps[index]!,
      status: event.status,
      ...(event.detail ? { detail: event.detail } : {}),
    };
    if (event.summary) summary = event.summary;
    if (event.current != null && event.total != null)
      counts = {
        current: event.current,
        total: event.total,
        label: input.stageKey === "adjudicate" ? "records" : "items",
      };
  }
  if (input.stageStatus === "succeeded")
    for (const step of steps)
      if (step.status !== "skipped") step.status = "completed";
  if (
    ["failed", "cancelled", "interrupted"].includes(input.stageStatus) &&
    !steps.some((step) => step.status === "failed")
  )
    steps[0] = {
      ...steps[0]!,
      status: "failed",
      detail: input.errorMessage ?? definition.failedSummary,
    };
  return {
    stageKey: input.stageKey,
    title: definition.title,
    summary:
      summary ??
      fallbackSummary(input.stageKey, input.stageStatus, input.errorMessage),
    source: "telemetry",
    ...(counts ? { counts } : {}),
    steps,
  };
}
