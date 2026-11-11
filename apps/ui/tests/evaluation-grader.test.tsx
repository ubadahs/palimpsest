import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnnotationEvent,
  BlindEvaluationCase,
} from "palimpsest/evaluation";

import { Grader } from "../components/evaluation/grader";
import {
  gradedCaseIds,
  resolveQueue,
  type DatasetView,
} from "../lib/evaluation-client";

function adjudicationCase(caseId: string, claim: string): BlindEvaluationCase {
  return {
    caseId,
    task: "adjudication",
    runId: "run-one",
    seedDoi: "10.1/seed",
    recordId: `record_${caseId}`,
    packet: {
      markedCitingContext: `Background. ▶ Marlowe et al. ${claim}. ◀ Later text.`,
      familyTrackedClaim: "Seed reported three marker classes.",
      citingPaperTitle: `Citing paper ${caseId}`,
      citedPaperTitle: "Seed paper",
      occurrenceClaims: [
        { claimRecordId: `claim_${caseId}`, claimText: `The seed ${claim}.` },
      ],
      selectedChunks: [
        { chunkId: "chunk_1", text: "We identified three marker classes." },
      ],
    },
  };
}

function finalAnswer(caseId: string, reviewer: string): AnnotationEvent {
  return {
    eventId: `event_${caseId}_${reviewer}`,
    caseId,
    reviewer,
    createdAt: "2026-11-10T12:00:00.000Z",
    status: "final",
    expectedHeadEventId: null,
    exposed: false,
    notes: "",
    value: {
      task: "adjudication",
      verdict: "F",
      packetQuality: "valid",
      evidenceSufficiency: "sufficient",
    },
  };
}

const view: DatasetView = {
  datasetId: "dataset_one",
  name: "Fixture dataset",
  cases: [
    adjudicationCase("a", "reported three marker classes"),
    adjudicationCase("b", "proved nine marker classes"),
  ],
  annotations: [],
  requests: [
    {
      schemaVersion: "evaluation-grading-request-v1",
      requestId: "request_one",
      datasetId: "dataset_one",
      title: "A second look",
      purpose: "Your answers decide the default.",
      caseIds: ["b", "a"],
      createdAt: "2026-11-10T12:00:00.000Z",
    },
  ],
};

function renderGrader(overrides: Partial<Parameters<typeof Grader>[0]> = {}): {
  onSaved: ReturnType<typeof vi.fn>;
} {
  const onSaved = vi.fn(() => Promise.resolve());
  render(
    <Grader
      onReviewerChange={() => undefined}
      onSaved={onSaved}
      queue={resolveQueue(view, { task: "adjudication" })!}
      reviewer="ada"
      view={view}
      {...overrides}
    />,
  );
  return { onSaved };
}

