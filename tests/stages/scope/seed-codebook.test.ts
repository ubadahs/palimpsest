import { describe, expect, it } from "vitest";

import {
  codebookTaggingReplySchema,
  normalizeTaggingReply,
  runSeedCodebookProcedure,
  verifyCodebookReply,
  type CodebookModelCall,
  type CodebookOrganiseReply,
  type CodebookStep,
} from "../../../src/stages/scope/seed-codebook.js";

// An invented seed paper: a made-up protein in a made-up organism.
const BLOCKS = [
  {
    blockId: "b1",
    sectionTitle: "Abstract",
    text: "Knocking out Zorp4 in tide-pool snails halves shell thickening. Zorp4 is required for calcium uptake.",
    charOffsetStart: 0,
  },
  {
    blockId: "b2",
    sectionTitle: "Introduction",
    text: "Shell growth slows in acidic water (Ames, 2001). Snail shells are mostly aragonite.",
    charOffsetStart: 110,
  },
  {
    blockId: "b3",
    sectionTitle: "Methods",
    text: "We bred a Zorp4-null line by guide-RNA injection.",
    charOffsetStart: 200,
  },
];

function organiseReply(
  overrides: Partial<CodebookOrganiseReply> = {},
): CodebookOrganiseReply {
  return {
    themes: [
      {
        id: "T1",
        statement: "Zorp4 drives shell thickening through calcium uptake.",
        isHeadline: true,
        quotes: [
          "Knocking out Zorp4 in tide-pool snails halves shell thickening.",
        ],
      },
      {
        id: "T2",
        statement: "Background on shell growth.",
        isHeadline: false,
        quotes: ["Shell growth slows in acidic water"],
      },
      {
        id: "T3",
        statement: "Methods and resources.",
        isHeadline: false,
        quotes: ["not in the paper"],
      },
    ],
    entries: [
      {
        id: "E01",
        parent: "T1",
        statement: "Zorp4 loss halves shell thickening.",
        type: "result",
        attributedToOtherWork: false,
        quotes: [
          "Knocking out Zorp4 in tide-pool snails halves shell thickening.",
        ],
      },
      {
        id: "E02",
        parent: "T2",
        statement: "Acidic water slows shell growth.",
        type: "background_prior_work",
        attributedToOtherWork: true,
        quotes: ["Shell growth slows in acidic water (Ames, 2001)."],
      },
      {
        id: "E03",
        parent: "T1",
        statement: "Zorp4 is needed for calcium uptake.",
        type: "result",
        attributedToOtherWork: false,
        // One verified, one invented: the entry stays.
        quotes: [
          "Zorp4 is required for calcium uptake.",
          "Zorp4 pumps calcium.",
        ],
      },
      {
        id: "E04",
        parent: "T3",
        statement: "A Zorp4-null line.",
        type: "method_or_resource",
        attributedToOtherWork: false,
        // Every quote fails: dropped and counted.
        quotes: ["We engineered a knockout line."],
      },
      {
        id: "E05",
        parent: "T9",
        statement: "An entry under a theme that does not exist.",
        type: "result",
        attributedToOtherWork: false,
        quotes: ["Snail shells are mostly aragonite."],
      },
    ],
    ...overrides,
  };
}

