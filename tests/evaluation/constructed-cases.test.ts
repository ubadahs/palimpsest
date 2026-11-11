import { describe, expect, it } from "vitest";

import {
  buildCanonicalAdjudicatePrompt,
  type CanonicalAdjudicatePacket,
} from "../../src/adjudication/canonical-adjudicate-packet.js";
import { blindCaseView } from "../../src/evaluation/annotations.js";
import {
  buildConstructedCases,
  mutationFileSchema,
  type Mutation,
} from "../../src/evaluation/constructed-cases.js";
import type { EvaluationCase } from "../../src/evaluation/types.js";

type AdjudicationCase = Extract<EvaluationCase, { task: "adjudication" }>;
type Distortion = Extract<Mutation, { expectedVerdict: "D" | "E" }>;

const packet: CanonicalAdjudicatePacket = {
  recordId: "record_source",
  familyId: "fam_1",
  citationOccurrenceId: "occ_1",
  citationRole: "substantive_attribution",
  evaluationMode: "fidelity_specific_claim",
  isBundled: false,
  bundleSize: 1,
  citingPaperTitle: "Citing paper",
  citedPaperTitle: "Seed paper",
  familyTrackedClaim: "Seed reported three marker classes in mouse Norel.",
  markedCitingContext:
    "Background on the region. ▶ Marlowe et al. (2021) reported three marker classes in mouse Norel. ◀ Later text.",
  occurrenceClaims: [
    {
      claimRecordId: "claim_1",
      claimText: "The seed reported three marker classes in mouse Norel.",
      supportSpanText: "reported three marker classes in mouse Norel",
      supportSpanCharOffsetStart: 48,
      supportSpanCharOffsetEnd: 92,
    },
  ],
  selectedChunks: [
    {
      chunkId: "chunk_1",
      text: "We identified three marker classes in the mouse Norel.",
      sourceBlockKind: "body_paragraph",
      charOffsetStart: 0,
      charOffsetEnd: 54,
    },
  ],
};

const base = {
  runId: "run-one",
  seedDoi: "10.1/seed",
  recordId: "record_source",
  sourceArtifactHashes: { report: "hash" },
};

const source: AdjudicationCase = {
  ...base,
  caseId: "case_source",
  task: "adjudication",
  unitKey: "unit_source",
  packet,
  anthropicPrompt: buildCanonicalAdjudicatePrompt(packet),
};

/** The source's retrieval case; `pins` grounding pins against a limit of one. */
function retrieval(pins: string[]): EvaluationCase {
  return {
    ...base,
    caseId: "case_retrieval",
    task: "rerank",
    query: "three marker classes",
    candidates: [
      { chunkId: "chunk_1", text: "text", sourceBlockKind: "body_paragraph" },
    ],
    pinnedPassages: [],
    bm25Order: ["chunk_1"],
    pinnedChunkIds: pins,
    selectionLimit: 1,
  };
}

const distortion: Distortion = {
  recordId: "record_source",
  expectedVerdict: "D",
  mutationKind: "population_shifted",
  direction: "shifted",
  rationale: "The seed studied mouse, not human.",
  contextEdits: [{ find: "in mouse Norel", replace: "in human Norel" }],
  claimEdits: [{ find: "in mouse Norel", replace: "in human Norel" }],
};

const control: Mutation = {
  recordId: "record_source",
  expectedVerdict: "F",
  rationale: "Described and reported say the same thing here.",
  contextEdits: [{ find: "reported three", replace: "described three" }],
  claimEdits: [{ find: "reported three", replace: "described three" }],
};

const faithful = new Map([["unit_source", { verdict: "F" }]]);

function construct(overrides: Partial<Distortion> = {}) {
  return buildConstructedCases([source], faithful, [
    { ...distortion, ...overrides },
  ])[0]!;
}

