import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  loadTwoHopReview,
  ReviewConflict,
  saveTwoHopReview,
} from "../lib/two-hop-review-store";
import {
  saveTwoHopReviewSchema,
  twoHopStudySchema,
  type TwoHopAnswer,
} from "../lib/two-hop-review-types";

const source = {
  title: "Source paper",
  version: "Author copy",
  url: "https://example.org/source",
  text: "Measurements recovered a signal.",
};
const study = {
  cases: [
    {
      caseId: "C1",
      study: "Example",
      originalSource: "original",
      immediateSource: "intermediate",
      citingTitle: "Replication",
      citingVersion: "1",
      citingUrl: "https://example.org/replication",
      extractedClaimToCheck: "The detector recovered a signal.",
      evidence: [
        {
          locator: "paragraph-1",
          supportSpan: "Measurements recovered a signal [2].",
          focus: "Measurements recovered a signal",
          markerInsideSpan: true,
          paragraphWithTargetMarker: "Measurements recovered a signal 【[2]】.",
          targetReference: { refId: "2", title: "Relay paper" },
          citationGroupReferences: [["2", "Relay paper"]],
        },
      ],
    },
  ],
  relays: [
    {
      original: "original",
      excerpt: "A signal appeared 【[1]】.",
      intermediate: "intermediate",
      block: "paragraph-2",
      passage: "A signal appeared 【[1]】.",
    },
  ],
  sources: {
    original: source,
    intermediate: {
      ...source,
      title: "Relay paper",
      text: "A signal appeared [1].",
    },
  },
};
const answer: TwoHopAnswer = {
  chainAssessment: "faithful",
  notes: "",
};

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "two-hop-review-"));
  writeFileSync(join(directory, "study.json"), JSON.stringify(study));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("persists revisions, keeps the first assessment and rejects an outdated tab", () => {
  const { studyRevision, answers } = loadTwoHopReview(directory);
  expect(answers).toEqual({});
  expect(
    saveTwoHopReviewSchema.parse({
      caseId: "C1",
      studyRevision,
      expectedRevision: null,
      answer: { chainAssessment: "changed" },
    }).answer,
  ).toEqual({ chainAssessment: "changed", notes: "" });
  const request = {
    caseId: "C1",
    studyRevision,
    answer,
    expectedRevision: null,
  };
  const first = saveTwoHopReview(directory, request);
  expect(() => saveTwoHopReview(directory, request)).toThrow(ReviewConflict);
  const second = saveTwoHopReview(directory, {
    ...request,
    expectedRevision: first.revision,
    answer: { ...answer, notes: "Checked both references." },
  });
  expect(loadTwoHopReview(directory)).toMatchObject({
    answers: { C1: second.answer },
    revisions: { C1: second.revision },
  });
  const firstOnDisk = JSON.parse(
    readFileSync(
      join(directory, "answers", studyRevision, "C1", "1.json"),
      "utf8",
    ),
  );
  expect(firstOnDisk.answer).toEqual(answer);
});

it("rejects a save when an evidence change reused the same case id", () => {
  const { studyRevision } = loadTwoHopReview(directory);
  writeFileSync(
    join(directory, "study.json"),
    JSON.stringify({
      ...study,
      sources: {
        ...study.sources,
        original: { ...source, text: "Revised evidence." },
      },
    }),
  );
  expect(() =>
    saveTwoHopReview(directory, {
      studyRevision,
      caseId: "C1",
      expectedRevision: null,
      answer,
    }),
  ).toThrow(ReviewConflict);
  expect(loadTwoHopReview(directory).answers).toEqual({});
});

it("serves only evidence and permits only human answer fields on write", () => {
  writeFileSync(
    join(directory, "study.json"),
    JSON.stringify({
      ...study,
      cases: study.cases.map((c) => ({ ...c, modelVerdict: "F" })),
      reviewerA: { C1: "F" },
    }),
  );
  const data = loadTwoHopReview(directory);
  expect(JSON.stringify(data)).not.toContain("modelVerdict");
  expect(data).not.toHaveProperty("reviewerA");
  expect(
    saveTwoHopReviewSchema.safeParse({
      caseId: "C1",
      studyRevision: data.studyRevision,
      expectedRevision: null,
      answer: { ...answer, modelVerdict: "D" },
    }).success,
  ).toBe(false);
});

