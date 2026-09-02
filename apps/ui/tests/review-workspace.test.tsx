import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HumanReviewState,
  ReportInspectorRecordRow,
} from "palimpsest/contract";

import { ReviewWorkspace } from "../components/report/review-workspace";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function record(
  overrides: Partial<ReportInspectorRecordRow> &
    Pick<ReportInspectorRecordRow, "recordId" | "adjudicationStatus">,
): ReportInspectorRecordRow {
  return {
    familyId: "family_1",
    citationOccurrenceId: "mention_1",
    trackedClaim: "Tracked claim",
    evaluatedClaimText: "Evaluated claim text",
    seedId: "seed_1",
    seedTitle: "Seed",
    citingPaperId: "citing_paper_1",
    citingPaperTitle: "Citing paper",
    citingPaperYear: 2024,
    citationContext: "Context with a citing claim span here.",
    classificationStatus: "classified",
    groundingStatus: "grounded",
    verifiedSeedGroundingSpans: [],
    occurrenceClaims: [],
    retrievalStatus: "retrieved",
    rerankStatus: "disabled",
    evidencePassages: [
      {
        chunkId: "chunk_1",
        text: "Evidence passage",
        sourceBlockKind: "body_paragraph",
        pinned: true,
        modelCited: true,
      },
    ],
    ...overrides,
  };
}

const emptyState: HumanReviewState = {
  lineage: {
    runId: "run_1",
    reportArtifactId: `artifact_${"a".repeat(64)}`,
    reportContentHash: "b".repeat(64),
  },
  headEventId: null,
  progress: {
    totalRecords: 2,
    unreviewed: 2,
    draft: 0,
    final: 0,
  },
  records: [],
  staleReport: false,
};

describe("review workspace", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/review") && (!init || init.method == null)) {
          return new Response(JSON.stringify(emptyState), { status: 200 });
        }
        if (url.endsWith("/review/events") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            recordId: string;
            familyId: string;
            reviewer: string;
            status: "draft" | "final";
            assessment: HumanReviewState["records"][number]["assessment"];
          };
          const eventId = `hrevent_${"1".repeat(32)}`;
          const state: HumanReviewState = {
            ...emptyState,
            headEventId: eventId,
            progress: {
              totalRecords: 2,
              unreviewed: 1,
              draft: body.status === "draft" ? 1 : 0,
              final: body.status === "final" ? 1 : 0,
            },
            records: [
              {
                recordId: body.recordId,
                familyId: body.familyId,
                status: body.status,
                reviewer: body.reviewer,
                updatedAt: "2026-08-08T12:00:00.000Z",
                eventId,
                revisionCount: 1,
                assessment: body.assessment,
              },
            ],
          };
          return new Response(JSON.stringify({ event: { eventId }, state }), {
            status: 201,
          });
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      }),
    );
  });

  it("filters the queue and saves a draft review", async () => {
    const onSelectRecord = vi.fn();
    render(
      <ReviewWorkspace
        onSelectRecord={onSelectRecord}
        records={[
          record({
            recordId: "record_f",
            adjudicationStatus: "adjudicated",
            verdict: "F",
          }),
          record({
            recordId: "record_d",
            adjudicationStatus: "adjudicated",
            verdict: "D",
            evaluatedClaimText: "Distorted claim",
            citingPaperTitle: "Distortion paper",
          }),
        ]}
        reportArtifactId={`artifact_${"a".repeat(64)}`}
        reportContentHash={"b".repeat(64)}
        runId="run_1"
        selectedRecordId="record_f"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/2 unreviewed of 2/i)).toBeTruthy();
    });

    // Blinded by default: no verdict filter and no machine badge is offered.
    expect(screen.getByText("blinded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^D$/i })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /hide machine/i }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByText("not blinded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^D$/i }));
    expect(screen.getByText("Distortion paper")).toBeTruthy();
    expect(screen.getAllByText("Distorted claim").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Reviewer"), {
      target: { value: "ubadah" },
    });
    // Nothing saves until the reviewer has recorded their own verdict.
    expect(
      (screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "F" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(screen.getByText(/1 draft/i)).toBeTruthy();
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/runs/run_1/review/events",
      expect.objectContaining({ method: "POST" }),
    );
    const eventCall = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).endsWith("/review/events"));
    const posted = JSON.parse(String(eventCall?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(posted["citationContext"]).toBeUndefined();
    expect(posted["knownCitedChunkIds"]).toBeUndefined();
  });

  it("records a blinded human verdict as final", async () => {
    render(
      <ReviewWorkspace
        onSelectRecord={() => undefined}
        records={[
          record({
            recordId: "record_f",
            adjudicationStatus: "adjudicated",
            verdict: "F",
          }),
        ]}
        reportArtifactId={`artifact_${"a".repeat(64)}`}
        reportContentHash={"b".repeat(64)}
        runId="run_1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/2 unreviewed of 2/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Reviewer"), {
      target: { value: "ubadah" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "E" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark final" }));

    await waitFor(() => {
      expect(screen.getByText(/1 final/i)).toBeTruthy();
    });
    const eventCall = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).endsWith("/review/events"));
    const posted = JSON.parse(String(eventCall?.[1]?.body)) as {
      status: string;
      assessment: { humanVerdict: string; blinded: boolean };
    };
    expect(posted.status).toBe("final");
    // The machine's F was never shown, so the label is usable for calibration.
    expect(posted.assessment).toMatchObject({
      humanVerdict: "E",
      blinded: true,
      mutationKinds: [],
    });
  });

  it("marks a review not blinded once the machine verdict is revealed", async () => {
    render(
      <ReviewWorkspace
        onSelectRecord={() => undefined}
        records={[
          record({
            recordId: "record_f",
            adjudicationStatus: "adjudicated",
            verdict: "F",
          }),
        ]}
        reportArtifactId={`artifact_${"a".repeat(64)}`}
        reportContentHash={"b".repeat(64)}
        runId="run_1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/2 unreviewed of 2/i)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /hide machine/i }));
    // Re-hiding does not un-see it.
    fireEvent.click(screen.getByRole("checkbox", { name: /hide machine/i }));
    expect(screen.getByText("not blinded")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Reviewer"), {
      target: { value: "ubadah" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "F" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark final" }));

    await waitFor(() => {
      expect(screen.getByText(/1 final/i)).toBeTruthy();
    });
    const eventCall = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).endsWith("/review/events"));
    const posted = JSON.parse(String(eventCall?.[1]?.body)) as {
      assessment: { blinded: boolean };
    };
    expect(posted.assessment.blinded).toBe(false);
  });

  it("surfaces stale report messaging from a lineage mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...emptyState,
              lineage: {
                ...emptyState.lineage,
                reportContentHash: "c".repeat(64),
              },
              staleReport: false,
            }),
            { status: 200 },
          ),
      ),
    );

    render(
      <ReviewWorkspace
        onSelectRecord={() => undefined}
        records={[
          record({
            recordId: "record_f",
            adjudicationStatus: "adjudicated",
            verdict: "F",
          }),
        ]}
        reportArtifactId={`artifact_${"a".repeat(64)}`}
        reportContentHash={"b".repeat(64)}
        runId="run_1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/different Report artifact\/hash/i)).toBeTruthy();
    });
  });
});
