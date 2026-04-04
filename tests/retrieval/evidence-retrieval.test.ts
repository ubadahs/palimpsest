import { describe, expect, it } from "vitest";

import type {
  CitationMention,
  CitedPaperSource,
  ClassifiedMention,
  EdgeEvaluationPacket,
  EvaluationTask,
  FullTextFormat,
  FamilyClassificationResult,
  ParsedPaperDocument,
} from "../../src/domain/types.js";
import { retrieveEvidence } from "../../src/retrieval/evidence-retrieval.js";
import { parseParsedPaperDocument } from "../../src/retrieval/parsed-paper.js";

function makeMention(
  overrides: Partial<CitationMention> = {},
): ClassifiedMention {
  return {
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
    citationRole: "substantive_attribution",
    modifiers: { isBundled: false, isReviewMediated: false },
    classificationSignals: [],
    ...overrides,
  };
}

function makeTask(overrides: Partial<EvaluationTask> = {}): EvaluationTask {
  return {
    taskId: "task-1",
    evaluationMode: "fidelity_specific_claim",
    citationRole: "substantive_attribution",
    modifiers: { isBundled: false, isReviewMediated: false },
    mentions: [makeMention()],
    mentionCount: 1,
    ...overrides,
  };
}

function makePacket(tasks: EvaluationTask[]): EdgeEvaluationPacket {
  return {
    packetId: "packet-1",
    studyMode: "all_functions_census",
    citingPaper: {
      id: "c1",
      doi: undefined,
      title: "Citing Paper",
      paperType: "article",
    },
    citedPaper: {
      id: "s1",
      doi: "10.1234/seed",
      title: "Seed Paper",
      authors: ["Author"],
      publicationYear: 2021,
    },
    extractionState: "extracted",
    extractionOutcome: "success_structured",
    auditabilityStatus: "auditable_structured",
    sourceType: "jats_xml",
    extractionConfidence: "high",
    usableForGrounding: true,
    failureReason: undefined,
    mentions: tasks.flatMap((t) => t.mentions),
    tasks,
    rolesPresent: ["substantive_attribution"],
    isReviewMediated: false,
    requiresManualReview: false,
    usableMentionsCount: 1,
    bundledMentionsCount: 0,
    cachedPaperRef: undefined,
    provenance: {
      preScreenRunId: undefined,
      extractionRunId: undefined,
      classificationTimestamp: new Date().toISOString(),
    },
  };
}

function makeClassification(
  packets: EdgeEvaluationPacket[],
): FamilyClassificationResult {
  return {
    seed: { doi: "10.1234/seed", trackedClaim: "Test claim" },
    resolvedSeedPaperTitle: "Seed Paper",
    studyMode: "all_functions_census",
    packets,
    summary: {
      extractionState: {
        totalEdges: packets.length,
        extracted: packets.length,
        failed: 0,
        skipped: 0,
        failureCountsByOutcome: {},
      },
      literatureStructure: {
        edgesWithMentions: packets.length,
        totalMentions: 1,
        totalTasks: 1,
        countsByRole: {
          substantive_attribution: 1,
          background_context: 0,
          methods_materials: 0,
          acknowledgment_or_low_information: 0,
          unclear: 0,
        },
        countsByMode: {
          fidelity_specific_claim: 1,
          fidelity_background_framing: 0,
          fidelity_bundled_use: 0,
          fidelity_methods_use: 0,
          review_transmission: 0,
          skip_low_information: 0,
          manual_review_role_ambiguous: 0,
          manual_review_extraction_limited: 0,
        },
        bundledMentionCount: 0,
        bundledMentionRate: 0,
        reviewMediatedEdgeCount: 0,
        reviewMediatedEdgeRate: 0,
        manualReviewTaskCount: 0,
      },
    },
  };
}

