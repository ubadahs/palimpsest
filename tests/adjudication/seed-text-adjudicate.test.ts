import { describe, expect, it } from "vitest";

import type { CanonicalAdjudicatePacket } from "../../src/adjudication/canonical-adjudicate-packet.js";
import {
  buildSeedTextAdjudicatePrompt,
  chunkIdsHoldingQuotes,
  resolveSeedTextJudgment,
  seedTextBlocksFromCorpus,
  type SeedText,
  type SeedTextAdjudicateReply,
} from "../../src/adjudication/seed-text-adjudicate.js";
import type { EvidenceChunk } from "../../src/contract/lean-artifacts.js";

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

/**
 * Cuts blocks into overlapping windows the way Evidence does, keeping only
 * the fields the seed-text helpers read.
 */
function corpusOf(
  blocks: SeedText["blocks"],
  window: number,
  overlap: number,
): EvidenceChunk[] {
  const chunks: unknown[] = [];
  let blockStart = 0;
  for (const block of blocks) {
    for (let at = 0; ; at += window - overlap) {
      const end = Math.min(block.text.length, at + window);
      chunks.push({
        chunkId: `chunk_${String(chunks.length)}`,
        text: block.text.slice(at, end),
        sourceBlockId: block.blockId,
        sourceBlockKind: block.blockKind,
        sourceSectionTitle: block.sectionTitle,
        sourceSectionRole: block.sectionRole,
        sourceCitesOtherWork: block.citesOtherWork,
        sourceBlockCharOffsetStart: blockStart,
        charOffsetStart: blockStart + at,
        charOffsetEnd: blockStart + end,
      });
      if (end === block.text.length) break;
    }
    blockStart += block.text.length + 2;
  }
  return chunks as EvidenceChunk[];
}

describe("seed text rebuilt from an Evidence corpus", () => {
  const corpus = corpusOf(seed.blocks, 20, 6);

  it("restores every block exactly from its overlapping chunks", () => {
    expect(corpus.length).toBeGreaterThan(seed.blocks.length);
    expect(seedTextBlocksFromCorpus(corpus)).toEqual(seed.blocks);
  });

  it("refuses a corpus that leaves part of a block out", () => {
    expect(() =>
      seedTextBlocksFromCorpus(corpus.filter((_, index) => index !== 1)),
    ).toThrow("leaves a gap in seed block abstract-0");
  });

  it("names every chunk that holds part of a quote, and no other", () => {
    const blocks = seedTextBlocksFromCorpus(corpus);
    const quoted = (quote: string, blockId = "abstract-0") =>
      chunkIdsHoldingQuotes(corpus, blocks, [{ blockId, quote }]);

    // "three marker" starts at 14 in the first block: windows 0-20 and 14-34.
    expect(quoted("three marker")).toEqual(["chunk_0", "chunk_1"]);
    expect(quoted("We ident")).toEqual(["chunk_0"]);
    expect(quoted("five classes", "body_paragraph-1").length).toBeGreaterThan(
      0,
    );
    // The same words in another block are a different passage.
    expect(quoted("classes", "body_paragraph-1")).not.toContain("chunk_1");
    expect(quoted("not in the paper")).toEqual([]);
  });
});
