import { describe, expect, it, vi } from "vitest";

import {
  consolidateFamilies,
  type ConsolidationCluster,
} from "../../src/pipeline/family-consolidation.js";
import type { DiscoverySeedEntry } from "../../src/pipeline/discovery-stage.js";
import type { DiscoveryHandoffMap } from "../../src/domain/types.js";
import type { LLMClient } from "../../src/integrations/llm-client.js";

function makeSeeds(claims: string[]): DiscoverySeedEntry[] {
  return claims.map((claim, i) => ({
    doi: "10.1234/test",
    trackedClaim: claim,
    familyId: `family_${String(i)}`,
  }));
}

function makeMockClient(
  clusters: ConsolidationCluster[],
): LLMClient {
  return {
    generateText: vi.fn(),
    generateObject: vi.fn().mockResolvedValue({
      object: { clusters },
      record: {
        purpose: "family-consolidation",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        estimatedCostUsd: 0.001,
        latencyMs: 500,
        success: true,
        exactCacheHit: false,
      },
    }),
    getLedger: vi.fn().mockReturnValue({
      totalAttemptedCalls: 1,
      totalSuccessfulCalls: 1,
      totalFailedCalls: 0,
      totalBillableCalls: 1,
      totalExactCacheHits: 0,
      totalEstimatedCostUsd: 0.001,
    }),
  };
}

describe("consolidateFamilies", () => {
  it("returns immediately for a single seed without LLM call", async () => {
    const seeds = makeSeeds(["Claim A"]);
    const client = makeMockClient([]);
    const result = await consolidateFamilies(seeds, client);

    expect(result.consolidatedSeeds).toHaveLength(1);
    expect(result.eliminatedCount).toBe(0);
    expect(client.generateObject).not.toHaveBeenCalled();
  });

  it("returns immediately for empty seeds", async () => {
    const client = makeMockClient([]);
    const result = await consolidateFamilies([], client);

    expect(result.consolidatedSeeds).toHaveLength(0);
    expect(result.eliminatedCount).toBe(0);
  });

  it("merges semantically equivalent families into one", async () => {
    const seeds = makeSeeds([
      "X causes Y in model Z",
      "X leads to Y in the Z system",
      "A completely different finding about W",
    ]);

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

    const result = await consolidateFamilies(seeds, client);

    expect(result.consolidatedSeeds).toHaveLength(2);
    expect(result.eliminatedCount).toBe(1);
    expect(result.consolidatedSeeds[0]?.trackedClaim).toBe(
      "X causes Y in model Z",
    );
    expect(result.consolidatedSeeds[1]?.trackedClaim).toBe(
      "A completely different finding about W",
    );
  });

  it("preserves provenance in notes for merged families", async () => {
    const seeds = makeSeeds(["Claim A", "Claim B"]);

    const client = makeMockClient([
      {
        cluster: 1,
        memberIndices: [0, 1],
        representativeIndex: 0,
        reasoning: "Same finding, different wording.",
      },
    ]);

    const result = await consolidateFamilies(seeds, client);

    expect(result.consolidatedSeeds).toHaveLength(1);
    expect(result.consolidatedSeeds[0]?.notes).toContain("Consolidated from 2 families");
    expect(result.consolidatedSeeds[0]?.notes).toContain("Same finding");
    expect(result.originalSeeds).toHaveLength(2);
  });

  it("keeps all families when all are distinct", async () => {
    const seeds = makeSeeds(["Claim A", "Claim B", "Claim C"]);

    const client = makeMockClient([
      { cluster: 1, memberIndices: [0], representativeIndex: 0, reasoning: "Unique." },
      { cluster: 2, memberIndices: [1], representativeIndex: 1, reasoning: "Unique." },
      { cluster: 3, memberIndices: [2], representativeIndex: 2, reasoning: "Unique." },
    ]);

    const result = await consolidateFamilies(seeds, client);

    expect(result.consolidatedSeeds).toHaveLength(3);
    expect(result.eliminatedCount).toBe(0);
    expect(result.droppedGroundingTraces).toHaveLength(0);
  });

  it("records dropped grounding traces when representative already has one", async () => {
    const seeds = makeSeeds(["Claim A", "Claim B"]);

    const client = makeMockClient([
      {
        cluster: 1,
        memberIndices: [0, 1],
        representativeIndex: 0,
        reasoning: "Same finding.",
      },
    ]);

    // Build a handoff where both families have grounding traces.
    const handoffs: DiscoveryHandoffMap = new Map([
      [
        "10.1234/test",
        {
          doi: "10.1234/test",
          resolvedPaper: { id: "p1", title: "T", authors: [], source: "openalex", fullTextHints: { providerAvailability: "unavailable" } } as any,
          citingPapersRaw: [],
          mentionsByPaperId: new Map(),
          groundingByFamilyId: new Map([
            ["family_0", { familyId: "family_0", canonicalTrackedClaim: "Claim A", grounding: {} as any }],
            ["family_1", { familyId: "family_1", canonicalTrackedClaim: "Claim B", grounding: {} as any }],
          ]),
        },
      ],
    ]);

    const result = await consolidateFamilies(seeds, client, { handoffs });

    expect(result.consolidatedSeeds).toHaveLength(1);
    expect(result.droppedGroundingTraces).toHaveLength(1);
    expect(result.droppedGroundingTraces[0]?.familyId).toBe("family_1");
    expect(result.droppedGroundingTraces[0]?.reason).toContain("representative already has");
  });

  it("inherits grounding trace when representative lacks one", async () => {
    const seeds = makeSeeds(["Claim A", "Claim B"]);

    const client = makeMockClient([
      {
        cluster: 1,
        memberIndices: [0, 1],
        representativeIndex: 0,
        reasoning: "Same finding.",
      },
    ]);

    const handoffs: DiscoveryHandoffMap = new Map([
      [
        "10.1234/test",
        {
          doi: "10.1234/test",
          resolvedPaper: { id: "p1", title: "T", authors: [], source: "openalex", fullTextHints: { providerAvailability: "unavailable" } } as any,
          citingPapersRaw: [],
          mentionsByPaperId: new Map(),
          groundingByFamilyId: new Map([
            // Only family_1 has a trace; family_0 (the representative) does not.
            ["family_1", { familyId: "family_1", canonicalTrackedClaim: "Claim B", grounding: {} as any }],
          ]),
        },
      ],
    ]);

    const result = await consolidateFamilies(seeds, client, { handoffs });

    expect(result.droppedGroundingTraces).toHaveLength(0);
    // The representative should have inherited family_1's trace.
    const handoff = handoffs.get("10.1234/test")!;
    expect(handoff.groundingByFamilyId.has("family_0")).toBe(true);
  });
});
