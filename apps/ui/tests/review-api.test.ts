import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HumanReviewConflictError } from "palimpsest/contract";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  exportReview: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("@/lib/human-review", () => ({
  appendReviewEventForRun: mocks.append,
  exportReviewForRun: mocks.exportReview,
  getReviewStateForRun: mocks.getState,
}));

vi.mock("@/lib/run-supervisor", () => ({
  ensureRunSupervisorReady: vi.fn(),
}));

import eventsHandler from "@/pages/api/runs/[runId]/review/events";
import exportHandler from "@/pages/api/runs/[runId]/review/export";
import stateHandler from "@/pages/api/runs/[runId]/review/index";

const REPORT_ID = `artifact_${"a".repeat(64)}`;
const REPORT_HASH = "b".repeat(64);

function appendBody(): Record<string, unknown> {
  return {
    reportArtifactId: REPORT_ID,
    reportContentHash: REPORT_HASH,
    expectedHeadEventId: null,
    recordId: "record_1",
    familyId: "family_1",
    reviewer: "reviewer",
    status: "draft",
    assessment: {
      eligibleForAdjudication: "yes",
      inScope: "yes",
      citingSpanValid: "yes",
      citedEvidenceValid: "yes",
      evidenceSufficiency: "sufficient",
      verdictAgreement: "yes",
      notes: "",
    },
  };
}

function request(input: {
  method: string;
  body?: unknown;
  format?: string;
}): NextApiRequest {
  return {
    method: input.method,
    query: {
      runId: "run_1",
      ...(input.format ? { format: input.format } : {}),
    },
    body: input.body,
  } as unknown as NextApiRequest;
}

function response(): {
  response: NextApiResponse;
  statusCode: () => number | undefined;
  body: () => unknown;
  headers: () => Map<string, string>;
} {
  let statusCode: number | undefined;
  let body: unknown;
  const headers = new Map<string, string>();
  const apiResponse = {
    status(code: number) {
      statusCode = code;
      return apiResponse;
    },
    json(value: unknown) {
      body = value;
      return apiResponse;
    },
    send(value: unknown) {
      body = value;
      return apiResponse;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return apiResponse;
    },
  } as unknown as NextApiResponse;
  return {
    response: apiResponse,
    statusCode: () => statusCode,
    body: () => body,
    headers: () => headers,
  };
}

describe("human review API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects client-supplied canonical validation data", async () => {
    const result = response();
    await eventsHandler(
      request({
        method: "POST",
        body: {
          ...appendBody(),
          citationContext: "untrusted",
          knownCitedChunkIds: ["untrusted"],
        },
      }),
      result.response,
    );

    expect(result.statusCode()).toBe(400);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("returns structured conflicts and successful append state", async () => {
    mocks.append.mockImplementationOnce(() => {
      throw new HumanReviewConflictError(
        "stale_report_lineage",
        "stale report",
      );
    });
    const conflict = response();
    await eventsHandler(
      request({ method: "POST", body: appendBody() }),
      conflict.response,
    );
    expect(conflict.statusCode()).toBe(409);
    expect(conflict.body()).toMatchObject({
      code: "stale_report_lineage",
      error: "stale report",
    });

    mocks.append.mockReturnValueOnce({ event: {}, state: { records: [] } });
    const success = response();
    await eventsHandler(
      request({ method: "POST", body: appendBody() }),
      success.response,
    );
    expect(success.statusCode()).toBe(201);
    expect(mocks.append).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ recordId: "record_1" }),
    );
  });

  it("serves current state and typed JSON/CSV downloads", async () => {
    mocks.getState.mockReturnValue({ headEventId: null, records: [] });
    const state = response();
    await stateHandler(request({ method: "GET" }), state.response);
    expect(state.statusCode()).toBe(200);
    expect(state.body()).toEqual({ headEventId: null, records: [] });

    mocks.exportReview.mockReturnValue({
      contentType: "text/csv; charset=utf-8",
      filename: "human-review-run_1.csv",
      body: "recordId\n",
    });
    const exported = response();
    await exportHandler(
      request({ method: "GET", format: "csv" }),
      exported.response,
    );
    expect(exported.statusCode()).toBe(200);
    expect(exported.headers().get("Content-Type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(exported.headers().get("Content-Disposition")).toContain(
      "human-review-run_1.csv",
    );
  });
});
