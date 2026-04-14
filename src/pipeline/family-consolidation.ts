/**
 * Family consolidation — merges semantically equivalent tracked claims
 * before the shortlist cap applies.
 *
 * After attribution-first discovery produces family candidates, many may
 * describe the same finding in different words. This step uses a single
 * Opus + extended thinking call to cluster them, picking the most specific
 * representative from each cluster. Running before the shortlist cap means
 * near-duplicates don't consume shortlist slots that could go to genuinely
 * distinct claims.
 *
 * The prompt is domain-agnostic: no biology, physics, or field-specific
 * examples that could bias judgments.
 */

import { z } from "zod";

import type { LLMClient } from "../integrations/llm-client.js";
import type { AttributedClaimFamilyCandidate } from "../domain/discovery.js";
import type { FamilyGroundingTrace } from "./discovery-family-probe.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const consolidationClusterSchema = z.object({
  cluster: z.number().describe("1-indexed cluster number"),
  memberIndices: z
    .array(z.number())
    .describe("0-based indices of families in this cluster"),
  representativeIndex: z
    .number()
    .describe(
      "0-based index of the most specific family chosen as representative",
    ),
  reasoning: z
    .string()
    .describe("Brief explanation of why these families were grouped"),
});

const consolidationResultSchema = z.object({
  clusters: z
    .array(consolidationClusterSchema)
    .describe("One cluster per semantically distinct group of families"),
});

export type ConsolidationCluster = z.infer<typeof consolidationClusterSchema>;

export type DroppedGroundingTrace = {
  familyId: string;
  trackedClaim: string;
  reason: string;
};

export type FamilyCandidateConsolidationResult = {
  /** Consolidated candidates — one per cluster, using the representative. */
  consolidatedCandidates: AttributedClaimFamilyCandidate[];
  /** Grounding traces for the consolidated set (representative traces only). */
  consolidatedTraces: FamilyGroundingTrace[];
  /** Full provenance of every merge decision. */
  clusters: ConsolidationCluster[];
  /** Original candidates before consolidation (for audit trail). */
  originalCandidates: AttributedClaimFamilyCandidate[];
  /** Number of families eliminated. */
  eliminatedCount: number;
  /** Grounding traces that were dropped because the representative already had one. */
  droppedGroundingTraces: DroppedGroundingTrace[];
};

// ---------------------------------------------------------------------------
// Prompt — deliberately domain-agnostic
// ---------------------------------------------------------------------------

function buildConsolidationPrompt(claims: string[]): string {
  const claimList = claims.map((c, i) => `[${String(i)}] ${c}`).join("\n");

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
- When in doubt, keep claims separate — false merges lose information, while false splits only cost efficiency.

Respond with ONLY a JSON object (no markdown fences) matching this schema:
{
  "clusters": [
    {
      "cluster": <1-indexed cluster number>,
      "memberIndices": [<0-based indices of families in this cluster>],
      "representativeIndex": <0-based index of the most specific family>,
      "reasoning": "<brief explanation>"
    }
  ]
}`;
}

// ---------------------------------------------------------------------------
// Core LLM clustering (shared by all consumers)
// ---------------------------------------------------------------------------

async function clusterClaims(
  claims: string[],
  llmClient: LLMClient,
  model?: string,
): Promise<ConsolidationCluster[]> {
  if (claims.length <= 1) {
    return claims.length === 1
      ? [
          {
            cluster: 1,
            memberIndices: [0],
            representativeIndex: 0,
            reasoning: "Single family — no consolidation needed.",
          },
        ]
      : [];
  }

  const result = await llmClient.generateText({
    purpose: "family-consolidation",
    model: model ?? "claude-opus-4-6",
    prompt: buildConsolidationPrompt(claims),
    thinking: { type: "enabled", budgetTokens: 10_000 },
    context: { stageKey: "discover" },
    exactCache: { keyVersion: "family-consolidation-v2" },
  });

  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Family consolidation: no JSON found in LLM response:\n${result.text.slice(0, 500)}`,
    );
  }
  return consolidationResultSchema.parse(JSON.parse(jsonMatch[0])).clusters;
}

