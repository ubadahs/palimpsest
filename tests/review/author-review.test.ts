import { describe, expect, it } from "vitest";

import type { ReportInspectorRecordRow } from "../../src/contract/inspector-payloads.js";
import {
  inAuthorTerms,
  readAuthorReviewFile,
  selectAuthorReviewItems,
  type AuthorReviewData,
} from "../../src/review/author-review.js";
import { renderAuthorReviewPage } from "../../src/review/author-review-page.js";

function row(
  overrides: Partial<ReportInspectorRecordRow> & {
    recordId: string;
    verdict?: ReportInspectorRecordRow["verdict"];
    sentence?: string;
  },
): ReportInspectorRecordRow {
  const sentence = overrides.sentence ?? `Claim made in ${overrides.recordId}.`;
  const paragraph = `Some lead-in. ${sentence} A closing line.`;
  const start = paragraph.indexOf(sentence);
  return {
    familyId: "family-1",
    citationOccurrenceId: `occ-${overrides.recordId}`,
    familyClaim: "A finding",
    evaluatedClaimText: sentence,
    seedId: "seed-1",
    seedTitle: "A Seed Paper",
    citingPaperId: `paper-${overrides.recordId}`,
    citingPaperTitle: `Citer ${overrides.recordId}`,
    citingPaperYear: 2022,
    citationContext: paragraph,
    classificationStatus: "classified",
    verifiedSeedGroundingSpans: [],
    occurrenceClaims: [
      {
        claimRecordId: `claim-${overrides.recordId}`,
        extractedClaimText: sentence,
        supportSpan: {
          text: sentence,
          charOffsetStart: start,
          charOffsetEnd: start + sentence.length,
        },
      },
    ],
    retrievalStatus: "retrieved",
    rerankStatus: "completed",
    evidencePassages: [],
    seedQuotes: [{ quote: "What the seed found.", blockKind: "paragraph" }],
    adjudicationStatus: "adjudicated",
    rationale: "The cited paper supports the core of it.",
    ...overrides,
  } as ReportInspectorRecordRow;
}

