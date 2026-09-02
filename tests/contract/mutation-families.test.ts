import { describe, expect, it } from "vitest";

import type { ReportInspectorRecordRow } from "../../src/contract/inspector-payloads.js";
import { buildReportInspectorFamilies } from "../../src/contract/selectors.js";

function record(
  overrides: Partial<ReportInspectorRecordRow> &
    Pick<
      ReportInspectorRecordRow,
      "recordId" | "familyId" | "adjudicationStatus"
    >,
): ReportInspectorRecordRow {
  return {
    citationOccurrenceId: "mention_1",
    trackedClaim: "Tracked claim A",
    evaluatedClaimText: "Evaluated claim",
    seedId: "seed_1",
    seedTitle: "Seed paper title",
    seedDoi: "10.1000/seed",
    citingPaperId: "citing_paper_1",
    citingPaperTitle: "Citing paper",
    citingPaperYear: 2020,
    citationContext: "Context with a citing claim span.",
    classificationStatus: "classified",
    groundingStatus: "grounded",
    verifiedSeedGroundingSpans: [
      {
        text: "Seed grounding span.",
        blockId: "block_1",
        blockKind: "body_paragraph",
        charOffsetStart: 0,
        charOffsetEnd: 21,
      },
    ],
    occurrenceClaims: [
      {
        claimRecordId: "claim_1",
        extractedClaimText: "Evaluated claim",
        supportSpan: {
          text: "citing claim span",
          charOffsetStart: 14,
          charOffsetEnd: 31,
        },
      },
    ],
    retrievalStatus: "retrieved",
    rerankStatus: "disabled",
    evidencePassages: [],
    ...overrides,
  };
}

describe("buildReportInspectorFamilies", () => {
  it("groups by familyId, enriches seed grounding, and sorts chronologically", () => {
    const records = [
      record({
        recordId: "rec_b",
        familyId: "family_a",
        citingPaperTitle: "Beta paper",
        citingPaperYear: 2022,
        adjudicationStatus: "adjudicated",
        verdict: "D",
      }),
      record({
        recordId: "rec_a",
        familyId: "family_a",
        citingPaperTitle: "Alpha paper",
        citingPaperYear: 2019,
        adjudicationStatus: "adjudicated",
        verdict: "F",
      }),
      record({
        recordId: "rec_c",
        familyId: "family_b",
        trackedClaim: "Tracked claim B",
        seedTitle: "Other seed",
        citingPaperTitle: "Gamma paper",
        citingPaperYear: 2021,
        adjudicationStatus: "not_adjudicated",
        gateCode: "insufficient_evidence",
        verifiedSeedGroundingSpans: [],
      }),
      record({
        recordId: "rec_d",
        familyId: "family_a",
        citingPaperTitle: "Alpha paper",
        citingPaperYear: 2019,
        adjudicationStatus: "adjudication_failed",
        failureCode: "provider_error",
      }),
    ];

    const families = buildReportInspectorFamilies(records);

    expect(families.map((family) => family.familyId)).toEqual([
      "family_a",
      "family_b",
    ]);

    const familyA = families[0]!;
    expect(familyA.trackedClaim).toBe("Tracked claim A");
    expect(familyA.seedTitle).toBe("Seed paper title");
    expect(familyA.seedDoi).toBe("10.1000/seed");
    expect(familyA.verifiedSeedGroundingSpans).toHaveLength(1);
    expect(familyA.recordCount).toBe(3);
    expect(familyA.records.map((row) => row.recordId)).toEqual([
      "rec_a",
      "rec_d",
      "rec_b",
    ]);
    expect(familyA.verdictCounts).toEqual({
      F: 1,
      D: 1,
      E: 0,
      U: 0,
      not_adjudicated: 0,
      failed: 1,
    });

    const familyB = families[1]!;
    expect(familyB.recordCount).toBe(1);
    expect(familyB.verdictCounts.not_adjudicated).toBe(1);
  });

  it("uses stable family ordering by tracked claim then familyId", () => {
    const families = buildReportInspectorFamilies([
      record({
        recordId: "r1",
        familyId: "family_z",
        trackedClaim: "Same claim",
        adjudicationStatus: "adjudicated",
        verdict: "U",
      }),
      record({
        recordId: "r2",
        familyId: "family_a",
        trackedClaim: "Same claim",
        adjudicationStatus: "adjudicated",
        verdict: "E",
      }),
    ]);

    expect(families.map((family) => family.familyId)).toEqual([
      "family_a",
      "family_z",
    ]);
  });

  it("uses locale-independent code-point ordering for equal-year titles", () => {
    const [family] = buildReportInspectorFamilies([
      record({
        recordId: "record_accented",
        familyId: "family_a",
        citingPaperTitle: "Ångström paper",
        citingPaperYear: 2020,
        adjudicationStatus: "adjudicated",
        verdict: "F",
      }),
      record({
        recordId: "record_ascii",
        familyId: "family_a",
        citingPaperTitle: "Zulu paper",
        citingPaperYear: 2020,
        adjudicationStatus: "adjudicated",
        verdict: "F",
      }),
    ]);

    expect(family?.records.map((item) => item.recordId)).toEqual([
      "record_ascii",
      "record_accented",
    ]);
  });
});
