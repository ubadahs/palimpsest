import { expect, it } from "vitest";
import { originalCitationAtPassage } from "../lib/two-hop-citation";
import type { TwoHopCase } from "../lib/two-hop-review-types";

const evidence = {
  locator: "p1#group-2",
  supportSpan: "A finding [4,8].",
  focus: "A finding",
  markerInsideSpan: true,
  paragraphWithTargetMarker: "A finding 【[4]】,8.",
  targetReference: { refId: "4", title: "Intermediate" },
  citationGroupReferences: [
    ["4", "Intermediate"],
    ["8", "Other"],
  ] as [string, string][],
};
const base: TwoHopCase = {
  caseId: "C1",
  study: "Example",
  originalSource: "original",
  immediateSource: "intermediate",
  citingTitle: "Later",
  citingVersion: "1",
  citingUrl: "https://example.org/later",
  extractedClaimToCheck: "A finding",
  evidence: [evidence],
};
it("compares the matched original reference ID at the specific marked group", () => {
  const paper = {
    ...base,
    originalBibliography: {
      referenceIds: ["12"],
      entriesChecked: 20,
      coverage: "complete" as const,
    },
    originalCitationGroup: [
      {
        ...evidence,
        locator: "p1#group-6",
        citationGroupReferences: [
          ["4", "Intermediate"],
          ["12", "Original"],
        ] as [string, string][],
      },
    ],
  };
  expect(originalCitationAtPassage(evidence, paper, "Original")).toContain(
    "elsewhere",
  );
  expect(
    originalCitationAtPassage(
      {
        ...evidence,
        citationGroupReferences: [
          ["4", "Intermediate"],
          ["12", "Original"],
        ],
      },
      paper,
      "Original",
    ),
  ).toContain("alongside the middle paper");
  expect(
    originalCitationAtPassage(
      evidence,
      { ...paper, originalCitationGroup: [] },
      "Original",
    ),
  ).toContain("do not show where");
});

it("distinguishes a partial scan, a checked full bibliography, and missing evidence", () => {
  expect(originalCitationAtPassage(evidence, base, "Original")).toContain(
    "unknown",
  );
  expect(
    originalCitationAtPassage(
      evidence,
      {
        ...base,
        originalBibliography: {
          referenceIds: [],
          entriesChecked: 32,
          coverage: "parsed",
        },
      },
      "Original",
    ),
  ).toContain("32 references recovered");
  expect(
    originalCitationAtPassage(
      evidence,
      {
        ...base,
        originalBibliography: {
          referenceIds: [],
          entriesChecked: 32,
          coverage: "complete",
        },
      },
      "Original",
    ),
  ).toContain("full reference list (32 entries)");
});
