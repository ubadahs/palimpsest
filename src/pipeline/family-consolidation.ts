/**
 * Family consolidation — merges semantically equivalent tracked claims
 * before the expensive pipeline stages run.
 *
 * After attribution-first discovery produces shortlisted families, many may
 * describe the same finding in different words. This step uses a single LLM
 * call (Sonnet) to cluster them, picking the most specific representative
 * from each cluster. The prompt is domain-agnostic: no biology, physics, or
 * field-specific examples that could bias judgments.
 */

import { z } from "zod";

import type { LLMClient } from "../integrations/llm-client.js";
import type { DiscoverySeedEntry } from "./discovery-stage.js";
import type { DiscoveryHandoffMap } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const consolidationClusterSchema = z.object({
  cluster: z.number().describe("1-indexed cluster number"),
  memberIndices: z.array(z.number()).describe("0-based indices of families in this cluster"),
  representativeIndex: z.number().describe("0-based index of the most specific family chosen as representative"),
  reasoning: z.string().describe("Brief explanation of why these families were grouped"),
});

const consolidationResultSchema = z.object({
  clusters: z.array(consolidationClusterSchema).describe("One cluster per semantically distinct group of families"),
});

export type ConsolidationCluster = z.infer<typeof consolidationClusterSchema>;

export type DroppedGroundingTrace = {
  familyId: string;
  trackedClaim: string;
  reason: string;
};

export type FamilyConsolidationResult = {
  /** Consolidated seeds — one per cluster, using the representative. */
  consolidatedSeeds: DiscoverySeedEntry[];
  /** Full provenance of every merge decision. */
  clusters: ConsolidationCluster[];
  /** Original seeds before consolidation (for audit trail). */
  originalSeeds: DiscoverySeedEntry[];
  /** Number of families eliminated. */
  eliminatedCount: number;
  /** Grounding traces that were dropped because the representative already had one. */
  droppedGroundingTraces: DroppedGroundingTrace[];
};

// ---------------------------------------------------------------------------
// Prompt — deliberately domain-agnostic
// ---------------------------------------------------------------------------

function buildConsolidationPrompt(
  seeds: DiscoverySeedEntry[],
): string {
  const claimList = seeds
    .map((s, i) => `[${String(i)}] ${s.trackedClaim}`)
    .join("\n");

  return `You are reviewing tracked claims about a single research paper. Each claim below was independently extracted from how different citing papers describe the same source paper. Many of these claims describe the same finding using different words.

Your task:
1. Group claims that describe the SAME finding or result into clusters. Two claims belong in the same cluster if a domain expert would say "these are about the same thing" — even if one is more specific or more general than the other.
2. Keep claims in SEPARATE clusters if they describe genuinely different findings, methods, or contributions from the paper — even if the topic area overlaps.
3. For each cluster, select the most specific and accurate claim as the representative. Prefer claims that include concrete details (specific entities, model systems, measurements) over vague generalizations.

Claims:
${claimList}

Important:
- Do NOT merge claims about different aspects of the paper just because they share terminology.
- DO merge claims that describe the same result at different levels of detail.
- When in doubt, keep claims separate — false merges lose information, while false splits only cost efficiency.`;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Consolidate semantically equivalent families into distinct clusters.
 * Returns consolidated seeds plus full provenance of every merge decision.
 *
 * When there are 0 or 1 seeds, returns immediately with no LLM call.
 */
export async function consolidateFamilies(
  seeds: DiscoverySeedEntry[],
  llmClient: LLMClient,
  options?: {
    model?: string | undefined;
    /** Pass through to update the handoff's grounding map after merging. */
    handoffs?: DiscoveryHandoffMap | undefined;
  },
): Promise<FamilyConsolidationResult> {
  if (seeds.length <= 1) {
    return {
      consolidatedSeeds: [...seeds],
      clusters: seeds.length === 1
        ? [{ cluster: 1, memberIndices: [0], representativeIndex: 0, reasoning: "Single family — no consolidation needed." }]
        : [],
      originalSeeds: [...seeds],
      eliminatedCount: 0,
      droppedGroundingTraces: [],
    };
  }

  const result = await llmClient.generateObject({
    purpose: "family-consolidation",
    model: options?.model ?? "claude-sonnet-4-6",
    prompt: buildConsolidationPrompt(seeds),
    schema: consolidationResultSchema,
    context: { stageKey: "discover" },
    exactCache: { keyVersion: "family-consolidation-v1" },
  });

  const clusters = result.object.clusters;
  const consolidatedSeeds: DiscoverySeedEntry[] = [];
  const droppedGroundingTraces: DroppedGroundingTrace[] = [];

  for (const cluster of clusters) {
    const repIdx = cluster.representativeIndex;
    const representative = seeds[repIdx];
    if (!representative) continue;

    const mergedFamilyIds = cluster.memberIndices
      .map((idx: number) => seeds[idx]?.familyId)
      .filter((id: string | undefined): id is string => id != null);

    consolidatedSeeds.push({
      ...representative,
      notes: cluster.memberIndices.length > 1
        ? `Consolidated from ${String(cluster.memberIndices.length)} families: ${cluster.reasoning}`
        : representative.notes,
    });

    // Patch handoff grounding map for merged families.
    if (options?.handoffs && representative.familyId) {
      for (const [_doi, handoff] of options.handoffs) {
        const repHasTrace = handoff.groundingByFamilyId.has(
          representative.familyId,
        );
        for (const fid of mergedFamilyIds) {
          if (fid === representative.familyId) continue;
          const trace = handoff.groundingByFamilyId.get(fid);
          if (!trace) continue;

          if (repHasTrace) {
            // Representative already grounded — record the drop.
            const mergedSeed = seeds[
              cluster.memberIndices.find(
                (i: number) => seeds[i]?.familyId === fid,
              ) ?? -1
            ];
            droppedGroundingTraces.push({
              familyId: fid,
              trackedClaim: mergedSeed?.trackedClaim ?? trace.canonicalTrackedClaim,
              reason: `Merged into ${representative.familyId}; representative already has its own grounding trace`,
            });
          } else {
            handoff.groundingByFamilyId.set(representative.familyId, trace);
          }
        }
      }
    }
  }

  return {
    consolidatedSeeds,
    clusters,
    originalSeeds: [...seeds],
    eliminatedCount: seeds.length - consolidatedSeeds.length,
    droppedGroundingTraces,
  };
}
