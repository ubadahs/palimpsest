import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HumanReviewConflictError,
  type AppendHumanReviewRequest,
  type HumanAssessment,
} from "../../src/contract/human-review.js";
import {
  appendHumanReviewEventForRun,
  getHumanReviewState,
  loadHumanReviewExport,
  renderHumanReviewCsv,
  resolveHumanReviewEventsPath,
} from "../../src/review/human-review-store.js";

const REPORT_ID = `artifact_${"a".repeat(64)}`;
const REPORT_HASH = "b".repeat(64);

function assessment(overrides: Partial<HumanAssessment> = {}): HumanAssessment {
  return {
    eligibleForAdjudication: "yes",
    inScope: "yes",
    citingSpanValid: "yes",
    citedEvidenceValid: "yes",
    evidenceSufficiency: "sufficient",
    verdictAgreement: "yes",
    notes: "Looks good",
    ...overrides,
  };
}

function request(
  overrides: Partial<AppendHumanReviewRequest> = {},
): AppendHumanReviewRequest {
  return {
    reportArtifactId: REPORT_ID,
    reportContentHash: REPORT_HASH,
    expectedHeadEventId: null,
    recordId: "record_1",
    familyId: "family_1",
    reviewer: "ubadah",
    status: "draft",
    assessment: assessment(),
    ...overrides,
  };
}

function appendInput(
  runRoot: string,
  reviewRequest = request(),
  totalRecords = 1,
): Parameters<typeof appendHumanReviewEventForRun>[0] {
  return {
    runId: "run_1",
    runRoot,
    totalRecords,
    currentReport: {
      artifactId: REPORT_ID,
      contentHash: REPORT_HASH,
    },
    canonicalRecord: {
      recordId: reviewRequest.recordId,
      familyId: reviewRequest.familyId,
      citationContext: "Context with a citing claim span here.",
      knownCitedChunkIds: ["chunk_1", "chunk_2"],
    },
    request: reviewRequest,
  };
}

