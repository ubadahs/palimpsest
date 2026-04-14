import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildStageInspectorPayload } from "../../src/ui-contract/selectors.js";

const baseSeed = {
  doi: "10.1234/seed",
  trackedClaim: "Tracked seed claim.",
};

const baseEvidenceSpan = {
  spanId: "span-1",
  text: "Evidence span text.",
  sectionTitle: "Results",
  blockKind: "body_paragraph",
  matchMethod: "bm25",
  relevanceScore: 0.91,
  bm25Score: 12.4,
};

const baseClassifiedMention = {
  mentionIndex: 0,
  rawContext: "Citing context around the mention.",
  citationMarker: "[1]",
  sectionTitle: "Discussion",
  isBundledCitation: false,
  bundleSize: 1,
  bundleRefIds: ["ref-1"],
  bundlePattern: "single",
  sourceType: "pdf_text",
  parser: "fixture-parser",
  isDuplicate: false,
  contextLength: 34,
  markerStyle: "numeric",
  contextType: "narrative_like",
  confidence: "high",
  provenance: {
    sourceType: "pdf_text",
    parser: "fixture-parser",
  },
  citationRole: "substantive_attribution",
  modifiers: {
    isBundled: false,
    isReviewMediated: false,
  },
  classificationSignals: ["single-citation", "assertive-language"],
};

