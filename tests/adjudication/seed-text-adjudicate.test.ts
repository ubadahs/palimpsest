import { describe, expect, it } from "vitest";

import type { CanonicalAdjudicatePacket } from "../../src/adjudication/canonical-adjudicate-packet.js";
import {
  buildSeedTextAdjudicatePrompt,
  resolveSeedTextJudgment,
  type SeedText,
  type SeedTextAdjudicateReply,
} from "../../src/adjudication/seed-text-adjudicate.js";

const seed: SeedText = {
  title: "Seed paper",
  blocks: [
    {
      blockId: "abstract-0",
      text: "We identified three marker classes in the mouse Norel.",
      blockKind: "abstract",
      sectionRole: "abstract",
      citesOtherWork: false,
    },
    {
      blockId: "body_paragraph-1",
      text: "Earlier work proposed five classes (Okoro 2011).",
      blockKind: "body_paragraph",
      sectionTitle: "Introduction",
      sectionRole: "introduction",
      citesOtherWork: true,
    },
  ],
};

function packet(recordId: string, claim: string): CanonicalAdjudicatePacket {
  return {
    recordId,
    familyId: "fam_1",
    citationOccurrenceId: "occ_1",
    citationRole: "substantive_attribution",
    evaluationMode: "fidelity_specific_claim",
    isBundled: false,
    bundleSize: 1,
    citingPaperTitle: "Citing paper",
    citedPaperTitle: "Seed paper",
    familyTrackedClaim: "Seed reported three marker classes.",
    markedCitingContext: `▶ Marlowe et al. (2021) ${claim}. ◀`,
    occurrenceClaims: [
      {
        claimRecordId: "claim_1",
        claimText: `The seed ${claim}.`,
        supportSpanText: claim,
      },
    ],
    selectedChunks: [],
  };
}

function reply(
  overrides: Partial<SeedTextAdjudicateReply>,
): SeedTextAdjudicateReply {
  return {
    citingAssertion: "The citer says the seed reported three classes.",
    sourceStatement: "The seed reports three classes.",
    verdict: "F",
    mutationKinds: [],
    direction: "none",
    rationale: "The statements match.",
    confidence: "high",
    seedQuotes: [{ block: 1, quote: "three marker classes" }],
    ...overrides,
  };
}

describe("seed-text adjudication prompt", () => {
  it("keeps everything about the citing paper out of the cacheable prefix", () => {
    const first = buildSeedTextAdjudicatePrompt({
      packet: packet("rec_1", "reported three marker classes"),
      seed,
    });
    const second = buildSeedTextAdjudicatePrompt({
      packet: packet("rec_2", "reported five marker classes"),
      seed,
    });
    expect(second.prefix).toBe(first.prefix);
    expect(first.prefix).not.toContain("rec_1");
    expect(first.suffix).toContain("rec_1");
    expect(second.suffix).toContain("reported five marker classes");
  });

  it("numbers every seed block and labels its role and outside citations", () => {
    const { prefix } = buildSeedTextAdjudicatePrompt({
      packet: packet("rec_1", "reported three marker classes"),
      seed,
    });
    expect(prefix).toContain("#1 (abstract, role=abstract)");
    expect(prefix).toContain(
      '#2 (body_paragraph, role=introduction, section="Introduction", cites other work)',
    );
  });
});

describe("seed-text judgment", () => {
  it("binds a verified quote to the block it came from", () => {
    const result = resolveSeedTextJudgment(reply({}), seed.blocks);
    expect(result).toMatchObject({
      ok: true,
      data: {
        verdict: "F",
        seedQuotes: [{ blockId: "abstract-0", quote: "three marker classes" }],
        unverifiedQuoteCount: 0,
      },
    });
  });

  it("drops and counts a quote that is not in the block it names", () => {
    const result = resolveSeedTextJudgment(
      reply({
        seedQuotes: [
          { block: 1, quote: "three marker classes" },
          { block: 2, quote: "three marker classes" },
          { block: 9, quote: "three marker classes" },
        ],
      }),
      seed.blocks,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { unverifiedQuoteCount: 2 },
    });
    expect(result.ok && result.data.seedQuotes).toHaveLength(1);
  });

  it("rejects a faithful verdict that rests on no verified quote", () => {
    const result = resolveSeedTextJudgment(
      reply({ seedQuotes: [{ block: 1, quote: "four marker classes" }] }),
      seed.blocks,
    );
    expect(result).toEqual({
      ok: false,
      error:
        "seedQuotes: A F verdict must rest on at least one verified seed quote",
    });
  });

  it("accepts an error verdict with no quote, since the paper may say nothing", () => {
    const result = resolveSeedTextJudgment(
      reply({ verdict: "E", direction: "shifted", seedQuotes: [] }),
      seed.blocks,
    );
    expect(result.ok).toBe(true);
  });

  it("applies the production verdict vocabulary and mutation rules", () => {
    expect(
      resolveSeedTextJudgment(reply({ verdict: "supported" }), seed.blocks).ok,
    ).toBe(false);
    expect(
      resolveSeedTextJudgment(
        reply({ verdict: "D", direction: "strengthened" }),
        seed.blocks,
      ),
    ).toEqual({
      ok: false,
      error: "mutationKinds: A D verdict must name at least one mutation kind",
    });
  });
});
