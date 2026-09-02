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
    humanVerdict: "F",
    blinded: true,
    mutationKinds: [],
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
            humanVerdict: "D",
            mutationKinds: ["scope_narrowed"],
            notes: "Override to D",
          }),
        }),
        2,
      ),
    );

    expect(second.state.records).toHaveLength(1);
    expect(second.state.records[0]?.status).toBe("final");
    expect(second.state.records[0]?.revisionCount).toBe(2);
    expect(second.state.records[0]?.assessment.humanVerdict).toBe("D");
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
            humanVerdict: "E",
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
          citingPaperId: "citing_paper_1",
          claimTexts: ["Evaluated claim"],
          snapshot: {
            trackedClaim: "Tracked claim",
            evaluatedClaimText: "Evaluated claim",
            citingPaperId: "citing_paper_1",
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
    expect(bundle.records[0]?.human?.assessment.humanVerdict).toBe("E");
    // Human E against machine F: disagreement, so the record cannot be valid
    // end to end even though the packet itself was sound.
    expect(bundle.records[0]?.calibration).toEqual({
      labelAgreement: "no",
      evidenceSufficiency: "yes",
      endToEndValid: "no",
      blinded: true,
    });

    const csv = renderHumanReviewCsv(bundle.units);
    expect(csv.split("\n")[0]).toBe(
      "familyId,citingPaperId,citingPaperTitle,trackedClaim,recordIds,recordCount,reviewedRecordCount,machineVerdicts,humanVerdicts,machineMutationKinds,humanMutationKinds,labelAgreement,evidenceSufficiency,endToEndValid,blinded,reviewers,reviewStatuses,notes",
    );
    expect(csv).toContain("family_1");
    expect(csv).toContain("record_1");
    expect(csv).toContain("Tracked claim");
    expect(csv).toContain("F");
    expect(csv).toContain("E");
    expect(csv).toContain("true");
  });

  it("records a review taken with the machine judgment hidden as blinded", () => {
    appendHumanReviewEventForRun(
      appendInput(
        runRoot,
        request({
          status: "final",
          assessment: assessment({ humanVerdict: "F", blinded: true }),
        }),
      ),
    );
    const bundle = loadHumanReviewExport({
      runId: "run_1",
      runRoot,
      reportArtifactId: REPORT_ID,
      reportContentHash: REPORT_HASH,
      machineRecords: [machineRecord("record_1", { verdict: "F" })],
    });

    expect(bundle.records[0]?.human?.assessment.blinded).toBe(true);
    expect(bundle.records[0]?.calibration).toEqual({
      labelAgreement: "yes",
      evidenceSufficiency: "yes",
      endToEndValid: "yes",
      blinded: true,
    });
    expect(bundle.units[0]?.calibration?.blinded).toBe(true);
  });

  it("collapses two records of one claim unit into one row keeping both labels", () => {
    const first = appendHumanReviewEventForRun(
      appendInput(
        runRoot,
        request({
          recordId: "record_1",
          status: "final",
          assessment: assessment({ humanVerdict: "F", blinded: true }),
        }),
      ),
    );
    appendHumanReviewEventForRun(
      appendInput(
        runRoot,
        request({
          recordId: "record_2",
          expectedHeadEventId: first.event.eventId,
          status: "final",
          assessment: assessment({
            humanVerdict: "D",
            blinded: false,
            mutationKinds: ["scope_narrowed"],
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
        machineRecord("record_1", { verdict: "F" }),
        machineRecord("record_2", { verdict: "F" }),
      ],
    });

    expect(bundle.records).toHaveLength(2);
    expect(bundle.units).toHaveLength(1);
    const unit = bundle.units[0]!;
    expect(unit.recordIds).toEqual(["record_1", "record_2"]);
    expect(unit.humanVerdicts).toEqual(["F", "D"]);
    expect(unit.machineVerdicts).toEqual(["F"]);
    expect(unit.humanMutationKinds).toEqual(["scope_narrowed"]);
    // One record disagreed and one review was not blinded: the unit takes the
    // weaker of each, so a single unblinded label cannot pass as blinded.
    expect(unit.calibration).toEqual({
      labelAgreement: "no",
      evidenceSufficiency: "yes",
      endToEndValid: "no",
      blinded: false,
    });
    expect(renderHumanReviewCsv(bundle.units).trim().split("\n")).toHaveLength(
      2,
    );
  });
});

/** Same family, same citing paper, same claim text: one unit, many records. */
function machineRecord(
  recordId: string,
  snapshot: Record<string, unknown>,
): Parameters<typeof loadHumanReviewExport>[0]["machineRecords"][number] {
  return {
    recordId,
    familyId: "family_1",
    citingPaperId: "citing_paper_1",
    claimTexts: ["Evaluated claim"],
    snapshot: {
      trackedClaim: "Tracked claim",
      evaluatedClaimText: "Evaluated claim",
      citingPaperId: "citing_paper_1",
      citingPaperTitle: "Citing paper",
      adjudicationStatus: "adjudicated",
      ...snapshot,
    },
  };
}
