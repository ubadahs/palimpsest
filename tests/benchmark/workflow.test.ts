import { describe, expect, it } from "vitest";

import type { CalibrationSet } from "../../src/domain/types.js";
import {
  applyCalibrationDeltas,
  createBlindCalibrationSet,
  diffCalibrationSets,
  summarizeBenchmarkCandidates,
} from "../../src/benchmark/workflow.js";

function makeCalibrationSet(): CalibrationSet {
  return {
    seed: { doi: "10.1234/seed", trackedClaim: "Claim" },
    resolvedSeedPaperTitle: "Seed Paper",
    studyMode: "all_functions_census",
    createdAt: "2026-03-27T00:00:00.000Z",
    targetSize: 2,
    records: [
      {
        recordId: "record-1",
        taskId: "task-1",
        evaluationMode: "fidelity_specific_claim",
        citationRole: "substantive_attribution",
        modifiers: { isBundled: false, isReviewMediated: false },
        citingPaperTitle: "Paper One",
        citedPaperTitle: "Seed Paper",
        citingSpan: "Span 1",
        citingSpanSection: "Results",
        citingMarker: "Belicova et al., 2021",
        rubricQuestion: "Question 1",
        evidenceSpans: [],
        evidenceRetrievalStatus: "retrieved",
        verdict: "supported",
        rationale: "Good support",
        retrievalQuality: "high",
        judgeConfidence: "high",
        adjudicator: "human",
        adjudicatedAt: "2026-03-27T00:00:00.000Z",
        excluded: undefined,
        excludeReason: undefined,
        telemetry: undefined,
      },
      {
        recordId: "record-2",
        taskId: "task-2",
        evaluationMode: "fidelity_methods_use",
        citationRole: "methods_materials",
        modifiers: { isBundled: false, isReviewMediated: false },
        citingPaperTitle: "Paper Two",
        citedPaperTitle: "Seed Paper",
        citingSpan: "Span 2",
        citingSpanSection: "Methods",
        citingMarker: "Belicova et al., 2021",
        rubricQuestion: "Question 2",
        evidenceSpans: [],
        evidenceRetrievalStatus: "no_fulltext",
        verdict: "cannot_determine",
        rationale: "Missing full text",
        retrievalQuality: "low",
        judgeConfidence: "medium",
        adjudicator: "human",
        adjudicatedAt: "2026-03-27T00:00:00.000Z",
        excluded: true,
        excludeReason: "Reference block",
        telemetry: undefined,
      },
    ],
    samplingStrategy: {
      targetByMode: { fidelity_specific_claim: 1 },
      oversampled: [],
    },
    runTelemetry: undefined,
    version: "v2",
    revisionNote: "Labeled",
  };
}