describe("seed codebook procedure", () => {
  it("runs three calls in order on one shared seed-text prefix", async () => {
    const steps: Array<{ step: CodebookStep; prefix: string; suffix: string }> =
      [];
    const replies: Record<CodebookStep, unknown> = {
      draft_results: {
        headline: [
          {
            statement: "Zorp4 drives shell thickening.",
            attributedToOtherWork: false,
            quotes: ["halves shell thickening"],
          },
        ],
        results: [],
      },
      draft_background: { background: [], methods: [] },
      organise: organiseReply(),
    };
    const schemas = new Set<unknown>();
    const empty = {
      headline: [],
      results: [],
      background: [],
      methods: [],
      themes: [],
      entries: [],
    };
    const call: CodebookModelCall = (input) => {
      steps.push({
        step: input.step,
        prefix: input.promptPrefix,
        suffix: input.promptSuffix,
      });
      schemas.add(input.schema);
      return Promise.resolve(
        input.schema.parse({
          ...empty,
          ...(replies[input.step] as object),
        }),
      );
    };

    const result = await runSeedCodebookProcedure({
      seedTitle: "Zorp4 and snail shells",
      blocks: BLOCKS,
      call,
    });

    expect(steps.map((entry) => entry.step)).toEqual([
      "draft_results",
      "draft_background",
      "organise",
    ]);
    expect(new Set(steps.map((entry) => entry.prefix)).size).toBe(1);
    // One response schema for all steps, or the cached prefix breaks.
    expect(schemas.size).toBe(1);
    expect(steps[0]!.prefix).toContain("[b1 | Abstract]");
    expect(steps[0]!.suffix).not.toContain("tide-pool");
    // The organise step sees both drafts and the headline rule.
    expect(steps[2]!.suffix).toContain("Zorp4 drives shell thickening.");
    expect(steps[2]!.suffix).toContain("The headline theme is never empty.");
    expect(result.ok).toBe(true);
  });

  it("exact-verifies quotes, drops unverified and orphaned entries, and renumbers", () => {
    const result = verifyCodebookReply(organiseReply(), BLOCKS);
    if (!result.ok) throw new Error(result.error);
    const { content, verification } = result.data;

    expect(verification).toEqual({
      proposedThemes: 3,
      proposedEntries: 5,
      quotesProposed: 9,
      quotesVerified: 6,
      entriesDropped: 1,
      entriesOrphaned: 1,
      themesDropped: 1,
    });
    expect(content.themes.map((theme) => theme.themeId)).toEqual(["T1", "T2"]);
    // Entries are grouped by theme: both T1 entries come first.
    expect(
      content.entries.map((entry) => [
        entry.entryId,
        entry.themeId,
        entry.statement,
      ]),
    ).toEqual([
      ["E01", "T1", "Zorp4 loss halves shell thickening."],
      ["E02", "T1", "Zorp4 is needed for calcium uptake."],
      ["E03", "T2", "Acidic water slows shell growth."],
    ]);
    const quote = content.entries[1]!.quotes;
    expect(quote).toEqual([
      {
        blockId: "b1",
        text: "Zorp4 is required for calcium uptake.",
        charOffsetStart: 64,
        charOffsetEnd: 64 + "Zorp4 is required for calcium uptake.".length,
      },
    ]);
    expect(BLOCKS[0]!.text.slice(64, 64 + quote[0]!.text.length)).toBe(
      quote[0]!.text,
    );
  });

  it("is a typed failure when no entry keeps a verified quote", () => {
    const result = verifyCodebookReply(
      organiseReply({
        entries: [
          {
            id: "E01",
            parent: "T1",
            statement: "Invented.",
            type: "result",
            attributedToOtherWork: false,
            quotes: ["nowhere in the paper"],
          },
        ],
      }),
      BLOCKS,
    );
    expect(result.ok).toBe(false);
  });
});

describe("codebook tagging replies", () => {
  const verified = verifyCodebookReply(organiseReply(), BLOCKS);
  if (!verified.ok) throw new Error(verified.error);
  const codebook = verified.data.content;
  const schema = codebookTaggingReplySchema(codebook);

  it("accepts 1 to 3 known entries as a sorted set", () => {
    const reply = schema.parse({
      kind: "specific",
      entries: ["E03", " E01", "E01"],
      theme: null,
      reason: "Joins two findings.",
    });
    expect(normalizeTaggingReply(reply)).toEqual({
      kind: "specific",
      tags: ["E01", "E03"],
    });
  });

  it("takes a theme alone when the claim is broader than any entry", () => {
    const reply = schema.parse({
      kind: "theme_only",
      entries: [],
      theme: "T1",
      reason: "States the headline in general terms.",
    });
    expect(normalizeTaggingReply(reply)).toEqual({
      kind: "theme_only",
      tags: ["T1"],
    });
  });

  it("takes none with no tags", () => {
    const reply = schema.parse({
      kind: "none",
      entries: [],
      theme: null,
      reason: "The codebook does not list it.",
    });
    expect(normalizeTaggingReply(reply)).toEqual({ kind: "none", tags: [] });
  });

  it("rejects unknown ids, more than three entries, and a theme-only answer without a theme", () => {
    for (const bad of [
      { kind: "specific", entries: ["E09"], theme: null, reason: "x" },
      { kind: "specific", entries: [], theme: null, reason: "x" },
      {
        kind: "specific",
        entries: ["E01", "E02", "E03", "T1"],
        theme: null,
        reason: "x",
      },
      { kind: "theme_only", entries: [], theme: null, reason: "x" },
      { kind: "theme_only", entries: [], theme: "E01", reason: "x" },
    ]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });
});