describe("constructed cases", () => {
  it("edits the citing text, the support span, and the claim, and nothing else", () => {
    const built = construct();
    const edited = built.packet as CanonicalAdjudicatePacket;
    expect(edited.markedCitingContext).toBe(
      "Background on the region. ▶ Marlowe et al. (2021) reported three marker classes in human Norel. ◀ Later text.",
    );
    expect(edited.occurrenceClaims).toEqual([
      {
        claimRecordId: "claim_1",
        claimText: "The seed reported three marker classes in human Norel.",
        supportSpanText: "reported three marker classes in human Norel",
      },
    ]);
    expect(edited.selectedChunks).toEqual(packet.selectedChunks);
    expect(built.anthropicPrompt).toBe(buildCanonicalAdjudicatePrompt(edited));
    expect(built.constructed).toEqual({
      sourceCaseId: "case_source",
      rationale: "The seed studied mouse, not human.",
      evidencePinned: false,
      expectedVerdict: "D",
      mutationKind: "population_shifted",
      direction: "shifted",
    });
  });

  it("builds a control that expects F and names no mutation", () => {
    const [built] = buildConstructedCases([source], faithful, [control]);
    expect(built!.constructed).toEqual({
      sourceCaseId: "case_source",
      rationale: "Described and reported say the same thing here.",
      evidencePinned: false,
      expectedVerdict: "F",
    });
    expect(
      mutationFileSchema.safeParse([
        { ...control, mutationKind: "scope_broadened" },
      ]).success,
    ).toBe(false);
    expect(
      mutationFileSchema.safeParse([{ ...distortion, mutationKind: undefined }])
        .success,
    ).toBe(false);
  });

  it("marks evidence as pinned only when grounding pins fill the packet", () => {
    const pinned = buildConstructedCases(
      [source, retrieval(["chunk_1"])],
      faithful,
      [distortion],
    );
    const ranked = buildConstructedCases([source, retrieval([])], faithful, [
      distortion,
    ]);
    expect(pinned[0]!.constructed?.evidencePinned).toBe(true);
    expect(ranked[0]!.constructed?.evidencePinned).toBe(false);
  });

  it("gets its own record and unit so it inherits no label from its source", () => {
    const built = construct();
    expect(built.recordId).toMatch(/^record_[0-9a-f]{64}$/);
    expect(built.recordId).not.toBe(source.recordId);
    expect(built.unitKey).not.toBe(source.unitKey);
    expect((built.packet as CanonicalAdjudicatePacket).recordId).toBe(
      built.recordId,
    );
  });

  it("shows a blind reviewer the edited source text and nothing that marks it as constructed", () => {
    const view = blindCaseView({ ...construct(), caseId: "case_built" });
    expect(view).toMatchObject({
      packet: {
        occurrenceClaims: [
          { supportSpanText: "reported three marker classes in human Norel" },
        ],
      },
    });
    expect(JSON.stringify(view)).not.toMatch(
      /constructed|population_shifted|expectedVerdict|not human/,
    );
  });

  it("refuses a source no human labelled faithful", () => {
    expect(() =>
      buildConstructedCases(
        [source],
        new Map([["unit_source", { verdict: "D" }]]),
        [distortion],
      ),
    ).toThrow("has no undisputed human F label");
    expect(() => buildConstructedCases([source], new Map(), [control])).toThrow(
      "has no undisputed human F label",
    );
  });

  it("refuses an edit that is ambiguous in the citing context", () => {
    expect(() =>
      construct({ contextEdits: [{ find: "Norel", replace: "Sorel" }] }),
    ).not.toThrow();
    expect(() =>
      construct({ contextEdits: [{ find: "re", replace: "RE" }] }),
    ).toThrow("it must occur once");
  });

  it("refuses an edit that leaves the attributed text unchanged", () => {
    expect(() =>
      construct({
        contextEdits: [{ find: "Later text", replace: "Other text" }],
      }),
    ).toThrow("change no support span");
  });

  it("refuses an edit that crosses the edge of a support span", () => {
    expect(() =>
      construct({
        contextEdits: [
          { find: "(2021) reported three", replace: "(2021) reported six" },
        ],
      }),
    ).toThrow("crosses the edge of a support span");
  });

  it("refuses a claim edit that matches no claim", () => {
    expect(() =>
      construct({ claimEdits: [{ find: "in rat Norel", replace: "x" }] }),
    ).toThrow("matches no attributed claim");
  });
});
