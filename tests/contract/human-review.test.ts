import { describe, expect, it } from "vitest";

import {
  appendHumanReviewRequestSchema,
  assertCorrectedCitingSpanInContext,
  humanAssessmentSchema,
  humanReviewEventLogSchema,
  HumanReviewConflictError,
  projectHumanReviewRecords,
  type HumanReviewEvent,
} from "../../src/contract/human-review.js";

describe("human review contracts", () => {
  it("requires corrections only when validity is no", () => {
    expect(
      humanAssessmentSchema.safeParse({
        eligibleForAdjudication: "yes",
        inScope: "yes",
        citingSpanValid: "no",
        citedEvidenceValid: "yes",
        evidenceSufficiency: "limited",
        verdictAgreement: "not_applicable",
        notes: "",
      }).success,
    ).toBe(false);

    expect(
      humanAssessmentSchema.safeParse({
        eligibleForAdjudication: "yes",
        inScope: "yes",
        citingSpanValid: "no",
        correctedCitingSpan: {
          text: "span",
          charOffsetStart: 0,
          charOffsetEnd: 4,
        },
        citedEvidenceValid: "no",
        correctedCitedChunkIds: ["chunk_1"],
        evidenceSufficiency: "limited",
        verdictAgreement: "no",
        overriddenVerdict: "E",
        notes: "corrections",
      }).success,
    ).toBe(true);

    expect(
      humanAssessmentSchema.safeParse({
        eligibleForAdjudication: "yes",
        inScope: "yes",
        citingSpanValid: "yes",
        correctedCitingSpan: {
          text: "span",
          charOffsetStart: 0,
          charOffsetEnd: 4,
        },
        citedEvidenceValid: "yes",
        evidenceSufficiency: "sufficient",
        verdictAgreement: "yes",
        notes: "",
      }).success,
    ).toBe(false);
  });

  it("keeps canonical context and Evidence chunk lists server-owned", () => {
    const request = {
      reportArtifactId: `artifact_${"a".repeat(64)}`,
      reportContentHash: "b".repeat(64),
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

    expect(appendHumanReviewRequestSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      appendHumanReviewRequestSchema.safeParse({
        ...request,
        citationContext: "client-controlled context",
        knownCitedChunkIds: ["client-controlled-chunk"],
      }).success,
    ).toBe(false);
  });

  it("checks exact citing-span offsets against citation context", () => {
    const context = "abcDEFGhi";
    expect(() =>
      assertCorrectedCitingSpanInContext(
        { text: "DEF", charOffsetStart: 3, charOffsetEnd: 6 },
        context,
      ),
    ).not.toThrow();
    expect(() =>
      assertCorrectedCitingSpanInContext(
        { text: "XYZ", charOffsetStart: 3, charOffsetEnd: 6 },
        context,
      ),
    ).toThrow(HumanReviewConflictError);
  });

  it("projects latest record state with revision counts", () => {
    const events: HumanReviewEvent[] = [
      {
        eventId: `hrevent_${"1".repeat(32)}`,
        recordId: "r1",
        familyId: "f1",
        reviewer: "a",
        createdAt: "2026-08-08T00:00:00.000Z",
        status: "draft",
        assessment: {
          eligibleForAdjudication: "yes",
          inScope: "yes",
          citingSpanValid: "yes",
          citedEvidenceValid: "yes",
          evidenceSufficiency: "sufficient",
          verdictAgreement: "yes",
          notes: "v1",
        },
      },
      {
        eventId: `hrevent_${"2".repeat(32)}`,
        recordId: "r1",
        familyId: "f1",
        reviewer: "a",
        createdAt: "2026-08-08T01:00:00.000Z",
        status: "final",
        supersedesEventId: `hrevent_${"1".repeat(32)}`,
        assessment: {
          eligibleForAdjudication: "yes",
          inScope: "yes",
          citingSpanValid: "yes",
          citedEvidenceValid: "yes",
          evidenceSufficiency: "sufficient",
          verdictAgreement: "no",
          overriddenVerdict: "D",
          notes: "v2",
        },
      },
    ];

    const projected = projectHumanReviewRecords(events);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.revisionCount).toBe(2);
    expect(projected[0]?.status).toBe("final");
    expect(projected[0]?.assessment.notes).toBe("v2");
  });

  it("rejects cross-family or non-head supersession in persisted logs", () => {
    const baseAssessment = {
      eligibleForAdjudication: "yes" as const,
      inScope: "yes" as const,
      citingSpanValid: "yes" as const,
      citedEvidenceValid: "yes" as const,
      evidenceSufficiency: "sufficient" as const,
      verdictAgreement: "yes" as const,
      notes: "",
    };
    const firstId = `hrevent_${"1".repeat(32)}`;
    const secondId = `hrevent_${"2".repeat(32)}`;
    const result = humanReviewEventLogSchema.safeParse({
      schemaVersion: "human-review-events-v1",
      lineage: {
        runId: "run_1",
        reportArtifactId: `artifact_${"a".repeat(64)}`,
        reportContentHash: "b".repeat(64),
      },
      events: [
        {
          eventId: firstId,
          recordId: "record_1",
          familyId: "family_1",
          reviewer: "reviewer",
          createdAt: "2026-08-08T00:00:00.000Z",
          status: "draft",
          assessment: baseAssessment,
        },
        {
          eventId: secondId,
          recordId: "record_1",
          familyId: "family_2",
          reviewer: "reviewer",
          createdAt: "2026-08-08T01:00:00.000Z",
          status: "final",
          supersedesEventId: firstId,
          assessment: baseAssessment,
        },
        {
          eventId: `hrevent_${"3".repeat(32)}`,
          recordId: "record_1",
          familyId: "family_1",
          reviewer: "reviewer",
          createdAt: "2026-08-08T02:00:00.000Z",
          status: "final",
          supersedesEventId: firstId,
          assessment: baseAssessment,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
