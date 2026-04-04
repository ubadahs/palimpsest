import { describe, expect, it } from "vitest";

import type {
  EdgeWithEvidence,
  EvidenceSpan,
  FamilyEvidenceResult,
  TaskWithEvidence,
} from "../../src/domain/types.js";
import { sampleCalibrationSet } from "../../src/adjudication/sample-calibration.js";

function makeSpan(score: number = 12): EvidenceSpan {
  return {
    spanId: "span-1",
    text: "Evidence text from the cited paper about Rab35 and apical bulkheads.",
    sectionTitle: undefined,
    blockKind: "body_paragraph",
    matchMethod: "bm25",
    relevanceScore: score,
    bm25Score: score,
    charOffsetStart: 0,
    charOffsetEnd: 100,
  };
}

function makeTask(
  role: TaskWithEvidence["citationRole"],
  mode: TaskWithEvidence["evaluationMode"],
  overrides: Partial<TaskWithEvidence> = {},
): TaskWithEvidence {
  return {
    taskId: `task-${role}-${String(Math.random()).slice(2, 6)}`,
    evaluationMode: mode,
    citationRole: role,
    modifiers: { isBundled: false, isReviewMediated: false },
    mentions: [
      {
        mentionIndex: 0,
        rawContext: "Belicova et al., 2021 demonstrated X.",
        citationMarker: "Belicova et al., 2021",
        sectionTitle: "Results",
        isDuplicate: false,
        contextLength: 40,
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
        citationRole: role,
        modifiers: { isBundled: false, isReviewMediated: false },
        classificationSignals: [],
      },
    ],
    mentionCount: 1,
    rubricQuestion: "Test rubric?",
    citedPaperEvidenceSpans: [makeSpan()],
    evidenceRetrievalStatus: "retrieved",
    ...overrides,
  };
}

function makeEvidence(tasks: TaskWithEvidence[]): FamilyEvidenceResult {
  const edges: EdgeWithEvidence[] = tasks.map((t) => ({
    packetId: `packet-${t.taskId}`,
    citingPaperTitle: "Citing Paper",
    citedPaperTitle: "Seed Paper",
    extractionState: "extracted",
    isReviewMediated: false,
    tasks: [t],
  }));

  return {
    seed: { doi: "10.1234/seed", trackedClaim: "Test claim" },
    resolvedSeedPaperTitle: "Seed Paper",
    studyMode: "all_functions_census",
    citedPaperFullTextAvailable: true,
    citedPaperSource: {
      resolutionStatus: "resolved",
      resolutionError: undefined,
      resolvedPaper: undefined,
      fetchStatus: "retrieved",
      fetchError: undefined,
      fullTextFormat: "jats_xml",
    },
    edges,
    summary: {
      totalTasks: tasks.length,
      tasksWithEvidence: tasks.length,
      tasksNoFulltext: 0,
      tasksUnresolvedCitedPaper: 0,
      tasksNoMatches: 0,
      tasksAbstractOnlyMatches: 0,
      tasksNotAttempted: 0,
      totalEvidenceSpans: tasks.length,
      tasksByMode: {},
    },
  };
}

describe("sampleCalibrationSet", () => {
  it("samples tasks up to the target size", () => {
    const tasks = [
      makeTask("substantive_attribution", "fidelity_specific_claim"),
      makeTask("background_context", "fidelity_background_framing"),
      makeTask("methods_materials", "fidelity_methods_use"),
    ];
    const evidence = makeEvidence(tasks);
    const set = sampleCalibrationSet(evidence, undefined, 40);

    expect(set.records.length).toBeLessThanOrEqual(40);
    expect(set.records.length).toBe(3);
    expect(set.targetSize).toBe(40);
  });

  it("produces records with correct structure", () => {
    const tasks = [
      makeTask("substantive_attribution", "fidelity_specific_claim"),
    ];
    const evidence = makeEvidence(tasks);
    const set = sampleCalibrationSet(evidence, undefined, 10);

    const record = set.records[0]!;
    expect(record.taskId).toBeDefined();
    expect(record.evaluationMode).toBe("fidelity_specific_claim");
    expect(record.citationRole).toBe("substantive_attribution");
    expect(record.rubricQuestion).toBeDefined();
    expect(record.evidenceSpans.length).toBeGreaterThan(0);
    expect(record.verdict).toBeUndefined();
    expect(record.rationale).toBeUndefined();
  });

  it("oversamples hard cases with higher priority", () => {
    const normal = makeTask(
      "substantive_attribution",
      "fidelity_specific_claim",
    );
    const bundledBg = makeTask("background_context", "fidelity_bundled_use", {
      modifiers: { isBundled: true, isReviewMediated: false },
    });
    const evidence = makeEvidence([normal, bundledBg]);
    const set = sampleCalibrationSet(evidence, undefined, 2);

    expect(set.records).toHaveLength(2);
    expect(set.samplingStrategy.oversampled.length).toBeGreaterThan(0);
  });

  it("skips not_attempted tasks", () => {
    const skipped = makeTask(
      "acknowledgment_or_low_information",
      "skip_low_information",
      {
        evidenceRetrievalStatus: "not_attempted",
        citedPaperEvidenceSpans: [],
      },
    );
    const evidence = makeEvidence([skipped]);
    const set = sampleCalibrationSet(evidence, undefined, 10);

    expect(set.records).toHaveLength(0);
  });

  it("includes seed and study mode in the set", () => {
    const tasks = [
      makeTask("substantive_attribution", "fidelity_specific_claim"),
    ];
    const evidence = makeEvidence(tasks);
    const set = sampleCalibrationSet(evidence, undefined, 10);

    expect(set.seed.doi).toBe("10.1234/seed");
    expect(set.studyMode).toBe("all_functions_census");
    expect(set.createdAt).toBeDefined();
  });
});
