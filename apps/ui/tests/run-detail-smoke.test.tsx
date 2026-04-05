import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RunDetail,
  StageWorkflowSnapshot,
} from "citation-fidelity/ui-contract";

import { RunDetailClient } from "../components/run-detail-client";

const pendingTail = [
  {
    id: "capture_verdicts_and_rationales",
    label: "Capture verdicts and rationales",
    description:
      "Persist the model’s outputs into the calibration dataset so each record becomes inspectable in the UI.",
    status: "pending" as const,
  },
  {
    id: "summarize_verdict_distribution",
    label: "Summarize the verdict distribution",
    description:
      "Roll up the judged records into supported, partially supported, and not supported slices.",
    status: "pending" as const,
  },
  {
    id: "write_final_outputs",
    label: "Write final outputs",
    description:
      "Write the final JSON and markdown artifacts used for the run summary and detailed verdict inspection.",
    status: "pending" as const,
  },
];

function buildWorkflow(detail: string, current: number): StageWorkflowSnapshot {
  return {
    stageKey: "m6-llm-judge",
    title: "Current work",
    summary: "Adjudicating calibration records.",
    source: "telemetry",
    counts: { current, total: 5, label: "records" },
    steps: [
      {
        id: "load_active_records",
        label: "Load active calibration records",
        description:
          "Read the adjudication records that are in scope for model judging and exclude any records already filtered out.",
        status: "completed",
      },
      {
        id: "adjudicate_records",
        label: "Adjudicate records with the model",
        description:
          "Send each active record through the configured model to get a verdict, rationale, confidence, and retrieval-quality judgment.",
        status: "running",
        detail,
      },
      ...pendingTail,
    ],
  };
}

function buildRunDetail(workflow: StageWorkflowSnapshot): RunDetail {
  const stageBase = {
    runId: "run-smoke",
    inputArtifactPath: undefined,
    primaryArtifactPath: undefined,
    reportArtifactPath: undefined,
    manifestPath: undefined,
    logPath: "/tmp/run-smoke/m6.log",
    errorMessage: undefined,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    exitCode: undefined,
    processId: undefined,
  };

  const stages = [
    {
      ...stageBase,
      stageKey: "pre-screen" as const,
      stageOrder: 1,
      status: "succeeded" as const,
      summary: {
        headline: "Done",
        metrics: [],
        artifacts: [],
      },
    },
    {
      ...stageBase,
      stageKey: "m2-extract" as const,
      stageOrder: 2,
      status: "succeeded" as const,
      summary: { headline: "Done", metrics: [], artifacts: [] },
    },
    {
      ...stageBase,
      stageKey: "m3-classify" as const,
      stageOrder: 3,
      status: "succeeded" as const,
      summary: { headline: "Done", metrics: [], artifacts: [] },
    },
    {
      ...stageBase,
      stageKey: "m4-evidence" as const,
      stageOrder: 4,
      status: "succeeded" as const,
      summary: { headline: "Done", metrics: [], artifacts: [] },
    },
    {
      ...stageBase,
      stageKey: "m5-adjudicate" as const,
      stageOrder: 5,
      status: "succeeded" as const,
      summary: { headline: "Done", metrics: [], artifacts: [] },
    },
    {
      ...stageBase,
      stageKey: "m6-llm-judge" as const,
      stageOrder: 6,
      status: "running" as const,
      summary: {
        headline: workflow.summary,
        metrics: workflow.counts
          ? [
              {
                label: workflow.counts.label,
                value: `${String(workflow.counts.current)}/${String(workflow.counts.total)}`,
              },
            ]
          : [],
        artifacts: [{ kind: "primary", path: "/tmp/run-smoke/primary.json" }],
      },
    },
  ];

  return {
    id: "run-smoke",
    seedDoi: "10.1234/smoke",
    trackedClaim: "Fixture claim for smoke coverage.",
    targetStage: "m6-llm-judge",
    status: "running",
    currentStage: "m6-llm-judge",
    runRoot: "/tmp/run-smoke",
    config: {
      stopAfterStage: "m6-llm-judge",
      forceRefresh: false,
      m5TargetSize: 40,
      m6Model: "claude-opus-4-6",
      m6Thinking: false,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stages,
    activeWorkflow: workflow,
  };
}

describe("Run detail smoke (fixture)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows advancing workflow, step popover, live log, and raw artifact chrome", async () => {
    let pollCount = 0;
    const workflowV1 = buildWorkflow("Adjudicating record 1 of 5", 1);
    const workflowV2 = buildWorkflow("Adjudicating record 3 of 5", 3);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url.includes("/stages/") && url.includes("/log")) {
          return new Response(
            JSON.stringify({
              content:
                'CF_PROGRESS {"stage":"m6-llm-judge","step":"adjudicate_records","status":"running","detail":"fixture log line"}\nstderr-style line',
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.includes("/artifacts/primary")) {
          return new Response('{"fixturePrimary":true}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/api/runs/run-smoke") && !url.includes("/stages/")) {
          pollCount += 1;
          const workflow = pollCount >= 1 ? workflowV2 : workflowV1;
          return new Response(JSON.stringify(buildRunDetail(workflow)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      }),
    );

    render(<RunDetailClient initialRun={buildRunDetail(workflowV1)} />);

    expect(screen.getByText("Stage log")).toBeTruthy();
    expect(screen.getByText("M6 LLM Judge output")).toBeTruthy();
    expect(screen.getByText("Raw Artifacts")).toBeTruthy();
    expect(screen.getByText("Adjudicating record 1 of 5")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "More about Adjudicate records with the model",
      }),
    );
    expect(
      screen.getByText(
        "Send each active record through the configured model to get a verdict, rationale, confidence, and retrieval-quality judgment.",
      ),
    ).toBeTruthy();

    await vi.advanceTimersByTimeAsync(2_000);

    await waitFor(() => {
      expect(screen.getByText("3/5 records")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText(/fixture log line/)).toBeTruthy();
    });
  });
});
