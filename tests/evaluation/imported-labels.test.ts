import { describe, expect, it } from "vitest";

import {
  importedUnitVerdicts,
  type ImportedReviews,
} from "../../src/evaluation/imported-labels.js";
import type { StoredAuthorReview } from "../../src/review/author-review.js";

const lineage = {
  runId: "run-1",
  reportArtifactId: `artifact_${"a".repeat(64)}`,
  reportContentHash: "b".repeat(64),
};

function authorItem(
  recordIds: string[],
  answer: StoredAuthorReview["items"][number]["answer"],
): StoredAuthorReview["items"][number] {
  return {
    itemId: recordIds.join("+"),
    records: recordIds.map((recordId) => ({ recordId, verdict: "D" })),
    shownVerdict: "D",
    answer,
  };
}

function imported(
  items: StoredAuthorReview["items"],
  events: unknown[] = [],
): ImportedReviews {
  return [
    {
      lineage,
      events,
      authorReviews: [
        {
          schemaVersion: "author-review-answers-v1",
          lineage,
          importedAt: "2026-11-14T20:04:20.194Z",
          items,
        },
      ],
      recordUnitKeys: {
        r1: "unit-1",
        r2: "unit-2",
        r3: "unit-3",
        reprint: "unit-4",
      },
    },
  ];
}

describe("author answers as imported labels", () => {
  it("labels with the final answer, exposed only when it moved after the reveal", () => {
    const verdicts = importedUnitVerdicts(
      imported([
        authorItem(["r1"], { first: "accurate", final: "accurate", note: "" }),
        authorItem(["r2"], { first: "accurate", final: "wrong", note: "" }),
      ]),
    );
    expect(verdicts.get("unit-1")).toEqual({ verdict: "F", exposed: false });
    expect(verdicts.get("unit-2")).toEqual({ verdict: "E", exposed: true });
  });

  it("gives no label for 'not sure' or an unanswered item", () => {
    const verdicts = importedUnitVerdicts(
      imported([
        authorItem(["r1"], { first: "accurate", final: "unsure", note: "" }),
        authorItem(["r2"], null),
      ]),
    );
    expect(verdicts.size).toBe(0);
  });

  it("applies one answer to every unit its sentence produced", () => {
    const verdicts = importedUnitVerdicts(
      imported([
        authorItem(["r3", "reprint"], {
          first: "changed",
          final: "changed",
          note: "",
        }),
      ]),
    );
    expect(verdicts.get("unit-3")?.verdict).toBe("D");
    expect(verdicts.get("unit-4")?.verdict).toBe("D");
  });

  it("refuses an answer about a record the dataset does not hold", () => {
    expect(() =>
      importedUnitVerdicts(
        imported([
          authorItem(["unknown"], {
            first: "wrong",
            final: "wrong",
            note: "",
          }),
        ]),
      ),
    ).toThrow(/unknown record/);
  });
});
