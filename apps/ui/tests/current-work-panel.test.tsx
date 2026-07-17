import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StageWorkflowSnapshot } from "palimpsest/contract";

import { CurrentWorkPanel } from "../components/current-work-panel";

const workflow: StageWorkflowSnapshot = {
  stageKey: "evidence",
  title: "Current work",
  summary: "Canonical evidence retrieval is underway.",
  source: "telemetry",
  counts: {
    current: 2,
    total: 6,
    label: "records",
  },
  steps: [
    {
      id: "verify_lineage",
      label: "Verify lineage",
      description: "Verify exact input artifacts before retrieval.",
      status: "completed",
      detail: "Prepare and Scope lineage verified",
    },
    {
      id: "chunk_seed_text",
      label: "Chunk seed text",
      description: "Create deterministic fixed-window chunks from Scope text.",
      status: "completed",
      detail: "12 chunks",
    },
    {
      id: "run_bm25",
      label: "Run BM25",
      description: "Retrieve using only the declared family claim.",
      status: "running",
      detail: "Ranking record 2 of 6",
    },
    {
      id: "rerank_if_enabled",
      label: "Optional rerank",
      description: "Record a separate relevance-only reranking outcome.",
      status: "pending",
    },
  ],
};

describe("CurrentWorkPanel", () => {
  it("renders workflow steps and live source details", () => {
    render(<CurrentWorkPanel workflow={workflow} />);

    expect(
      screen.getByText("Canonical evidence retrieval is underway."),
    ).toBeTruthy();
    expect(screen.getByText("2/6 records")).toBeTruthy();
    expect(screen.getByText("Run BM25")).toBeTruthy();
    expect(screen.getByText("Ranking record 2 of 6")).toBeTruthy();
    expect(screen.queryByText("Prepare and Scope lineage verified")).toBeNull();
  });

  it("shows completed step detail inside the info popover only", () => {
    render(<CurrentWorkPanel workflow={workflow} />);

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "More about Verify lineage",
      })[0]!,
    );

    expect(screen.getByText("Prepare and Scope lineage verified")).toBeTruthy();
  });

  it("opens the step explanation popover", () => {
    render(<CurrentWorkPanel workflow={workflow} />);

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "More about Run BM25",
      })[0]!,
    );

    expect(
      screen.getByText("Retrieve using only the declared family claim."),
    ).toBeTruthy();
  });

  it("renders fallback workflows without counts", () => {
    const fallbackWorkflow: StageWorkflowSnapshot = {
      ...workflow,
      source: "fallback",
      summary: "Workflow inferred from stage status.",
    };
    delete (fallbackWorkflow as { counts?: StageWorkflowSnapshot["counts"] })
      .counts;

    render(
      <CurrentWorkPanel
        progressVariant="archive"
        workflow={fallbackWorkflow}
      />,
    );

    expect(
      screen.getByText("Workflow inferred from stage status."),
    ).toBeTruthy();
  });
});
