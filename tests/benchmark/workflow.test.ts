import { describe, expect, it } from "vitest";

import type {
  AuditSample,
  FidelityVectorTrace,
} from "../../src/domain/types.js";
import {
  applyAuditSampleDeltas,
  createBlindAuditSample,
  diffAuditSamples,
  summarizeBenchmarkCandidates,
} from "../../src/benchmark/workflow.js";

function makeAuditSample(): AuditSample {
  const fidelityVectorTrace = {
    version: "fidelity-vector-trace-v1",
    model: "claude-sonnet-4-6",
    temperature: 0.7,
    sampleCount: 0,
    samples: [],
    aggregate: {
      meanAxes: {
        support: 0,
        evidenceGrounding: 0,
        claimIdentity: 0,
        directionalAlignment: 0,
        scopeMatch: 0,
        certaintyMatch: 0,
        attributionDirectness: 0,
        uncertainty: 0,
      },
      varianceAxes: {
        support: 0,
        evidenceGrounding: 0,
        claimIdentity: 0,
        directionalAlignment: 0,
        scopeMatch: 0,
        certaintyMatch: 0,
        attributionDirectness: 0,
        uncertainty: 0,
      },
      verdictDistribution: {
        sampleCount: 0,
        counts: {
          supported: 0,
          partially_supported: 0,
          overstated_or_generalized: 0,
          not_supported: 0,
          cannot_determine: 0,
        },
        modalVerdict: "cannot_determine",
        entropy: 0,
      },
      scopeDirectionDistribution: {
        none: 0,
        expansion: 0,
        contraction: 0,
        shift: 0,
        unclear: 0,
      },
      certaintyDirectionDistribution: {
        none: 0,
        escalation: 0,
        deflation: 0,
        shift: 0,
        unclear: 0,
      },
      disagreementScore: 0,
      overallUncertainty: 0,
    },
  } as FidelityVectorTrace;

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
        fidelityVectorTrace,
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
  it("creates blind audit samples without adjudication fields on active records", () => {
    const blind = createBlindAuditSample(makeAuditSample());

    expect(blind.records[0]).not.toHaveProperty("verdict");
    expect(blind.records[0]).not.toHaveProperty("adjudicator");
    expect(blind.records[0]).not.toHaveProperty("fidelityVectorTrace");
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
    const base = makeAuditSample();
    const candidate: AuditSample = {
      ...base,
      records: [
        { ...base.records[0]!, verdict: "partially_supported" },
        base.records[1]!,
      ],
    };

    const diff = diffAuditSamples(base, candidate);

    expect(diff.summary.changedVerdicts).toBe(1);
    expect(diff.entries[0]!.verdictChanged).toBe(true);
  });

  it("ignores adjudication-only diffs on excluded records", () => {
    const base = makeAuditSample();
    const candidate: AuditSample = {
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

    const diff = diffAuditSamples(base, candidate);

    expect(diff.summary.changedVerdicts).toBe(0);
    expect(diff.summary.changedRationales).toBe(0);
    expect(diff.entries[1]!.verdictChanged).toBe(false);
    expect(diff.entries[1]!.rationaleChanged).toBe(false);
    expect(diff.entries[1]!.retrievalQualityChanged).toBe(false);
  });

  it("summarizes benchmark candidates against active adjudicated records only", () => {
    const base = makeAuditSample();
    const exactCandidate: AuditSample = {
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
    const changedCandidate: AuditSample = {
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
    const base = makeAuditSample();
    const applied = applyAuditSampleDeltas(base, {
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
      applyAuditSampleDeltas(makeAuditSample(), {
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
