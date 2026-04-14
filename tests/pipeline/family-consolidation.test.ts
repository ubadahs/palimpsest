import { describe, expect, it, vi } from "vitest";

import {
  consolidateFamilyCandidates,
  type ConsolidationCluster,
} from "../../src/pipeline/family-consolidation.js";
import type { AttributedClaimFamilyCandidate } from "../../src/domain/discovery.js";
import type { FamilyGroundingTrace } from "../../src/pipeline/discovery-family-probe.js";
import type { ClaimGrounding } from "../../src/domain/pre-screen.js";
import type { LLMClient } from "../../src/integrations/llm-client.js";

function makeCandidates(claims: string[]): AttributedClaimFamilyCandidate[] {
  return claims.map((claim, i) => ({
    familyId: `family_${String(i)}`,
    doi: "10.1234/test",
    canonicalTrackedClaim: claim,
    memberRecordIds: [`rec_${String(i)}`],
    memberMentionIds: [`men_${String(i)}`],
    memberCitingPaperIds: [`cp_${String(i)}`],
    seedGrounding: {
      status: "grounded" as const,
      supportSpanText: "some span",
      groundingDetail: "ok",
    },
    probeMetrics: {
      probePaperCount: 1,
      successfulHarvestCount: 1,
      harvestSuccessRate: 1,
      totalMentionCount: 1,
      uniqueCitingPaperCount: 1,
      auditableEdgeCount: 1,
      hasPrimaryPapers: true,
      hasReviewPapers: false,
    },
    shortlistEligible: true,
    shortlistReason: "test",
    dedupe: {
      dedupeGroupId: `group_${String(i)}`,
      dedupeStatus: "unique" as const,
      dedupeStrategy: "none" as const,
      mergedFamilyIds: [],
      mergedCanonicalClaims: [],
    },
  }));
}

function makeTraces(
  candidates: AttributedClaimFamilyCandidate[],
): FamilyGroundingTrace[] {
  return candidates.map((c) => ({
    familyId: c.familyId,
    canonicalTrackedClaim: c.canonicalTrackedClaim,
    grounding: {
      status: "grounded",
      analystClaim: c.canonicalTrackedClaim,
      normalizedClaim: c.canonicalTrackedClaim,
      supportSpans: [],
      blocksDownstream: false,
      detailReason: "ok",
    } satisfies ClaimGrounding,
  }));
}

function makeMockClient(clusters: ConsolidationCluster[]): LLMClient {
  return {
    generateText: vi.fn().mockResolvedValue({
      text: JSON.stringify({ clusters }),
      record: {
        purpose: "family-consolidation",
        model: "claude-opus-4-6",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 500,
        estimatedCostUsd: 0.01,
        latencyMs: 2000,
        success: true,
        exactCacheHit: false,
      },
    }),
    generateObject: vi.fn(),
    getLedger: vi.fn().mockReturnValue({
      totalAttemptedCalls: 1,
      totalSuccessfulCalls: 1,
      totalFailedCalls: 0,
      totalBillableCalls: 1,
      totalExactCacheHits: 0,
      totalEstimatedCostUsd: 0.01,
    }),
  };
}

