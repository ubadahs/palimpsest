import { describe, expect, it } from "vitest";

import type {
  CitationMention,
  ClassifiedMention,
  EdgeEvaluationPacket,
  EvaluationTask,
  FamilyClassificationResult,
} from "../../src/domain/types.js";
import { retrieveEvidence } from "../../src/retrieval/evidence-retrieval.js";

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

describe("retrieveEvidence", () => {
  it("retrieves matching spans from cited paper text", () => {
    const classification = makeClassification([makePacket([makeTask()])]);

    const result = retrieveEvidence(classification, CITED_PAPER_TEXT);

    expect(result.citedPaperFullTextAvailable).toBe(true);
    expect(result.summary.totalTasks).toBe(1);
    expect(result.summary.tasksWithEvidence).toBeGreaterThanOrEqual(1);

    const task = result.edges[0]!.tasks[0]!;
    expect(task.evidenceRetrievalStatus).toBe("retrieved");
    expect(task.citedPaperEvidenceSpans.length).toBeGreaterThan(0);
    expect(task.rubricQuestion).toContain("cited paper");
  });

  it("reports no_fulltext when cited paper text is undefined", () => {
    const classification = makeClassification([makePacket([makeTask()])]);

    const result = retrieveEvidence(classification, undefined);

    expect(result.citedPaperFullTextAvailable).toBe(false);
    expect(result.summary.tasksNoFulltext).toBe(1);
  });

  it("assigns correct rubric question per evaluation mode", () => {
    const methodsTask = makeTask({
      taskId: "task-methods",
      evaluationMode: "fidelity_methods_use",
      citationRole: "methods_materials",
    });
    const classification = makeClassification([makePacket([methodsTask])]);

    const result = retrieveEvidence(classification, CITED_PAPER_TEXT);
    const task = result.edges[0]!.tasks[0]!;

    expect(task.rubricQuestion).toContain("method");
  });

  it("skips evidence retrieval for low-information tasks", () => {
    const lowInfoTask = makeTask({
      taskId: "task-low",
      evaluationMode: "skip_low_information",
      citationRole: "acknowledgment_or_low_information",
    });
    const classification = makeClassification([makePacket([lowInfoTask])]);

    const result = retrieveEvidence(classification, CITED_PAPER_TEXT);
    const task = result.edges[0]!.tasks[0]!;

    expect(task.evidenceRetrievalStatus).toBe("not_attempted");
  });
});