describe("human review store", () => {
  let runRoot = "";

  beforeEach(() => {
    runRoot = mkdtempSync(join(tmpdir(), "palimpsest-review-"));
  });

  afterEach(() => {
    rmSync(runRoot, { recursive: true, force: true });
  });

  it("appends events atomically, projects latest state, and supports supersession", () => {
    const first = appendHumanReviewEventForRun(
      appendInput(runRoot, request(), 2),
    );
    expect(first.state.progress).toEqual({
      totalRecords: 2,
      unreviewed: 1,
      draft: 1,
      final: 0,
    });
    expect(first.state.headEventId).toBe(first.event.eventId);

    const second = appendHumanReviewEventForRun(
      appendInput(
        runRoot,
        request({
          expectedHeadEventId: first.event.eventId,
          supersedesEventId: first.event.eventId,
          status: "final",
          assessment: assessment({
            verdictAgreement: "no",
            overriddenVerdict: "D",
            notes: "Override to D",
          }),
        }),
        2,
      ),
    );

    expect(second.state.records).toHaveLength(1);
    expect(second.state.records[0]?.status).toBe("final");
    expect(second.state.records[0]?.revisionCount).toBe(2);
    expect(second.state.records[0]?.assessment.overriddenVerdict).toBe("D");
    expect(second.state.progress.final).toBe(1);
    expect(second.state.progress.draft).toBe(0);

    const eventsPath = resolveHumanReviewEventsPath({
      runRoot,
      reportArtifactId: REPORT_ID,
    });
    const persisted = JSON.parse(readFileSync(eventsPath, "utf8")) as {
      events: unknown[];
    };
    expect(persisted.events).toHaveLength(2);
  });

  it("rejects concurrent stale head writes", () => {
    const first = appendHumanReviewEventForRun(appendInput(runRoot));

    expect(() =>
      appendHumanReviewEventForRun(
        appendInput(
          runRoot,
          request({
            expectedHeadEventId: null,
            recordId: "record_2",
          }),
        ),
      ),
    ).toThrow(HumanReviewConflictError);

    expect(() =>
      appendHumanReviewEventForRun(
        appendInput(
          runRoot,
          request({
            expectedHeadEventId: first.event.eventId,
            reportContentHash: "c".repeat(64),
          }),
        ),
      ),
    ).toThrow(/stale report artifact\/hash/i);
  });

  it("rejects record identities that do not match the current report", () => {
    const input = appendInput(runRoot);
    expect(() =>
      appendHumanReviewEventForRun({
        ...input,
        canonicalRecord: {
          ...input.canonicalRecord,
          familyId: "family_current",
        },
      }),
    ).toThrow(/identity does not match/i);
  });

  it("validates corrections against canonical context and Evidence chunks", () => {
    expect(() =>
      appendHumanReviewEventForRun(
        appendInput(
          runRoot,
          request({
            assessment: assessment({
              citingSpanValid: "no",
              correctedCitingSpan: {
                text: "citing claim span",
                charOffsetStart: 15,
                charOffsetEnd: 32,
              },
            }),
          }),
        ),
      ),
    ).not.toThrow();

    expect(() =>
      appendHumanReviewEventForRun(
        appendInput(
          runRoot,
          request({
            expectedHeadEventId: getHumanReviewState({
              runId: "run_1",
              runRoot,
              reportArtifactId: REPORT_ID,
              reportContentHash: REPORT_HASH,
              totalRecords: 1,
            }).headEventId,
            recordId: "record_2",
            assessment: assessment({
              citingSpanValid: "no",
              correctedCitingSpan: {
                text: "wrong text",
                charOffsetStart: 0,
                charOffsetEnd: 10,
              },
            }),
          }),
        ),
      ),
    ).toThrow(/exact substring/i);

    expect(() =>
      appendHumanReviewEventForRun(
        appendInput(
          runRoot,
          request({
            expectedHeadEventId: getHumanReviewState({
              runId: "run_1",
              runRoot,
              reportArtifactId: REPORT_ID,
              reportContentHash: REPORT_HASH,
              totalRecords: 1,
            }).headEventId,
            recordId: "record_3",
            assessment: assessment({
              citedEvidenceValid: "no",
              correctedCitedChunkIds: ["chunk_unknown"],
            }),
          }),
        ),
      ),
    ).toThrow(/known Evidence chunk/i);
  });

  it("rejects path escape and malformed files", () => {
    expect(() =>
      resolveHumanReviewEventsPath({
        runRoot,
        reportArtifactId: "../escape",
      }),
    ).toThrow(/Invalid reportArtifactId/i);

    const eventsPath = resolveHumanReviewEventsPath({
      runRoot,
      reportArtifactId: REPORT_ID,
    });
    mkdirSync(join(runRoot, "review", REPORT_ID), { recursive: true });
    writeFileSync(eventsPath, "{not-json", "utf8");
    expect(() =>
      getHumanReviewState({
        runId: "run_1",
        runRoot,
        reportArtifactId: REPORT_ID,
        reportContentHash: REPORT_HASH,
        totalRecords: 1,
      }),
    ).toThrow(/Malformed human review event log/i);
  });

  it("exports JSON bundles and CSV with machine + human labels", () => {
    appendHumanReviewEventForRun(
      appendInput(
        runRoot,
        request({
          status: "final",
          assessment: assessment({
            citingSpanValid: "no",
            correctedCitingSpan: {
              text: "citing claim span",
              charOffsetStart: 15,
              charOffsetEnd: 32,
            },
            citedEvidenceValid: "no",
            correctedCitedChunkIds: ["chunk_2"],
            verdictAgreement: "no",
            overriddenVerdict: "E",
            notes: "Error",
          }),
        }),
      ),
    );

    const bundle = loadHumanReviewExport({
      runId: "run_1",
      runRoot,
      reportArtifactId: REPORT_ID,
      reportContentHash: REPORT_HASH,
      machineRecords: [
        {
          recordId: "record_1",
          familyId: "family_1",
          snapshot: {
            trackedClaim: "Tracked claim",
            evaluatedClaimText: "Evaluated claim",
            citingPaperTitle: "Citing paper",
            citationContext: "Context with a citing claim span here.",
            evidencePassages: [{ chunkId: "chunk_1", text: "Evidence" }],
            adjudicationStatus: "adjudicated",
            verdict: "F",
          },
        },
      ],
    });

    expect(bundle.events).toHaveLength(1);
    expect(bundle.records[0]?.human?.assessment.overriddenVerdict).toBe("E");
    const csv = renderHumanReviewCsv(bundle.records);
    expect(csv).toContain("recordId,familyId,reviewStatus");
    expect(csv).toContain("correctedCitingSpanText");
    expect(csv).toContain("machineTrackedClaim");
    expect(csv).toContain("record_1");
    expect(csv).toContain("citing claim span");
    expect(csv).toContain("chunk_2");
    expect(csv).toContain("Tracked claim");
    expect(csv).toContain("E");
    expect(csv).toContain("F");
  });
});