describe("buildStageInspectorPayload", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "palimpsest-selectors-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeArtifact(name: string, payload: unknown): string {
    const path = join(tempRoot, name);
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
    return path;
  }

  it("builds the legacy discover payload from discovery artifacts", () => {
    const artifactPath = writeArtifact("discover-legacy.json", [
      {
        doi: "10.1234/legacy",
        status: "completed",
        statusDetail: "Claim extraction completed.",
        claims: [
          {
            claimText: "Neurons form stable laminae.",
            sourceSpans: ["Neurons form stable laminae."],
            section: "Results",
            citedReferences: ["[12]"],
            claimType: "finding",
            confidence: "high",
          },
        ],
        findingCount: 1,
        totalClaimCount: 1,
        generatedAt: "2026-04-09T00:00:00.000Z",
      },
    ]);

    const payload = buildStageInspectorPayload("discover", artifactPath);

    expect(payload.strategy).toBe("legacy");
    if (payload.strategy !== "legacy") {
      throw new Error("expected legacy discover payload");
    }
    expect(payload.papers).toHaveLength(1);
    expect(payload.papers[0]?.doi).toBe("10.1234/legacy");
    expect(payload.papers[0]?.claims[0]).toMatchObject({
      claimText: "Neurons form stable laminae.",
      section: "Results",
      claimType: "finding",
      confidence: "high",
    });
  });

  it("builds the attribution-first discover payload from attribution artifacts", () => {
    const artifactPath = writeArtifact("discover-attribution.json", [
      {
        doi: "10.1234/attr",
        neighborhood: {
          totalCitingPapers: 18,
          fullTextAvailableCount: 11,
        },
        probeSelection: {
          strategy: "budgeted",
          selectedCount: 5,
          excludedCount: 6,
        },
        mentionsHarvested: 14,
        inScopeExtractions: 8,
        familyCandidateCount: 3,
        shortlistEntries: [
          {
            trackedClaim: "Layer-specific targeting is preserved.",
            seedGroundingStatus: "grounded",
            supportingMentionCount: 4,
            supportingPaperCount: 2,
          },
        ],
        warnings: ["One citing paper was abstract-only."],
      },
    ]);

    const payload = buildStageInspectorPayload("discover", artifactPath);

    expect(payload.strategy).toBe("attribution_first");
    if (payload.strategy !== "attribution_first") {
      throw new Error("expected attribution-first discover payload");
    }
    expect(payload.results[0]?.mentionsHarvested).toBe(14);
    expect(payload.results[0]?.shortlistEntries[0]).toMatchObject({
      trackedClaim: "Layer-specific targeting is preserved.",
      supportingMentionCount: 4,
    });
  });

  it("builds the evidence payload with nested task and span fields", () => {
    const artifactPath = writeArtifact("evidence.json", {
      seed: baseSeed,
      resolvedSeedPaperTitle: "Seed paper title",
      studyMode: "all_functions_census",
      groundedSeedClaimText: "Grounded seed claim.",
      citedPaperFullTextAvailable: true,
      citedPaperSource: {
        resolutionStatus: "resolved",
        fetchStatus: "retrieved",
      },
      edges: [
        {
          packetId: "packet-1",
          citingPaperTitle: "Citing <i>paper</i>",
          citedPaperTitle: "Seed paper title",
          extractionState: "extracted",
          isReviewMediated: false,
          tasks: [
            {
              taskId: "task-1",
              evaluationMode: "fidelity_specific_claim",
              citationRole: "substantive_attribution",
              modifiers: {
                isBundled: false,
                isReviewMediated: false,
              },
              mentions: [baseClassifiedMention],
              mentionCount: 1,
              rubricQuestion: "Does the cited evidence support the claim?",
              citedPaperEvidenceSpans: [baseEvidenceSpan],
              evidenceRetrievalStatus: "retrieved",
            },
          ],
        },
      ],
      summary: {
        totalTasks: 1,
        tasksWithEvidence: 1,
        tasksNoFulltext: 0,
        tasksUnresolvedCitedPaper: 0,
        tasksNoMatches: 0,
        tasksAbstractOnlyMatches: 0,
        tasksNotAttempted: 0,
        totalEvidenceSpans: 1,
        tasksByMode: {
          fidelity_specific_claim: 1,
        },
      },
    });

    const payload = buildStageInspectorPayload("evidence", artifactPath);

    expect(payload.seed.doi).toBe("10.1234/seed");
    expect(payload.edges[0]?.tasks[0]).toMatchObject({
      taskId: "task-1",
      evidenceRetrievalStatus: "retrieved",
      rubricQuestion: "Does the cited evidence support the claim?",
    });
    expect(payload.edges[0]?.tasks[0]?.citingMentions[0]?.rawContext).toBe(
      "Citing context around the mention.",
    );
    expect(payload.edges[0]?.tasks[0]?.evidenceSpans[0]).toMatchObject({
      spanId: "span-1",
      matchMethod: "bm25",
      relevanceScore: 0.91,
      bm25Score: 12.4,
    });
  });

  it("builds the adjudicate payload with verdict counts and telemetry", () => {
    const artifactPath = writeArtifact("adjudicate.json", {
      seed: baseSeed,
      resolvedSeedPaperTitle: "Seed paper title",
      studyMode: "all_functions_census",
      createdAt: "2026-04-09T00:00:00.000Z",
      targetSize: 20,
      records: [
        {
          recordId: "record-1",
          taskId: "task-1",
          evaluationMode: "fidelity_specific_claim",
          citationRole: "substantive_attribution",
          modifiers: {
            isBundled: false,
            isReviewMediated: false,
          },
          citingPaperTitle: "Citing paper title",
          citedPaperTitle: "Seed paper title",
          citingSpan: "The citing paper says X.",
          citingMarker: "[1]",
          rubricQuestion: "Does the cited evidence support the claim?",
          evidenceSpans: [baseEvidenceSpan],
          evidenceRetrievalStatus: "retrieved",
          verdict: "partially_supported",
          rationale:
            "Support is directionally correct but softened by context.",
          retrievalQuality: "high",
          judgeConfidence: "medium",
          excluded: false,
        },
      ],
      samplingStrategy: {
        targetByMode: {
          fidelity_specific_claim: 1,
        },
        oversampled: [],
      },
      runTelemetry: {
        model: "claude-opus-4-6",
        useExtendedThinking: true,
        totalCalls: 1,
        successfulCalls: 1,
        failedCalls: 0,
        totalInputTokens: 1200,
        totalOutputTokens: 300,
        totalReasoningTokens: 100,
        totalTokens: 1600,
        totalLatencyMs: 1800,
        averageLatencyMs: 1800,
        estimatedCostUsd: 0.0123,
        calls: [
          {
            model: "claude-opus-4-6",
            inputTokens: 1200,
            outputTokens: 300,
            reasoningTokens: 100,
            totalTokens: 1600,
            latencyMs: 1800,
            finishReason: "stop",
            timestamp: "2026-04-09T00:00:01.000Z",
          },
        ],
      },
    });

    const payload = buildStageInspectorPayload("adjudicate", artifactPath);

    expect(payload.defaultVerdictFilter).toBe("partially_supported");
    expect(payload.verdictCounts.partially_supported).toBe(1);
    expect(payload.highlightedTaskIds).toEqual(["task-1"]);
    expect(payload.runTelemetry?.estimatedCostUsd).toBe(0.0123);
    expect(payload.records[0]).toMatchObject({
      taskId: "task-1",
      verdict: "partially_supported",
      rationale: "Support is directionally correct but softened by context.",
    });
  });
});
