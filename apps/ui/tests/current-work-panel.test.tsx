import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StageWorkflowSnapshot } from "citation-fidelity/ui-contract";

import { CurrentWorkPanel } from "../components/current-work-panel";

const workflow: StageWorkflowSnapshot = {
  stageKey: "m2-extract",
  title: "Current work",
  summary: "Citation extraction is underway.",
  source: "telemetry",
  counts: {
    current: 2,
    total: 6,
    label: "edges",
  },
  steps: [
    {
      id: "select_auditable_papers",
      label: "Select auditable citing papers",
      description: "Choose the citing papers that can actually be parsed.",
      status: "completed",
      detail: "6 auditable papers selected",
    },
    {
      id: "fetch_and_parse_full_text",
      label: "Fetch and parse citing full text",
      description: "Fetch each citing paper and parse it into structured text.",
      status: "running",
      detail: "Working through edge 2 of 6",
    },
    {
      id: "locate_citation_mentions",
      label: "Locate citation mentions",
      description: "Find the in-text references that point back to the seed.",
      status: "pending",
    },
  ],
};

describe("CurrentWorkPanel", () => {
  it("renders workflow steps and live source details", () => {
    render(<CurrentWorkPanel workflow={workflow} />);

    expect(screen.getByText("Citation extraction is underway.")).toBeTruthy();
    expect(screen.getByText("2/6 edges")).toBeTruthy();
    expect(screen.getByText("Live progress from stage telemetry")).toBeTruthy();
    expect(screen.getByText("Fetch and parse citing full text")).toBeTruthy();
    expect(screen.getByText("Working through edge 2 of 6")).toBeTruthy();
    expect(screen.queryByText("6 auditable papers selected")).toBeNull();
  });

  it("shows completed step detail inside the info popover only", () => {
    render(<CurrentWorkPanel workflow={workflow} />);

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "More about Select auditable citing papers",
      })[0]!,
    );

    expect(screen.getByText("6 auditable papers selected")).toBeTruthy();
  });

  it("opens the step explanation popover", () => {
    render(<CurrentWorkPanel workflow={workflow} />);

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "More about Fetch and parse citing full text",
      })[0]!,
    );

    expect(
      screen.getByText(
        "Fetch each citing paper and parse it into structured text.",
      ),
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
    expect(
      screen.getByText("Workflow inferred from saved stage status"),
    ).toBeTruthy();
  });
});
