import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunStageDetail } from "palimpsest/contract";

import { StageInspector } from "../components/stage-inspector";

describe("typed canonical stage inspector", () => {
  it("renders Evidence summaries from its typed payload", () => {
    const detail = {
      runId: "run-inspector",
      stageKey: "evidence",
      stageOrder: 3,
      familyIndex: 0,
      status: "succeeded",
      stageTitle: "Evidence",
      artifactPointers: [],
      workflow: {
        stageKey: "evidence",
        title: "Evidence",
        summary: "Evidence complete.",
        source: "telemetry",
        steps: [],
      },
      inspectorPayload: {
        stageKey: "evidence",
        rawArtifact: {},
        summary: {
          records: 4,
          retrievalOutcomes: { retrieved: 4 },
          selections: 4,
          bm25Runs: 2,
          rerankRuns: 1,
        },
      },
    } as RunStageDetail<"evidence">;

    render(<StageInspector detail={detail} runId="run-inspector" />);
    expect(screen.getByText("Canonical Evidence inspector")).toBeTruthy();
    expect(screen.getByText("BM25 runs")).toBeTruthy();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
  });
});