describe("evaluation grader", () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 201 })),
  );

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("highlights the attributed sentence and shows the cited passages", () => {
    renderGrader();
    expect(
      screen.getByText("Marlowe et al. reported three marker classes.").tagName,
    ).toBe("MARK");
    expect(screen.getByText("Citing paper a")).toBeTruthy();
    expect(
      screen.getByText("We identified three marker classes."),
    ).toBeTruthy();
    expect(screen.getByText("0 of 2 graded")).toBeTruthy();
  });

  it("highlights a claim's source text that sits outside the attributed sentence", () => {
    const item = adjudicationCase("a", "reported three marker classes");
    if (item.task !== "adjudication") throw new Error("Expected a verdict");
    const packet = {
      ...item.packet,
      markedCitingContext:
        "They also found nine classes in cortex. ▶ Marlowe et al. reported three marker classes. ◀",
      occurrenceClaims: [
        {
          claimRecordId: "claim_outside",
          claimText: "Nine classes were found in cortex.",
          supportSpanText: "found nine classes in cortex",
        },
        {
          claimRecordId: "claim_inside",
          claimText: "Three marker classes were reported.",
          supportSpanText: "reported three marker classes",
        },
      ],
    };
    renderGrader({ view: { ...view, cases: [{ ...item, packet }] } });
    expect(screen.getByText("found nine classes in cortex").tagName).toBe(
      "MARK",
    );
    expect(screen.getByText("They also").tagName).toBe("SPAN");
    expect(
      screen.getByText("Marlowe et al. reported three marker classes.").tagName,
    ).toBe("MARK");
  });

  it("grades from the keyboard: a key chooses, Enter saves as final", async () => {
    const { onSaved } = renderGrader();
    fireEvent.keyDown(window, { key: "2" });
    expect(
      (screen.getByRole("radio", { name: /Distorted/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/evaluations/dataset_one/annotations");
    expect(JSON.parse(String(init.body))).toEqual({
      caseId: "a",
      reviewer: "ada",
      status: "final",
      expectedHeadEventId: null,
      notes: "",
      value: {
        task: "adjudication",
        verdict: "D",
        packetQuality: "valid",
        evidenceSufficiency: "sufficient",
      },
    });
    await waitFor(() => expect(screen.getByText(/Case 2 of 2/)).toBeTruthy());
  });

  it("accepts the verdict's letter as well as its number", () => {
    renderGrader();
    fireEvent.keyDown(window, { key: "e" });
    expect(
      (screen.getByRole("radio", { name: /Wrong/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("opens on the first case the reviewer has not graded", () => {
    renderGrader({
      view: { ...view, annotations: [finalAnswer("a", "ada")] },
    });
    expect(screen.getByText(/Case 2 of 2/)).toBeTruthy();
    expect(screen.getByText("1 of 2 graded")).toBeTruthy();
  });

  it("walks a request's cases in the order they were asked for", () => {
    renderGrader({ queue: resolveQueue(view, { request: "request_one" })! });
    expect(screen.getByText("A second look")).toBeTruthy();
    expect(screen.getByText("Citing paper b")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Citing paper a")).toBeTruthy();
  });

  it("does not save without an answer or without a reviewer", () => {
    renderGrader();
    fireEvent.keyDown(window, { key: "Enter" });
    cleanup();
    renderGrader({ reviewer: "" });
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Enter your name above to save.")).toBeTruthy();
  });

  it("leaves the keys alone while a note is being typed", () => {
    renderGrader();
    const note = screen.getByLabelText("Note");
    fireEvent.keyDown(note, { key: "2" });
    expect(
      (screen.getByRole("radio", { name: /Distorted/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("says so when every case in the queue is graded", () => {
    renderGrader({
      view: {
        ...view,
        annotations: [finalAnswer("a", "ada"), finalAnswer("b", "ada")],
      },
    });
    expect(screen.getByRole("status").textContent).toContain("All 2 graded.");
  });
});

describe("evaluation queues", () => {
  it("counts a case as graded only when the reviewer's latest answer is final", () => {
    const draft = { ...finalAnswer("a", "ada"), status: "draft" as const };
    expect(gradedCaseIds([finalAnswer("a", "ada")], "ada")).toEqual(
      new Set(["a"]),
    );
    expect(gradedCaseIds([finalAnswer("a", "ada"), draft], "ada")).toEqual(
      new Set(),
    );
    expect(gradedCaseIds([finalAnswer("a", "bo")], "ada")).toEqual(new Set());
  });

  it("resolves a link to a request, a task, or nothing", () => {
    expect(resolveQueue(view, { request: "request_one" })?.caseIds).toEqual([
      "b",
      "a",
    ]);
    expect(resolveQueue(view, { task: "adjudication" })).toMatchObject({
      title: "Verdicts",
      caseIds: ["a", "b"],
    });
    expect(resolveQueue(view, { task: "role" })?.caseIds).toEqual([]);
    expect(resolveQueue(view, {})).toBeUndefined();
  });
});