it("keeps a clarified last-hop answer outside the full-chain count and preserves its source event", () => {
  const old = loadTwoHopReview(directory).studyRevision;
  saveTwoHopReview(directory, {
    caseId: "C1",
    studyRevision: old,
    expectedRevision: null,
    answer,
  });
  const sourceEvent = join(directory, "answers", old, "C1", "1.json");
  const original = readFileSync(sourceEvent, "utf8");
  writeFileSync(
    join(directory, "study.json"),
    JSON.stringify({
      ...study,
      cases: study.cases.map((c) => ({ ...c, citingLabel: "Later paper" })),
    }),
  );
  const current = loadTwoHopReview(directory).studyRevision;
  const history = join(directory, "history");
  mkdirSync(history);
  const record = {
    sourceStudyRevision: old,
    sourceRevision: "1",
    reason: "The reviewer clarified the scope.",
    scope: "later_hop_only",
  };
  writeFileSync(
    join(history, current + ".json"),
    JSON.stringify({ C1: record }),
  );
  expect(loadTwoHopReview(directory)).toMatchObject({
    answers: {},
    revisions: {},
    priorReviews: { C1: { ...record, answer } },
  });
  expect(Object.keys(loadTwoHopReview(directory).answers)).toEqual([]);
  saveTwoHopReview(directory, {
    caseId: "C1",
    studyRevision: current,
    expectedRevision: null,
    answer: { chainAssessment: "no_chain", notes: "Different finding." },
  });
  expect(loadTwoHopReview(directory).answers.C1?.chainAssessment).toBe(
    "no_chain",
  );
  expect(loadTwoHopReview(directory).priorReviews.C1?.answer).toEqual(answer);
  expect(readFileSync(sourceEvent, "utf8")).toBe(original);
});
it("exposes an answer carried from the earlier question with its provenance until revised", () => {
  const old = loadTwoHopReview(directory).studyRevision;
  saveTwoHopReview(directory, {
    caseId: "C1",
    studyRevision: old,
    expectedRevision: null,
    answer,
  });
  writeFileSync(
    join(directory, "study.json"),
    JSON.stringify({
      ...study,
      cases: study.cases.map((c) => ({ ...c, citingLabel: "Later paper" })),
    }),
  );
  const current = loadTwoHopReview(directory).studyRevision;
  mkdirSync(join(directory, "history"));
  writeFileSync(
    join(directory, "history", current + ".json"),
    JSON.stringify({
      C1: {
        sourceStudyRevision: old,
        sourceRevision: "1",
        reason: "Previous question.",
        scope: "previous_chain_question",
      },
    }),
  );
  expect(loadTwoHopReview(directory).answers.C1).toEqual(answer);
  expect(loadTwoHopReview(directory).revisions.C1).toBeUndefined();
  saveTwoHopReview(directory, {
    caseId: "C1",
    studyRevision: current,
    expectedRevision: null,
    answer: { chainAssessment: "uncertain", notes: "" },
  });
  expect(loadTwoHopReview(directory).answers.C1?.chainAssessment).toBe(
    "uncertain",
  );
});

it("rejects a comparison excerpt taken from the wrong paper or outside its marked sentence", () => {
  expect(
    twoHopStudySchema.safeParse({
      ...study,
      sources: { ...study.sources, intermediate: source },
    }).success,
  ).toBe(false);
  const item = study.cases[0]!;
  expect(
    twoHopStudySchema.safeParse({
      ...study,
      cases: [
        {
          ...item,
          evidence: [{ ...item.evidence[0], focus: "An unrelated claim" }],
        },
      ],
    }).success,
  ).toBe(false);
});