describe("selectAuthorReviewItems", () => {
  const rows = [
    row({ recordId: "d1", verdict: "D" }),
    row({ recordId: "e1", verdict: "E" }),
    ...Array.from({ length: 6 }, (_, index) =>
      row({ recordId: `f${String(index)}`, verdict: "F" }),
    ),
    row({ recordId: "gated", adjudicationStatus: "not_adjudicated" }),
  ];

  it("keeps every flagged restatement and samples the faithful ones", () => {
    const { items, restatementCount } = selectAuthorReviewItems({
      rows,
      faithfulSample: 2,
      sampleKey: "report-hash",
    });
    expect(restatementCount).toBe(8);
    expect(items.map((item) => item.ours.verdict).sort()).toEqual([
      "D",
      "E",
      "F",
      "F",
    ]);
    // The same report always gives the same file.
    expect(
      selectAuthorReviewItems({
        rows,
        faithfulSample: 2,
        sampleKey: "report-hash",
      }).items,
    ).toEqual(items);
  });

  it("keeps a sentence whatever parser debris it carries", () => {
    // Filtering on how text looks would skew the sample toward papers whose
    // PDFs parse cleanly; debris stays visible instead.
    const { items } = selectAuthorReviewItems({
      rows: [
        row({
          recordId: "debris",
          verdict: "F",
          sentence: "as well * someone@example.edu as properties of DM [16].",
        }),
      ],
      faithfulSample: 5,
      sampleKey: "k",
    });
    expect(items).toHaveLength(1);
  });

  it("asks once about a sentence two papers print word for word, keeping both", () => {
    const reprinted =
      "Lorn expression is driven entirely by Kestrin input [7].";
    const { items } = selectAuthorReviewItems({
      rows: [
        row({ recordId: "notes", verdict: "F", sentence: reprinted }),
        row({ recordId: "article", verdict: "D", sentence: reprinted }),
      ],
      faithfulSample: 0,
      sampleKey: "k",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      citingPaperTitle: "Citer article",
      alsoIn: [{ title: "Citer notes", year: 2022 }],
      records: [
        { recordId: "article", verdict: "D" },
        { recordId: "notes", verdict: "F" },
      ],
      ours: { verdict: "D" },
    });
  });

  it("asks once about a sentence restating two findings, keeping both records", () => {
    const shared = "The same sentence restates two findings.";
    const { items } = selectAuthorReviewItems({
      rows: [
        row({
          recordId: "a",
          verdict: "F",
          sentence: shared,
          citingPaperId: "p",
        }),
        row({
          recordId: "b",
          verdict: "D",
          sentence: shared,
          citingPaperId: "p",
          familyId: "family-2",
        }),
      ],
      faithfulSample: 5,
      sampleKey: "k",
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.records.map((record) => record.recordId)).toEqual([
      "a",
      "b",
    ]);
    expect(items[0]?.alsoIn).toBeUndefined();
    expect(items[0]?.ours.verdict).toBe("D");
  });
});

describe("selectAuthorReviewItems exclusions and markers", () => {
  const rows = [
    row({ recordId: "d1", verdict: "D" }),
    ...Array.from({ length: 4 }, (_, index) =>
      row({ recordId: `f${String(index)}`, verdict: "F" }),
    ),
  ];
  const select = (excludeItemIds: string[] = []) =>
    selectAuthorReviewItems({
      rows,
      faithfulSample: 2,
      sampleKey: "k",
      excludeItemIds,
    });

  it("replaces an excluded faithful item and names unknown ids", () => {
    const before = select().items;
    const dropped = before.find((item) => item.ours.verdict === "F")!;
    const after = select([dropped.itemId, "no-such-item"]);
    expect(after.items).toHaveLength(before.length);
    expect(after.items.map((item) => item.itemId)).not.toContain(
      dropped.itemId,
    );
    expect(after.unknownExclusions).toEqual(["no-such-item"]);
  });

  it("draws faithful items from different citing papers first", () => {
    const { items } = selectAuthorReviewItems({
      rows: [
        row({
          recordId: "f1",
          verdict: "F",
          citingPaperId: "same",
          citingPaperTitle: "same",
        }),
        row({
          recordId: "f2",
          verdict: "F",
          citingPaperId: "same",
          citingPaperTitle: "same",
        }),
        row({
          recordId: "f3",
          verdict: "F",
          citingPaperId: "other",
          citingPaperTitle: "other",
        }),
      ],
      faithfulSample: 2,
      sampleKey: "k",
    });
    expect(items.map((item) => item.citingPaperTitle).sort()).toEqual([
      "other",
      "same",
    ]);
  });

  it("carries where the author's citation marker sits", () => {
    const marked = row({
      recordId: "m",
      verdict: "E",
      sentence: "Shown in [7].",
    });
    const start = marked.citationContext.indexOf("[7]");
    const { items } = selectAuthorReviewItems({
      rows: [
        {
          ...marked,
          citationMarkerSpan: {
            charOffsetStart: start,
            charOffsetEnd: start + 3,
          },
        },
      ],
      faithfulSample: 0,
      sampleKey: "k",
    });
    expect(items[0]?.markerSpan).toEqual({ start, end: start + 3 });
  });
});

describe("inAuthorTerms", () => {
  it("says 'your paper' where the rationale says 'the cited paper'", () => {
    expect(
      inAuthorTerms(
        "The cited paper's abstract supports the core of the claim; the cited paper says less.",
      ),
    ).toBe(
      "Your paper's abstract supports the core of the claim; your paper says less.",
    );
  });
});

describe("author review file", () => {
  const data: AuthorReviewData = {
    schemaVersion: "author-review-v1",
    lineage: {
      runId: "run-1",
      reportArtifactId: "artifact_1",
      reportContentHash: "hash",
    },
    seedTitle: "A </script> title",
    restatementCount: 3,
    items: selectAuthorReviewItems({
      rows: [row({ recordId: "d1", verdict: "D" })],
      faithfulSample: 0,
      sampleKey: "k",
    }).items,
  };

  it("reads back what it was written with, whatever the data contains", () => {
    const itemId = data.items[0]!.itemId;
    const answers = {
      [itemId]: {
        first: "changed" as const,
        final: "accurate" as const,
        note: "<b>ok</b>",
      },
    };
    expect(readAuthorReviewFile(renderAuthorReviewPage(data, answers))).toEqual(
      {
        ok: true,
        data,
        answers,
      },
    );
  });

  it("rejects answers for items the file does not hold", () => {
    const result = readAuthorReviewFile(
      renderAuthorReviewPage(data, {
        other: { first: "wrong", final: "wrong", note: "" },
      }),
    );
    expect(result).toMatchObject({ ok: false });
  });
});
