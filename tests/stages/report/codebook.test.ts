import { describe, expect, it } from "vitest";

import type {
  AdjudicateArtifact,
  DiscoverArtifact,
  ScopeArtifact,
} from "../../../src/contract/artifacts/index.js";
import { buildSeedCodebookViews } from "../../../src/stages/report/codebook.js";
import { fixtureModelExecution } from "../scope/codebook.fixture.js";

// Hand-built, invented inputs: only the fields the codebook view reads.
const id = (namespace: string, n: number) =>
  `${namespace}_${String(n).padStart(64, "0")}`;
const SEED = id("seed", 1);
const quote = {
  blockId: "b1",
  text: "x",
  charOffsetStart: 0,
  charOffsetEnd: 1,
};

function inputs() {
  const claims = [
    // claim 1: two entries under two themes (multi-tag)
    {
      n: 1,
      paper: 1,
      text: "Beetles glow and hum.",
      tags: ["E01", "E03"],
      kind: "specific",
    },
    // claim 2: the headline theme alone
    {
      n: 2,
      paper: 2,
      text: "Beetles are luminous.",
      tags: ["T1"],
      kind: "theme_only",
    },
    // claim 3: an entry under the headline theme
    {
      n: 3,
      paper: 3,
      text: "Beetles glow at night.",
      tags: ["E01"],
      kind: "specific",
    },
    // claim 4: none
    { n: 4, paper: 4, text: "Beetles like jazz.", tags: [], kind: "none" },
    // claim 5: same paper and text as claim 3 (one unit)
    {
      n: 5,
      paper: 3,
      text: "Beetles  glow at night.",
      tags: ["E01"],
      kind: "specific",
    },
    // claim 6: tagging failed
    { n: 6, paper: 5, text: "Beetles sing.", tags: [], kind: "failed" },
  ];
  const discover = {
    payload: {
      seeds: [
        {
          seedId: SEED,
          doi: "10.0000/invented-beetles",
          resolution: {
            status: "resolved",
            paper: { title: "Glowing beetles" },
          },
        },
      ],
      citationMentions: claims.map((claim) => ({
        mentionId: id("mention", claim.n),
        citingPaperRecordId: id("paper", claim.paper),
      })),
      attributedClaimRecords: claims.map((claim) => ({
        claimRecordId: id("claim", claim.n),
        seedId: SEED,
        mentionId: id("mention", claim.n),
        extractedClaimText: claim.text,
      })),
    },
  } as unknown as DiscoverArtifact;
  const execution = fixtureModelExecution("tag");
  const scope = {
    payload: {
      families: [{ familyId: id("family", 1), seedId: SEED }],
      codebooks: [
        {
          status: "reused",
          seedId: SEED,
          codebookId: id("codebook", 1),
          procedureVersion: "seed-codebook-v1",
          generatedAt: "2026-01-01T00:00:00.000Z",
          themes: [
            {
              themeId: "T1",
              statement: "Beetles glow.",
              isHeadline: true,
              quotes: [quote],
            },
            {
              themeId: "T2",
              statement: "Beetle sounds.",
              isHeadline: false,
              quotes: [quote],
            },
          ],
          entries: [
            {
              entryId: "E01",
              themeId: "T1",
              statement: "Glow at night.",
              type: "result",
              attributedToOtherWork: false,
              quotes: [quote],
            },
            {
              entryId: "E02",
              themeId: "T1",
              statement: "Glow in larvae.",
              type: "result",
              attributedToOtherWork: false,
              quotes: [quote],
            },
            {
              entryId: "E03",
              themeId: "T2",
              statement: "They hum.",
              type: "result",
              attributedToOtherWork: false,
              quotes: [quote],
            },
          ],
        },
      ],
      claimTags: claims.map((claim) =>
        claim.kind === "failed"
          ? {
              claimRecordId: id("claim", claim.n),
              seedId: SEED,
              status: "tagging_failed",
              failure: { code: "timeout", reason: "x" },
              execution,
            }
          : {
              claimRecordId: id("claim", claim.n),
              seedId: SEED,
              status: "tagged",
              kind: claim.kind,
              tags: claim.tags,
              reason: "x",
              execution,
            },
      ),
    },
  } as unknown as ScopeArtifact;
  const record = (n: number, claimNs: number[], verdict: string) => ({
    recordId: id("record", n),
    familyId: id("family", 1),
    status: "adjudicated",
    verdict,
    evaluatedClaimRecordIds: claimNs.map((claimN) => id("claim", claimN)),
  });
  const adjudicate = {
    payload: {
      records: [
        record(1, [1], "D"), // E01 and E03: counted under both, T1 and T2 once each
        record(2, [2], "F"), // T1 alone
        record(3, [3, 5], "F"), // E01 via two claims: still one record
        record(4, [4], "E"), // untagged
        {
          recordId: id("record", 5),
          familyId: id("family", 1),
          status: "not_adjudicated",
        },
      ],
    },
  } as unknown as AdjudicateArtifact;
  return { discover, scope, adjudicate };
}

describe("report seed codebook view", () => {
  it("counts a record under every entry it carries and once per theme roll-up", () => {
    const { discover, scope, adjudicate } = inputs();
    const [view] = buildSeedCodebookViews({
      discoverArtifact: discover,
      scopeArtifact: scope,
      adjudicateArtifact: adjudicate,
    });
    const entry = (entryId: string) =>
      view!.entries.find((row) => row.entryId === entryId)!;
    const theme = (themeId: string) =>
      view!.themes.find((row) => row.themeId === themeId)!;

    expect(entry("E01").counts).toEqual({
      taggedClaimUnits: 2,
      adjudicatedRecords: 2,
      F: 1,
      D: 1,
      E: 0,
      U: 0,
    });
    expect(entry("E03").counts).toMatchObject({ adjudicatedRecords: 1, D: 1 });
    expect(entry("E02").counts.taggedClaimUnits).toBe(0);

    // T1 rolls up E01 and the theme-only claim: records 1, 2 and 3, once each.
    expect(theme("T1").counts).toEqual({
      taggedClaimUnits: 3,
      adjudicatedRecords: 3,
      F: 2,
      D: 1,
      E: 0,
      U: 0,
    });
    expect(theme("T1").themeOnlyClaimUnits).toBe(1);
    expect(theme("T1").entryClaimUnits).toBe(2);
    expect(theme("T1").entryIds).toEqual(["E01", "E02"]);
    expect(theme("T2").counts).toMatchObject({ adjudicatedRecords: 1, D: 1 });

    expect(view!.claims).toEqual({
      total: 6,
      specific: 3,
      themeOnly: 1,
      none: 1,
      taggingFailed: 1,
      notTagged: 0,
    });
    expect(view!.claimUnits).toEqual({ total: 5, untagged: 2 });
    expect(view!.adjudicatedRecords).toEqual({ total: 4, untagged: 1 });
    expect(view!.uncitedEntryIds).toEqual(["E02"]);
  });

  it("refuses claim tags that do not cover every Discover claim", () => {
    const { discover, scope, adjudicate } = inputs();
    (scope.payload as { claimTags: unknown[] }).claimTags.pop();
    expect(() =>
      buildSeedCodebookViews({
        discoverArtifact: discover,
        scopeArtifact: scope,
        adjudicateArtifact: adjudicate,
      }),
    ).toThrow(/every Discover attributed claim/);
  });
});
