import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analysisRunConfigSchema,
  stageDefinitions,
  type RunDetail,
} from "palimpsest/contract";

import { RunDetailClient } from "../components/run-detail-client";

const stages = stageDefinitions.map((stage) => ({
  stageKey: stage.key,
  stageOrder: stage.order,
  aggregateStatus: "not_started" as const,
  members: [],
}));

describe("Run detail smoke", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the canonical six-stage rail", () => {
    const run: RunDetail = {
      id: "run-smoke",
      seedDoi: "10.1234/seed",
      targetStage: "report",
      status: "queued",
      runRoot: "/tmp/run-smoke",
      config: {
        stopAfterStage: "report",
        forceRefresh: false,
        discover: {
          neighborhoodProvider: "openalex",
          neighborhoodQuery: "works-citing-seed",
          neighborhoodLimit: 200,
          probeBudget: 100,
          candidateSelection: { mode: "adaptive_portfolio", minFamilies: 15, maxFamilies: 25, maxPreparedRecords: 100 },
          extractionModel: "claude-haiku-4-5",
          extractionThinking: false,
        },
        scope: { groundingModel: "claude-sonnet-4-6", groundingThinking: true },
        prepare: { classifier: "deterministic" },
        evidence: {
          rerankEnabled: false,
          rerankModel: "claude-haiku-4-5",
          rerankTopN: 5,
          bm25CandidateLimit: 20,
          selectionLimit: 5,
        },
        adjudicate: { model: "claude-opus-4-6", thinking: true },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      stages,
    };

    render(<RunDetailClient initialRun={run} />);

    expect(screen.getByText("0 of 6 stages complete")).toBeTruthy();
    for (const stage of stageDefinitions) {
      expect(screen.getAllByText(stage.title).length).toBeGreaterThan(0);
    }
  });

  it("reports a partial target truthfully and offers the next extension", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("null", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const partial: RunDetail = {
      id: "run-partial",
      seedDoi: "10.1234/partial",
      targetStage: "discover",
      status: "succeeded",
      runRoot: "/tmp/run-partial",
      config: analysisRunConfigSchema.parse({
        stopAfterStage: "discover",
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      stages: stageDefinitions.map((stage) => ({
        stageKey: stage.key,
        stageOrder: stage.order,
        aggregateStatus:
          stage.key === "discover"
            ? ("succeeded" as const)
            : ("not_started" as const),
        members:
          stage.key === "discover"
            ? [
                {
                  runId: "run-partial",
                  stageKey: "discover" as const,
                  stageOrder: stage.order,
                  status: "succeeded" as const,
                },
              ]
            : [],
      })),
    };

    render(<RunDetailClient initialRun={partial} />);

    expect(
      screen.getByText("All 1 targeted stages complete through Discover"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue to Scope" }),
    ).toBeTruthy();
    expect(screen.queryByText("All 6 stages complete")).toBeNull();
  });

  it("polls a running canonical run and renders live workflow updates", async () => {
    vi.useFakeTimers();
    const running: RunDetail = {
      id: "run-live",
      seedDoi: "10.1234/live",
      targetStage: "report",
      status: "running",
      currentStage: "discover",
      runRoot: "/tmp/run-live",
      config: {
        stopAfterStage: "report",
        forceRefresh: false,
        discover: {
          neighborhoodProvider: "openalex",
          neighborhoodQuery: "works-citing-seed",
          neighborhoodLimit: 200,
          probeBudget: 100,
          candidateSelection: { mode: "adaptive_portfolio", minFamilies: 15, maxFamilies: 25, maxPreparedRecords: 100 },
          extractionModel: "claude-haiku-4-5",
          extractionThinking: false,
        },
        scope: {
          groundingModel: "claude-sonnet-4-6",
          groundingThinking: true,
        },
        prepare: { classifier: "deterministic" },
        evidence: {
          rerankEnabled: false,
          rerankModel: "claude-haiku-4-5",
          rerankTopN: 5,
          bm25CandidateLimit: 20,
          selectionLimit: 5,
        },
        adjudicate: { model: "claude-opus-4-6", thinking: true },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      stages: stageDefinitions.map((stage) => ({
        stageKey: stage.key,
        stageOrder: stage.order,
        aggregateStatus:
          stage.key === "discover"
            ? ("running" as const)
            : ("not_started" as const),
        members:
          stage.key === "discover"
            ? [
                {
                  runId: "run-live",
                  stageKey: "discover" as const,
                  stageOrder: 0,
                  status: "running" as const,
                },
              ]
            : [],
      })),
      activeWorkflow: {
        stageKey: "discover",
        title: "Discover",
        summary: "Resolving seed metadata.",
        source: "telemetry",
        steps: [
          {
            id: "resolve_seeds",
            label: "Resolve seed metadata",
            description: "Resolve DOI seed identities.",
            status: "running",
          },
        ],
      },
    };
    const completed: RunDetail = {
      ...running,
      status: "succeeded",
      currentStage: undefined,
      updatedAt: "2026-01-01T00:00:03.000Z",
      stages: running.stages.map((stage) => ({
        ...stage,
        aggregateStatus: "succeeded",
        members: [
          {
            runId: "run-live",
            stageKey: stage.stageKey,
            stageOrder: stage.stageOrder,
            status: "succeeded",
          },
        ],
      })),
      activeWorkflow: {
        ...running.activeWorkflow!,
        summary: "Citing-neighborhood discovery is complete.",
        steps: running.activeWorkflow!.steps.map((step) => ({
          ...step,
          status: "completed",
        })),
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.endsWith("/cost")
                ? { totalEstimatedCostUsd: 0, source: "cost_file" }
                : url.includes("/log")
                  ? { content: "CF_PROGRESS live canonical output" }
                  : completed,
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    render(<RunDetailClient initialRun={running} />);
    expect(screen.getByText("Resolving seed metadata.")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("CF_PROGRESS live canonical output")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getAllByText("succeeded").length).toBeGreaterThan(0);
    expect(screen.getByText("All 6 stages complete")).toBeTruthy();
  });
});