const CITED_PAPER_TEXT = [
  "Abstract",
  "",
  "",
  "Lumen morphogenesis results from the interplay between molecular pathways and mechanical forces. " +
    "In the liver, hepatocytes share the apical surface only between adjacent cells.",
  "",
  "",
  "Silencing of Rab35 resulted in loss of apical bulkheads and lumen anisotropy, " +
    "leading to cyst formation. The bulkhead structures enforce the elongation of bile canaliculi.",
  "",
  "",
  "Hepatocyte polarity is regulated by multiple signaling pathways " +
    "including Par1b and E-cadherin mediated adhesion.",
].join("\n");

const CITED_PAPER_XML = `<?xml version="1.0"?>
<article>
  <front>
    <abstract>
      <p>Apical bulkheads are important for hepatocyte lumen morphogenesis.</p>
    </abstract>
  </front>
  <body>
    <sec>
      <title>Results</title>
      <p>Silencing of Rab35 resulted in loss of apical bulkheads and cyst formation in hepatocytes.</p>
    </sec>
  </body>
</article>`;

function makeSource(
  overrides: Partial<CitedPaperSource> = {},
): CitedPaperSource {
  return {
    resolutionStatus: "resolved",
    resolutionError: undefined,
    resolvedPaper: undefined,
    fetchStatus: "retrieved",
    fetchError: undefined,
    fullTextFormat: "jats_xml",
    ...overrides,
  };
}

function parseDocumentOrThrow(
  fullText: string,
  format: FullTextFormat,
): ParsedPaperDocument {
  const parsed = parseParsedPaperDocument(fullText, format);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.data;
}