describe("consolidateFamilyCandidates", () => {
  it("returns immediately for a single candidate without LLM call", async () => {
    const candidates = makeCandidates(["Claim A"]);
    const traces = makeTraces(candidates);
    const client = makeMockClient([]);
    const result = await consolidateFamilyCandidates(
      candidates,
      traces,
      client,
    );

    expect(result.consolidatedCandidates).toHaveLength(1);
    expect(result.eliminatedCount).toBe(0);
    expect(client.generateText).not.toHaveBeenCalled();
  });

  it("returns immediately for empty candidates", async () => {
    const client = makeMockClient([]);
    const result = await consolidateFamilyCandidates([], [], client);

    expect(result.consolidatedCandidates).toHaveLength(0);
    expect(result.eliminatedCount).toBe(0);
  });

  it("merges semantically equivalent candidates", async () => {
    const candidates = makeCandidates([
      "X causes Y in model Z",
      "X leads to Y in the Z system",
      "A completely different finding about W",
    ]);
    const traces = makeTraces(candidates);

    const client = makeMockClient([
      {
        cluster: 1,
        memberIndices: [0, 1],
        representativeIndex: 0,
        reasoning: "Both describe X causing Y in model Z.",
      },
      {
        cluster: 2,
        memberIndices: [2],
        representativeIndex: 2,
        reasoning: "Distinct finding about W.",
      },
    ]);

    const result = await consolidateFamilyCandidates(
      candidates,
      traces,
      client,
    );

    expect(result.consolidatedCandidates).toHaveLength(2);
    expect(result.eliminatedCount).toBe(1);
    expect(result.consolidatedCandidates[0]?.canonicalTrackedClaim).toBe(
      "X causes Y in model Z",
    );
    // Merged candidate should have union of member IDs.
    expect(result.consolidatedCandidates[0]?.memberRecordIds).toContain(
      "rec_1",
    );
    expect(result.consolidatedCandidates[0]?.memberMentionIds).toContain(
      "men_1",
    );
  });

  it("keeps all candidates when all are distinct", async () => {
    const candidates = makeCandidates(["A", "B", "C"]);
    const traces = makeTraces(candidates);

    const client = makeMockClient([
      {
        cluster: 1,
        memberIndices: [0],
        representativeIndex: 0,
        reasoning: "Unique.",
      },
      {
        cluster: 2,
        memberIndices: [1],
        representativeIndex: 1,
        reasoning: "Unique.",
      },
      {
        cluster: 3,
        memberIndices: [2],
        representativeIndex: 2,
        reasoning: "Unique.",
      },
    ]);

    const result = await consolidateFamilyCandidates(
      candidates,
      traces,
      client,
    );

    expect(result.consolidatedCandidates).toHaveLength(3);
    expect(result.eliminatedCount).toBe(0);
    expect(result.droppedGroundingTraces).toHaveLength(0);
  });

  it("records dropped grounding traces when representative already has one", async () => {
    const candidates = makeCandidates(["Claim A", "Claim B"]);
    const traces = makeTraces(candidates);

    const client = makeMockClient([
      {
        cluster: 1,
        memberIndices: [0, 1],
        representativeIndex: 0,
        reasoning: "Same finding.",
      },
    ]);

    const result = await consolidateFamilyCandidates(
      candidates,
      traces,
      client,
    );

    expect(result.consolidatedCandidates).toHaveLength(1);
    expect(result.consolidatedTraces).toHaveLength(1);
    expect(result.consolidatedTraces[0]?.familyId).toBe("family_0");
    expect(result.droppedGroundingTraces).toHaveLength(1);
    expect(result.droppedGroundingTraces[0]?.familyId).toBe("family_1");
  });

  it("inherits grounding trace when representative lacks one", async () => {
    const candidates = makeCandidates(["Claim A", "Claim B"]);
    // Only family_1 has a trace.
    const traces: FamilyGroundingTrace[] = [
      {
        familyId: "family_1",
        canonicalTrackedClaim: "Claim B",
        grounding: {
          status: "grounded",
          analystClaim: "Claim B",
          normalizedClaim: "Claim B",
          supportSpans: [],
          blocksDownstream: false,
          detailReason: "ok",
        } satisfies ClaimGrounding,
      },
    ];

    const client = makeMockClient([
      {
        cluster: 1,
        memberIndices: [0, 1],
        representativeIndex: 0,
        reasoning: "Same finding.",
      },
    ]);

    const result = await consolidateFamilyCandidates(
      candidates,
      traces,
      client,
    );

    expect(result.droppedGroundingTraces).toHaveLength(0);
    // The representative should have inherited family_1's trace, remapped.
    expect(result.consolidatedTraces).toHaveLength(1);
    expect(result.consolidatedTraces[0]?.familyId).toBe("family_0");
  });
});
