import { describe, expect, it } from "vitest";

import type {
  CitationMention,
  EdgeClassification,
  EdgeExtractionResult,
  FamilyExtractionResult,
} from "../../src/domain/types.js";
import { buildPackets } from "../../src/classification/build-packets.js";

function makeMention(
  overrides: Partial<CitationMention> = {},
): CitationMention {
  return {
    mentionIndex: 0,
    rawContext:
      "Belicova et al., 2021 demonstrated that silencing Rab35 leads to cyst formation.",
    citationMarker: "Belicova et al., 2021",
    sectionTitle: "Results",
    isDuplicate: false,
    contextLength: 80,
    markerStyle: "author_year",
    contextType: "narrative_like",
    confidence: "high",
    isBundledCitation: false,
    bundleSize: 1,
    bundleRefIds: [],
    bundlePattern: "single",
    provenance: {
      sourceType: "jats_xml",
      parser: "jats-xref",
      refId: "bib2",
      charOffsetStart: 0,
      charOffsetEnd: 21,
    },
    ...overrides,
  };
}

function makeEdge(
  overrides: Partial<EdgeExtractionResult> = {},
): EdgeExtractionResult {
  return {
    citingPaperId: "edge-1",
    citedPaperId: "seed-1",
    citingPaperTitle: "Test Paper",
    sourceType: "jats_xml",
    extractionOutcome: "success_structured",
    extractionSuccess: true,
    usableForGrounding: true,
    rawMentionCount: 1,
    deduplicatedMentionCount: 1,
    mentions: [makeMention()],
    failureReason: undefined,
    ...overrides,
  };
}

function makeExtraction(edges: EdgeExtractionResult[]): FamilyExtractionResult {
  return {
    seed: { doi: "10.1234/seed", trackedClaim: "Test claim" },
    resolvedSeedPaper: {
      id: "seed-1",
      title: "Seed Paper",
      doi: "10.1234/seed",
      authors: ["Author A"],
      abstract: undefined,
      source: "openalex",
      openAccessUrl: undefined,
      fullTextStatus: { status: "available", source: "pmc_xml" },
      paperType: "article",
      referencedWorksCount: 40,
      publicationYear: 2021,
    },
    edgeResults: edges,
    summary: {
      totalEdges: edges.length,
      attemptedEdges: edges.length,
      successfulEdgesRaw: edges.filter((e) => e.extractionSuccess).length,
      successfulEdgesUsable: 0,
      rawMentionCount: 0,
      deduplicatedMentionCount: 0,
      usableMentionCount: 0,
      failureCountsByOutcome: {},
    },
  };
}

const defaultClassification: EdgeClassification = {
  isReview: false,
  isCommentary: false,
  isLetter: false,
  isBookChapter: false,
  isPreprint: false,
  isJournalArticle: true,
  isPrimaryLike: true,
  highReferenceCount: false,
};

describe("buildPackets", () => {
  it("builds one packet per edge with tasks grouped by role", () => {
    const extraction = makeExtraction([
      makeEdge(),
      makeEdge({ citingPaperId: "edge-2" }),
    ]);
    const result = buildPackets(extraction, "all_functions_census", {
      "edge-1": defaultClassification,
      "edge-2": defaultClassification,
    });

    expect(result.packets).toHaveLength(2);
    expect(result.summary.extractionState.totalEdges).toBe(2);
  });

  it("generates tasks from mention clusters within an edge", () => {
    const edge = makeEdge({
      mentions: [
        makeMention({
          rawContext: "Belicova et al., 2021 demonstrated X.",
          sectionTitle: "Results",
        }),
        makeMention({
          rawContext:
            "Hepatoblasts were isolated as described in Belicova et al., 2021.",
          sectionTitle: "Methods",
          mentionIndex: 1,
        }),
      ],
    });
    const result = buildPackets(
      makeExtraction([edge]),
      "all_functions_census",
      {
        "edge-1": defaultClassification,
      },
    );

    const packet = result.packets[0]!;
    expect(packet.tasks.length).toBeGreaterThanOrEqual(1);
    expect(packet.rolesPresent.length).toBeGreaterThanOrEqual(1);
    expect(packet.mentions).toHaveLength(2);
  });

  it("sets isReviewMediated modifier from edge classification", () => {
    const reviewClassification: EdgeClassification = {
      ...defaultClassification,
      isReview: true,
    };
    const result = buildPackets(
      makeExtraction([makeEdge()]),
      "all_functions_census",
      {
        "edge-1": reviewClassification,
      },
    );

    const packet = result.packets[0]!;
    expect(packet.isReviewMediated).toBe(true);
    for (const t of packet.tasks) {
      expect(t.modifiers.isReviewMediated).toBe(true);
      expect(t.evaluationMode).toBe("review_transmission");
    }
  });

  it("separates extraction state from literature structure in summary", () => {
    const extraction = makeExtraction([
      makeEdge(),
      makeEdge({
        citingPaperId: "edge-2",
        extractionOutcome: "fail_http_403",
        extractionSuccess: false,
        mentions: [],
      }),
    ]);
    const result = buildPackets(extraction, "all_functions_census", {
      "edge-1": defaultClassification,
      "edge-2": defaultClassification,
    });

    expect(result.summary.extractionState.extracted).toBe(1);
    expect(result.summary.extractionState.failed).toBe(1);
    expect(result.summary.literatureStructure.edgesWithMentions).toBe(1);
  });

  it("uses actual auditabilityStatus from pre-screen edge", () => {
    const result = buildPackets(
      makeExtraction([makeEdge()]),
      "all_functions_census",
      { "edge-1": defaultClassification },
      {
        "edge-1": {
          citingPaperId: "edge-1",
          citedPaperId: "seed-1",
          auditabilityStatus: "auditable_pdf",
          auditabilityReason: "PDF",
          classification: defaultClassification,
          paperType: "article",
          referencedWorksCount: 25,
        },
      },
    );

    expect(result.packets[0]!.auditabilityStatus).toBe("auditable_pdf");
  });
});