describe("retrieveEvidence", () => {
  it("retrieves matching spans from cited paper text", async () => {
    const classification = makeClassification([makePacket([makeTask()])]);

    const result = await retrieveEvidence(
      classification,
      makeSource({ fullTextFormat: "pdf_text" }),
      parseDocumentOrThrow(CITED_PAPER_TEXT, "pdf_text"),
    );

    expect(result.citedPaperFullTextAvailable).toBe(true);
    expect(result.summary.totalTasks).toBe(1);
    expect(result.summary.tasksWithEvidence).toBeGreaterThanOrEqual(1);

    const task = result.edges[0]!.tasks[0]!;
    expect(task.evidenceRetrievalStatus).toBe("retrieved");
    expect(task.citedPaperEvidenceSpans.length).toBeGreaterThan(0);
    expect(task.rubricQuestion).toContain("cited paper");
  });

  it("reports no_fulltext when cited paper text is undefined", async () => {
    const classification = makeClassification([makePacket([makeTask()])]);

    const result = await retrieveEvidence(
      classification,
      makeSource({ fetchStatus: "no_fulltext", fullTextFormat: undefined }),
      undefined,
    );

    expect(result.citedPaperFullTextAvailable).toBe(false);
    expect(result.summary.tasksNoFulltext).toBe(1);
  });

  it("assigns correct rubric question per evaluation mode", async () => {
    const methodsTask = makeTask({
      taskId: "task-methods",
      evaluationMode: "fidelity_methods_use",
      citationRole: "methods_materials",
    });
    const classification = makeClassification([makePacket([methodsTask])]);

    const result = await retrieveEvidence(
      classification,
      makeSource({ fullTextFormat: "pdf_text" }),
      parseDocumentOrThrow(CITED_PAPER_TEXT, "pdf_text"),
    );
    const task = result.edges[0]!.tasks[0]!;

    expect(task.rubricQuestion).toContain("method");
  });

  it("skips evidence retrieval for low-information tasks", async () => {
    const lowInfoTask = makeTask({
      taskId: "task-low",
      evaluationMode: "skip_low_information",
      citationRole: "acknowledgment_or_low_information",
    });
    const classification = makeClassification([makePacket([lowInfoTask])]);

    const result = await retrieveEvidence(
      classification,
      makeSource({ fetchStatus: "no_fulltext", fullTextFormat: undefined }),
      undefined,
    );
    const task = result.edges[0]!.tasks[0]!;

    expect(task.evidenceRetrievalStatus).toBe("not_attempted");
    expect(result.summary.tasksNotAttempted).toBe(1);
  });

  it("distinguishes unresolved cited papers from missing full text", async () => {
    const classification = makeClassification([makePacket([makeTask()])]);

    const result = await retrieveEvidence(
      classification,
      makeSource({
        resolutionStatus: "resolution_failed",
        resolutionError: "DOI lookup failed",
        fetchStatus: "not_attempted",
        fullTextFormat: undefined,
      }),
      undefined,
    );

    expect(result.summary.tasksUnresolvedCitedPaper).toBe(1);
    expect(result.edges[0]!.tasks[0]!.evidenceRetrievalStatus).toBe(
      "unresolved_cited_paper",
    );
  });

  it("preserves section labels for JATS-derived evidence spans", async () => {
    const classification = makeClassification([makePacket([makeTask()])]);

    const result = await retrieveEvidence(
      classification,
      makeSource({ fullTextFormat: "jats_xml" }),
      parseDocumentOrThrow(CITED_PAPER_XML, "jats_xml"),
    );

    expect(
      result.edges[0]!.tasks[0]!.citedPaperEvidenceSpans[0]!.sectionTitle,
    ).toBe("Results");
  });

  it("downgrades abstract-only matches instead of emitting evidence spans", async () => {
    const classification = makeClassification([makePacket([makeTask()])]);
    const abstractOnlyXml = `<?xml version="1.0"?>
<article>
  <front>
    <abstract>
      <p>Silencing of Rab35 resulted in loss of apical bulkheads and cyst formation in hepatocytes.</p>
    </abstract>
  </front>
  <body>
    <sec>
      <title>Results</title>
      <p>Unrelated body text about lumen morphology and tissue organization.</p>
    </sec>
  </body>
</article>`;

    const result = await retrieveEvidence(
      classification,
      makeSource({ fullTextFormat: "jats_xml" }),
      parseDocumentOrThrow(abstractOnlyXml, "jats_xml"),
    );

    expect(result.summary.tasksAbstractOnlyMatches).toBe(1);
    expect(result.edges[0]!.tasks[0]!.evidenceRetrievalStatus).toBe(
      "abstract_only_matches",
    );
    expect(result.edges[0]!.tasks[0]!.citedPaperEvidenceSpans).toHaveLength(0);
  });

  it("uses reranker results when available and falls back cleanly on reranker errors", async () => {
    const classification = makeClassification([makePacket([makeTask()])]);
    const parsedDocument = parseDocumentOrThrow(CITED_PAPER_XML, "jats_xml");

    const reranked = await retrieveEvidence(
      classification,
      makeSource({ fullTextFormat: "jats_xml" }),
      parsedDocument,
      {
        reranker: {
          healthCheck: () => Promise.resolve({ ok: true as const, data: "ok" }),
          rerank: () =>
            Promise.resolve({
              ok: true as const,
              data: {
                results: [
                  {
                    id: parsedDocument.blocks[0]!.blockId,
                    score: 42,
                    rank: 1,
                  },
                ],
              },
            }),
        },
      },
    );

    expect(
      reranked.edges[0]!.tasks[0]!.citedPaperEvidenceSpans[0]!.matchMethod,
    ).toBe("bm25_reranked");
    expect(
      reranked.edges[0]!.tasks[0]!.citedPaperEvidenceSpans[0]!.rerankScore,
    ).toBe(42);

    const fallback = await retrieveEvidence(
      classification,
      makeSource({ fullTextFormat: "jats_xml" }),
      parsedDocument,
      {
        reranker: {
          healthCheck: () => Promise.resolve({ ok: true as const, data: "ok" }),
          rerank: () =>
            Promise.resolve({ ok: false as const, error: "timeout" }),
        },
      },
    );

    expect(
      fallback.edges[0]!.tasks[0]!.citedPaperEvidenceSpans[0]!.matchMethod,
    ).toBe("bm25");
  });
});
