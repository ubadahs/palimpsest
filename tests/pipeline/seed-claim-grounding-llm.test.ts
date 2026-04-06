import { describe, expect, it } from "vitest";

import {
  applyCanonicalGroundingBlocksDownstream,
  buildSeedFullTextForLlm,
  mapLlmParsedResponseToClaimGrounding,
  sha256Utf8,
} from "../../src/pipeline/seed-claim-grounding-llm.js";

describe("buildSeedFullTextForLlm", () => {
  it("joins non-empty block texts with blank lines", () => {
    const doc = {
      parserKind: "jats" as const,
      parserVersion: "t",
      fullTextFormat: "jats_xml" as const,
      blocks: [
        {
          blockId: "a",
          text: "  First para.  ",
          sectionTitle: "Intro",
          blockKind: "body_paragraph" as const,
          charOffsetStart: 0,
          charOffsetEnd: 10,
        },
        {
          blockId: "b",
          text: "",
          sectionTitle: undefined,
          blockKind: "body_paragraph" as const,
          charOffsetStart: 0,
          charOffsetEnd: 0,
        },
        {
          blockId: "c",
          text: "Second para.",
          sectionTitle: "Results",
          blockKind: "body_paragraph" as const,
          charOffsetStart: 0,
          charOffsetEnd: 10,
        },
      ],
      references: [],
      mentions: [],
    };
    expect(buildSeedFullTextForLlm(doc)).toBe("First para.\n\nSecond para.");
  });
});

describe("sha256Utf8", () => {
  it("is stable for a known string", () => {
    expect(sha256Utf8("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("applyCanonicalGroundingBlocksDownstream", () => {
  it("marks not_attempted as blocking", () => {
    const g = applyCanonicalGroundingBlocksDownstream({
      status: "not_attempted",
      analystClaim: "a",
      normalizedClaim: "a",
      supportSpans: [],
      blocksDownstream: false,
      detailReason: "x",
    });
    expect(g.blocksDownstream).toBe(true);
  });

  it("does not mark grounded as blocking", () => {
    const g = applyCanonicalGroundingBlocksDownstream({
      status: "grounded",
      analystClaim: "a",
      normalizedClaim: "a",
      supportSpans: [{ text: "q" }],
      blocksDownstream: false,
      detailReason: "x",
    });
    expect(g.blocksDownstream).toBe(false);
  });
});

describe("mapLlmParsedResponseToClaimGrounding", () => {
  it("maps grounded response with verbatim quotes", () => {
    const manuscript = "Intro\n\nGene X does Y in cells.\n\nMore text.";
    const { grounding: g } = mapLlmParsedResponseToClaimGrounding({
      analystClaim: "Gene X does Y",
      response: {
        status: "grounded",
        normalizedClaim: "Gene X does Y in cells",
        supportSpans: [
          { verbatimQuote: "Gene X does Y in cells.", sectionHint: "Results" },
        ],
        detailReason: "Supported in results.",
      },
      manuscript,
    });
    expect(g.status).toBe("grounded");
    expect(g.normalizedClaim).toBe("Gene X does Y in cells");
    expect(g.supportSpans).toHaveLength(1);
    expect(g.supportSpans[0]!.text).toBe("Gene X does Y in cells.");
    expect(g.supportSpans[0]!.sectionTitle).toBe("Results");
    expect(g.supportSpans[0]!.bm25Score).toBeUndefined();
    expect(g.blocksDownstream).toBe(false);
  });

  it("downgrades grounded to ambiguous when a quote is not in the manuscript", () => {
    const manuscript = "Only this sentence appears.";
    const { grounding: g, quoteVerification } =
      mapLlmParsedResponseToClaimGrounding({
        analystClaim: "hypothesis",
        response: {
          status: "grounded",
          normalizedClaim: "hypothesis",
          supportSpans: [{ verbatimQuote: "hallucinated quote" }],
          detailReason: "Looks good.",
        },
        manuscript,
      });
    expect(g.status).toBe("ambiguous");
    expect(g.detailReason).toContain("verification:");
    expect(quoteVerification.overallOk).toBe(false);
    expect(quoteVerification.failures).toHaveLength(1);
  });
});