describe("benchmark workflow", () => {
  it("creates blind calibration sets without adjudication fields on active records", () => {
    const blind = createBlindCalibrationSet(makeCalibrationSet());

    expect(blind.records[0]).not.toHaveProperty("verdict");
    expect(blind.records[0]).not.toHaveProperty("adjudicator");
    expect(blind.records[1]).toMatchObject({
      taskId: "task-2",
      verdict: "cannot_determine",
      adjudicator: "human",
      excluded: true,
      excludeReason: "Reference block",
    });
    expect(blind.version).toBe("v2-blind");
  });

  it("diffs adjudication datasets by taskId", () => {
    const base = makeCalibrationSet();
    const candidate: CalibrationSet = {
      ...base,
      records: [
        { ...base.records[0]!, verdict: "partially_supported" },
        base.records[1]!,
      ],
    };

    const diff = diffCalibrationSets(base, candidate);

    expect(diff.summary.changedVerdicts).toBe(1);
    expect(diff.entries[0]!.verdictChanged).toBe(true);
  });

  it("ignores adjudication-only diffs on excluded records", () => {
    const base = makeCalibrationSet();
    const candidate: CalibrationSet = {
      ...base,
      records: [
        base.records[0]!,
        {
          ...base.records[1]!,
          verdict: "supported",
          rationale: "Should be ignored in diff scoring",
          retrievalQuality: "high",
        },
      ],
    };

    const diff = diffCalibrationSets(base, candidate);

    expect(diff.summary.changedVerdicts).toBe(0);
    expect(diff.summary.changedRationales).toBe(0);
    expect(diff.entries[1]!.verdictChanged).toBe(false);
    expect(diff.entries[1]!.rationaleChanged).toBe(false);
    expect(diff.entries[1]!.retrievalQualityChanged).toBe(false);
  });

  it("summarizes benchmark candidates against active adjudicated records only", () => {
    const base = makeCalibrationSet();
    const exactCandidate: CalibrationSet = {
      ...base,
      runTelemetry: {
        model: "claude-opus-4-6",
        useExtendedThinking: false,
        totalCalls: 1,
        successfulCalls: 1,
        failedCalls: 0,
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalReasoningTokens: 0,
        totalTokens: 120,
        totalLatencyMs: 300,
        averageLatencyMs: 300,
        estimatedCostUsd: 0.01,
        calls: [],
      },
    };
    const changedCandidate: CalibrationSet = {
      ...base,
      runTelemetry: {
        model: "claude-sonnet-4-6",
        useExtendedThinking: true,
        totalCalls: 1,
        successfulCalls: 1,
        failedCalls: 0,
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalReasoningTokens: 10,
        totalTokens: 130,
        totalLatencyMs: 400,
        averageLatencyMs: 400,
        estimatedCostUsd: 0.01,
        calls: [],
      },
      records: [
        { ...base.records[0]!, verdict: "partially_supported" },
        base.records[1]!,
      ],
    };

    const summary = summarizeBenchmarkCandidates("/tmp/base.json", base, [
      { label: "changed", path: "/tmp/changed.json", set: changedCandidate },
      { label: "exact", path: "/tmp/exact.json", set: exactCandidate },
    ]);

    expect(summary.basePath).toBe("/tmp/base.json");
    expect(summary.entries.map((entry) => entry.label)).toEqual([
      "exact",
      "changed",
    ]);
    expect(summary.entries[0]).toMatchObject({
      label: "exact",
      activeRecords: 1,
      exactAgreement: 1,
      adjacentAgreement: 1,
      verdictChanges: 0,
      model: "claude-opus-4-6",
      useExtendedThinking: false,
    });
    expect(summary.entries[1]).toMatchObject({
      label: "changed",
      exactAgreement: 0,
      adjacentAgreement: 1,
      verdictChanges: 1,
      changedTaskIds: ["task-1"],
      model: "claude-sonnet-4-6",
      useExtendedThinking: true,
    });
  });

  it("applies deltas while preserving record order", () => {
    const base = makeCalibrationSet();
    const applied = applyCalibrationDeltas(base, {
      version: "v3",
      revisionNote: "Updated",
      deltas: [
        {
          taskId: "task-1",
          finalVerdict: "partially_supported",
          rationale: "Sharper interpretation",
          retrievalQuality: undefined,
          judgeConfidence: undefined,
          note: undefined,
          excluded: undefined,
          excludeReason: undefined,
          allowExcludedChange: undefined,
        },
      ],
    });

    expect(applied.records.map((record) => record.taskId)).toEqual([
      "task-1",
      "task-2",
    ]);
    expect(applied.records[0]!.verdict).toBe("partially_supported");
    expect(applied.version).toBe("v3");
  });

  it("rejects deltas for unknown tasks", () => {
    expect(() =>
      applyCalibrationDeltas(makeCalibrationSet(), {
        version: undefined,
        revisionNote: undefined,
        deltas: [
          {
            taskId: "unknown",
            finalVerdict: "supported",
            rationale: undefined,
            retrievalQuality: undefined,
            judgeConfidence: undefined,
            note: undefined,
            excluded: undefined,
            excludeReason: undefined,
            allowExcludedChange: undefined,
          },
        ],
      }),
    ).toThrow(/Unknown taskId/);
  });
});
