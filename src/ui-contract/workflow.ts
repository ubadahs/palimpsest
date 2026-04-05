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
    status: z.enum(["running", "completed", "failed"]),
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
    {
      message: "current and total must be provided together",
    },
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
    stageKey: "pre-screen",
    title: "Current work",
    pendingSummary: "Family viability has not been evaluated yet.",
    completedSummary: "Family viability and auditability checks are complete.",
    failedSummary: "Pre-screen stopped before family viability could be finalized.",
    steps: [
      {
        id: "resolve_seed_paper",
        label: "Resolve the seed paper",
        description:
          "Find the seed paper metadata and establish the canonical paper record for the run.",
      },
      {
        id: "gather_citing_papers",
        label: "Gather citing papers",
        description:
          "Pull the local citation family around the seed so the run has a concrete neighborhood to inspect.",
      },
      {
        id: "collapse_duplicates",
        label: "Collapse duplicates",
        description:
          "Merge duplicate or overlapping paper records so downstream counts reflect unique citing papers.",
      },
      {
        id: "assess_auditability",
        label: "Assess auditability and paper types",
        description:
          "Check which citing papers are auditable, what formats they offer, and what kinds of papers they are.",
      },
      {
        id: "summarize_family_viability",
        label: "Summarize family viability",
        description:
          "Turn the family composition into a greenlight or deprioritize decision for the heavier stages.",
      },
    ],
  },
  {
    stageKey: "m2-extract",
    title: "Current work",
    pendingSummary: "Citation extraction has not started yet.",
    completedSummary: "Citation mentions and grounding contexts have been extracted.",
    failedSummary: "Citation extraction stopped before usable grounding contexts were finalized.",
    steps: [
      {
        id: "select_auditable_papers",
        label: "Select auditable citing papers",
        description:
          "Decide which citing papers have enough accessible full text to attempt citation-context extraction.",
      },
      {
        id: "fetch_and_parse_full_text",
        label: "Fetch and parse citing full text",
        description:
          "Load each auditable citing paper and parse it into a structured representation suitable for citation matching.",
      },
      {
        id: "locate_citation_mentions",
        label: "Locate citation mentions",
        description:
          "Find the specific in-text references that point back to the seed paper.",
      },
      {
        id: "deduplicate_and_filter_mentions",
        label: "Deduplicate and filter mentions",
        description:
          "Collapse redundant mentions and keep only contexts that can support later evidence grounding.",
      },
      {
        id: "summarize_grounding_contexts",
        label: "Summarize usable grounding contexts",
        description:
          "Roll up extraction outcomes into the usable edges and mention counts shown in the run summary.",
      },
    ],
  },
  {
    stageKey: "m3-classify",
    title: "Current work",
    pendingSummary: "Citation roles and evaluation tasks have not been assembled yet.",
    completedSummary: "Citation roles and evaluation tasks are ready for evidence retrieval.",
    failedSummary: "Classification stopped before task packets were finalized.",
    steps: [
      {
        id: "load_extracted_mentions",
        label: "Load extracted mentions",
        description:
          "Read the extracted citation contexts and the pre-screen context needed for classification.",
      },
      {
        id: "classify_citation_roles",
        label: "Classify citation roles",
        description:
          "Assign each mention a role such as substantive attribution, background framing, or methods use.",
      },
      {
        id: "derive_evaluation_modes",
        label: "Derive evaluation modes",
        description:
          "Translate citation roles and modifiers into the fidelity questions the run needs to ask next.",
      },
      {
        id: "assemble_task_packets",
        label: "Assemble task packets",
        description:
          "Bundle classified mentions into per-edge evaluation packets with the right rubric metadata.",
      },
      {
        id: "summarize_literature_structure",
        label: "Summarize literature structure",
        description:
          "Produce the task, role, and manual-review totals that describe the run’s evaluation workload.",
      },
    ],
  },
  {
    stageKey: "m4-evidence",
    title: "Current work",
    pendingSummary: "Evidence retrieval has not started yet.",
    completedSummary: "Grounding evidence has been retrieved and attached to tasks.",
    failedSummary: "Evidence retrieval stopped before grounded coverage was finalized.",
    steps: [
      {
        id: "resolve_cited_paper",
        label: "Resolve the cited paper",
        description:
          "Locate the cited paper record and confirm which canonical source should be used for evidence lookup.",
      },
      {
        id: "fetch_and_parse_cited_full_text",
        label: "Fetch and parse cited full text",
        description:
          "Retrieve the cited paper’s full text and materialize it into searchable blocks.",
      },
      {
        id: "retrieve_candidate_evidence",
        label: "Retrieve candidate evidence blocks",
        description:
          "Search the cited paper for text blocks that could support or contradict the citing contexts.",
      },
      {
        id: "rerank_and_attach_evidence",
        label: "Rerank and attach evidence",
        description:
          "Refine candidate blocks when a reranker is available and attach the best evidence spans to each task.",
      },
      {
        id: "summarize_grounded_coverage",
        label: "Summarize grounded coverage",
        description:
          "Produce the coverage totals that show how much of the task set has evidence attached.",
      },
    ],
  },
  {
    stageKey: "m5-adjudicate",
    title: "Current work",
    pendingSummary: "Calibration sampling has not started yet.",
    completedSummary: "The calibration set and worksheet are ready for inspection.",
    failedSummary: "Calibration sampling stopped before the worksheet was finalized.",
    steps: [
      {
        id: "collect_eligible_tasks",
        label: "Collect eligible tasks",
        description:
          "Gather the task pool that has enough evidence to be considered for calibration sampling.",
      },
      {
        id: "prioritize_edge_cases",
        label: "Prioritize edge cases",
        description:
          "Surface bundled, review-mediated, and ambiguous cases that deserve extra attention in calibration.",
      },
      {
        id: "allocate_mode_balanced_sample",
        label: "Allocate a mode-balanced sample",
        description:
          "Select a sample that covers the main evaluation modes instead of over-indexing on only one type of task.",
      },
      {
        id: "build_calibration_records",
        label: "Build calibration records",
        description:
          "Convert the sampled tasks into adjudication-ready records with the citing context and retrieved evidence.",
      },
      {
        id: "write_sampling_outputs",
        label: "Write worksheet and sampling summary",
        description:
          "Write the calibration artifacts that the UI and CLI use for inspection.",
      },
    ],
  },
  {
    stageKey: "m6-llm-judge",
    title: "Current work",
    pendingSummary: "LLM adjudication has not started yet.",
    completedSummary: "Verdicts and rationales have been generated.",
    failedSummary: "LLM adjudication stopped before verdict outputs were finalized.",
    steps: [
      {
        id: "load_active_records",
        label: "Load active calibration records",
        description:
          "Read the adjudication records that are in scope for model judging and exclude any records already filtered out.",
      },
      {
        id: "adjudicate_records",
        label: "Adjudicate records with the model",
        description:
          "Send each active record through the configured model to get a verdict, rationale, confidence, and retrieval-quality judgment.",
      },
      {
        id: "capture_verdicts_and_rationales",
        label: "Capture verdicts and rationales",
        description:
          "Persist the model’s outputs into the calibration dataset so each record becomes inspectable in the UI.",
      },
      {
        id: "summarize_verdict_distribution",
        label: "Summarize the verdict distribution",
        description:
          "Roll up the judged records into supported, partially supported, and not supported slices.",
      },
      {
        id: "write_final_outputs",
        label: "Write final outputs",
        description:
          "Write the final JSON and markdown artifacts used for the run summary and detailed verdict inspection.",
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
  if (!trimmed.startsWith(progressLogPrefix)) {
    return undefined;
  }

  try {
    return stageProgressEventSchema.parse(
      JSON.parse(trimmed.slice(progressLogPrefix.length)) as unknown,
    );
  } catch {
    return undefined;
  }
}

function buildPendingSteps(stageKey: StageKey): StageWorkflowStep[] {
  return getStageWorkflowDefinition(stageKey).steps.map((step) => ({
    ...step,
    status: "pending",
  }));
}

function inferRunningStepIndex(steps: StageWorkflowStep[]): number {
  const firstPending = steps.findIndex((step) => step.status === "pending");
  if (firstPending >= 0) {
    return firstPending;
  }

  return Math.max(steps.length - 1, 0);
}

function fallbackSummary(
  stageKey: StageKey,
  stageStatus: StageStatusForWorkflow,
  errorMessage: string | undefined,
): string {
  const definition = getStageWorkflowDefinition(stageKey);
  if (stageStatus === "succeeded") {
    return definition.completedSummary;
  }

  if (
    stageStatus === "failed" ||
    stageStatus === "cancelled" ||
    stageStatus === "interrupted"
  ) {
    return errorMessage ?? definition.failedSummary;
  }

  if (stageStatus === "running") {
    return definition.steps[inferRunningStepIndex(buildPendingSteps(stageKey))]?.label ??
      definition.pendingSummary;
  }

  return definition.pendingSummary;
}

export function buildFallbackStageWorkflowSnapshot(input: {
  stageKey: StageKey;
  stageStatus: StageStatusForWorkflow;
  errorMessage?: string;
}): StageWorkflowSnapshot {
  const definition = getStageWorkflowDefinition(input.stageKey);
  const steps = buildPendingSteps(input.stageKey);

  if (input.stageStatus === "running") {
    const runningIndex = inferRunningStepIndex(steps);
    steps[runningIndex] = {
      ...steps[runningIndex]!,
      status: "running",
      detail: "Waiting for structured telemetry from this stage.",
    };
  } else if (input.stageStatus === "succeeded") {
    for (const step of steps) {
      step.status = "completed";
    }
  } else if (
    input.stageStatus === "failed" ||
    input.stageStatus === "cancelled" ||
    input.stageStatus === "interrupted"
  ) {
    steps[0] = {
      ...steps[0]!,
      status: "failed",
      detail: input.errorMessage ?? definition.failedSummary,
    };
  }

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
  const definition = getStageWorkflowDefinition(input.stageKey);
  const events = (input.logContent ?? "")
    .split("\n")
    .map(parseProgressEventLine)
    .filter(
      (event): event is StageProgressEvent =>
        event != null && event.stage === input.stageKey,
    );

  if (events.length === 0) {
    return buildFallbackStageWorkflowSnapshot(
      input.errorMessage
        ? {
            stageKey: input.stageKey,
            stageStatus: input.stageStatus,
            errorMessage: input.errorMessage,
          }
        : {
            stageKey: input.stageKey,
            stageStatus: input.stageStatus,
          },
    );
  }

  const steps = buildPendingSteps(input.stageKey);
  let summary: string | undefined;
  let counts: StageWorkflowCount | undefined;
  let lastStepIndex = -1;

  for (const event of events) {
    const stepIndex = definition.steps.findIndex((step) => step.id === event.step);
    if (stepIndex < 0) {
      continue;
    }

    for (let index = 0; index < stepIndex; index++) {
      if (steps[index]?.status === "pending" || steps[index]?.status === "running") {
        steps[index] = {
          ...steps[index]!,
          status: "completed",
        };
      }
    }

    if (event.status === "running") {
      for (let index = stepIndex + 1; index < steps.length; index++) {
        if (steps[index]?.status !== "failed") {
          steps[index] = {
            ...steps[index]!,
            status: "pending",
          };
        }
      }
    }

    const nextStep: StageWorkflowStep = {
      ...steps[stepIndex]!,
      status: event.status,
    };
    if (event.detail) {
      nextStep.detail = event.detail;
    } else {
      delete nextStep.detail;
    }
    steps[stepIndex] = nextStep;

    if (event.summary) {
      summary = event.summary;
    }
    if (event.current != null && event.total != null) {
      counts = {
        current: event.current,
        total: event.total,
        label:
          input.stageKey === "m6-llm-judge"
            ? "records"
            : input.stageKey === "m2-extract"
              ? "edges"
              : "items",
      };
    }
    lastStepIndex = stepIndex;
  }

  if (
    input.stageStatus === "succeeded" &&
    steps.some((step) => step.status !== "completed")
  ) {
    for (const step of steps) {
      step.status = "completed";
    }
  }

  if (
    (input.stageStatus === "failed" ||
      input.stageStatus === "cancelled" ||
      input.stageStatus === "interrupted") &&
    !steps.some((step) => step.status === "failed")
  ) {
    const failureIndex =
      lastStepIndex >= 0 ? Math.min(lastStepIndex, steps.length - 1) : 0;
    steps[failureIndex] = {
      ...steps[failureIndex]!,
      status: "failed",
      detail: input.errorMessage ?? definition.failedSummary,
    };
  }

  const defaultSummary =
    input.stageStatus === "succeeded"
      ? definition.completedSummary
      : input.stageStatus === "failed" ||
          input.stageStatus === "cancelled" ||
          input.stageStatus === "interrupted"
        ? input.errorMessage ?? definition.failedSummary
        : steps.find((step) => step.status === "running")?.label ??
          definition.pendingSummary;

  return {
    stageKey: input.stageKey,
    title: definition.title,
    summary: summary ?? defaultSummary,
    source: "telemetry",
    ...(counts ? { counts } : {}),
    steps,
  };
}