// ---------------------------------------------------------------------------
// Discovery-level: consolidate family candidates before shortlist cap
// ---------------------------------------------------------------------------

/**
 * Consolidate semantically equivalent family candidates. Called inside the
 * discovery stage before ranking and shortlist cap, so near-duplicates don't
 * consume slots that could go to distinct claims.
 *
 * Returns consolidated candidates, updated grounding traces, and full
 * merge provenance.
 */
export async function consolidateFamilyCandidates(
  candidates: AttributedClaimFamilyCandidate[],
  groundingTraces: FamilyGroundingTrace[],
  llmClient: LLMClient,
  model?: string,
): Promise<FamilyCandidateConsolidationResult> {
  if (candidates.length <= 1) {
    return {
      consolidatedCandidates: [...candidates],
      consolidatedTraces: [...groundingTraces],
      clusters:
        candidates.length === 1
          ? [
              {
                cluster: 1,
                memberIndices: [0],
                representativeIndex: 0,
                reasoning: "Single family — no consolidation needed.",
              },
            ]
          : [],
      originalCandidates: [...candidates],
      eliminatedCount: 0,
      droppedGroundingTraces: [],
    };
  }

  const claims = candidates.map((c) => c.canonicalTrackedClaim);
  const clusters = await clusterClaims(claims, llmClient, model);

  // Index grounding traces by familyId for fast lookup.
  const traceByFamilyId = new Map(groundingTraces.map((t) => [t.familyId, t]));

  const consolidatedCandidates: AttributedClaimFamilyCandidate[] = [];
  const consolidatedTraces: FamilyGroundingTrace[] = [];
  const droppedGroundingTraces: DroppedGroundingTrace[] = [];

  for (const cluster of clusters) {
    const repIdx = cluster.representativeIndex;
    const representative = candidates[repIdx];
    if (!representative) continue;

    // Merge member metadata into the representative.
    if (cluster.memberIndices.length > 1) {
      const mergedRecordIds = new Set(representative.memberRecordIds);
      const mergedMentionIds = new Set(representative.memberMentionIds);
      const mergedCitingPaperIds = new Set(representative.memberCitingPaperIds);

      for (const idx of cluster.memberIndices) {
        if (idx === repIdx) continue;
        const member = candidates[idx];
        if (!member) continue;
        for (const id of member.memberRecordIds) mergedRecordIds.add(id);
        for (const id of member.memberMentionIds) mergedMentionIds.add(id);
        for (const id of member.memberCitingPaperIds)
          mergedCitingPaperIds.add(id);
      }

      consolidatedCandidates.push({
        ...representative,
        memberRecordIds: [...mergedRecordIds],
        memberMentionIds: [...mergedMentionIds],
        memberCitingPaperIds: [...mergedCitingPaperIds],
        shortlistReason: `Consolidated from ${String(cluster.memberIndices.length)} families: ${cluster.reasoning}`,
      });
    } else {
      consolidatedCandidates.push(representative);
    }

    // Grounding trace: keep representative's trace, record drops.
    const repTrace = traceByFamilyId.get(representative.familyId);
    if (repTrace) {
      consolidatedTraces.push(repTrace);
    }

    for (const idx of cluster.memberIndices) {
      if (idx === repIdx) continue;
      const member = candidates[idx];
      if (!member) continue;
      const memberTrace = traceByFamilyId.get(member.familyId);
      if (!memberTrace) continue;

      if (repTrace) {
        droppedGroundingTraces.push({
          familyId: member.familyId,
          trackedClaim: member.canonicalTrackedClaim,
          reason: `Merged into ${representative.familyId}; representative already has its own grounding trace`,
        });
      } else {
        // Representative lacked a trace — inherit from the first merged member.
        consolidatedTraces.push({
          ...memberTrace,
          familyId: representative.familyId,
        });
      }
    }
  }

  return {
    consolidatedCandidates,
    consolidatedTraces,
    clusters,
    originalCandidates: [...candidates],
    eliminatedCount: candidates.length - consolidatedCandidates.length,
    droppedGroundingTraces,
  };
}
