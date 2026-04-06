import { describe, expect, it } from "vitest";

import { buildPackets } from "../../src/classification/build-packets.js";
import { sampleCalibrationSet } from "../../src/adjudication/sample-calibration.js";
import {
  familyClassificationResultSchema,
  familyEvidenceResultSchema,
  type EdgeClassification,
  type FamilyExtractionResult,
} from "../../src/domain/types.js";
import { retrieveEvidence } from "../../src/retrieval/evidence-retrieval.js";
import { parseParsedPaperDocument } from "../../src/retrieval/parsed-paper.js";

const EDGE_CLASSIFICATION: EdgeClassification = {
  isReview: false,
  isCommentary: false,
  isLetter: false,
  isBookChapter: false,
  isPreprint: false,
  isJournalArticle: true,
  isPrimaryLike: true,
  highReferenceCount: false,
};

const CITED_XML = `<?xml version="1.0"?>
<article>
  <body>
    <sec>
      <title>Results</title>
      <p>Silencing of Rab35 resulted in loss of apical bulkheads and cyst formation in hepatocytes.</p>
    </sec>
  </body>
</article>`;

function makeExtraction(): FamilyExtractionResult {
  return {
    seed: { doi: "10.1234/seed", trackedClaim: "Rab35 claim" },
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
      referencedWorksCount: 10,
      publicationYear: 2021,
    },
    edgeResults: [
      {
        citingPaperId: "edge-1",
        citedPaperId: "seed-1",
        citingPaperTitle: "Citing Paper",
        sourceType: "jats_xml",
        extractionOutcome: "success_structured",
        extractionSuccess: true,
        usableForGrounding: true,
        rawMentionCount: 1,
        deduplicatedMentionCount: 1,
        mentions: [
          {
            mentionIndex: 0,
            rawContext:
              "Belicova et al., 2021 demonstrated that silencing Rab35 results in loss of apical bulkheads and cyst formation in hepatocytes.",
            citationMarker: "Belicova et al., 2021",
            sectionTitle: "Results",
            isDuplicate: false,
            contextLength: 120,
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
          },
        ],
        failureReason: undefined,
      },
    ],
    summary: {
      totalEdges: 1,
      attemptedEdges: 1,
      successfulEdgesRaw: 1,
      successfulEdgesUsable: 1,
      rawMentionCount: 1,
      deduplicatedMentionCount: 1,
      usableMentionCount: 1,
      failureCountsByOutcome: {},
    },
  };
}

describe("M3→M4→M5 fixture chain", () => {
  it("produces validated, section-aware evidence and calibration outputs", async () => {
    const classification = familyClassificationResultSchema.parse(
      buildPackets(makeExtraction(), "all_functions_census", {
        "edge-1": EDGE_CLASSIFICATION,
      }),
    );

    const parsed = parseParsedPaperDocument(CITED_XML, "jats_xml");
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    const evidence = familyEvidenceResultSchema.parse(
      await retrieveEvidence(
        classification,
        {
          resolutionStatus: "resolved",
          resolutionError: undefined,
          resolvedPaper: undefined,
          fetchStatus: "retrieved",
          fetchError: undefined,
          fullTextFormat: "jats_xml",
        },
        parsed.data,
      ),
    );

    expect(
      evidence.edges[0]!.tasks[0]!.citedPaperEvidenceSpans[0]!.sectionTitle,
    ).toBe("Results");

    const calibration = sampleCalibrationSet(evidence, undefined, 10);
    expect(calibration.records).toHaveLength(1);
    expect(calibration.records[0]!.evidenceSpans[0]!.sectionTitle).toBe(
      "Results",
    );
  });
});
