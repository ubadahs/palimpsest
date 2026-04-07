/**
 * Claim ranking: for each citing paper, ask an LLM which discovered claims
 * it specifically engages with. One call per citing paper (all claims batched).
 *
 * The result is an engagement profile per claim — how many citing papers
 * directly or indirectly discuss that specific finding.
 */

import { z } from "zod";

import type {
  ClaimEngagement,
  ClaimRankingResult,
  DiscoveredClaim,
  ResolvedPaper,
} from "../domain/types.js";
import type { LLMClient } from "../integrations/llm-client.js";
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";

// ---------------------------------------------------------------------------
// LLM response schema
// ---------------------------------------------------------------------------

const matchEntrySchema = z.object({
  claimIndex: z.number().int().positive(),
  engagement: z.enum(["direct", "indirect"]),
});

const matchResponseSchema = z.object({
  matches: z.array(matchEntrySchema),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildMatchPrompt(
  seedTitle: string,
  claims: DiscoveredClaim[],
  citingPaper: ResolvedPaper,
): string {
  const claimList = claims
    .map((c, i) => `  ${String(i + 1)}. [${c.claimType}] ${c.claimText}`)
    .join("\n");

  return `You are a citation analyst. A seed paper made the following empirical claims. A citing paper references the seed paper. Your job: determine which specific claims from the seed paper this citing paper actually engages with, based on its title and abstract.

## Seed paper
Title: ${seedTitle}

## Claims from the seed paper
${claimList}

## Citing paper
Title: ${citingPaper.title}
Abstract: ${citingPaper.abstract ?? "(no abstract available)"}

## Instructions

For each claim, judge the citing paper's engagement:
- **direct**: The citing paper's abstract specifically discusses, tests, extends, or challenges this particular claim. The abstract language clearly maps to this finding.
- **indirect**: The citing paper works in the same area and its abstract touches on the general topic of this claim, but does not specifically engage with this particular finding.
- **none**: No meaningful connection between this claim and the citing paper's abstract.

Be strict. Most claims will be "none" or "indirect" for any given citing paper. "direct" means the abstract language specifically addresses that finding — not just that they share domain vocabulary.

Only include claims with "direct" or "indirect" engagement in your response. Omit "none" entries.

Respond with a single JSON object (no markdown fences):
{
  "matches": [
    {"claimIndex": 1, "engagement": "direct"},
    {"claimIndex": 5, "engagement": "indirect"}
  ]
}

If no claims are engaged, return {"matches": []}.`;
}

// ---------------------------------------------------------------------------
// Single citing paper
// ---------------------------------------------------------------------------

type PaperMatchResult = {
  citingTitle: string;
  directClaims: number[];
  indirectClaims: number[];
  error?: string | undefined;
};

async function matchOnePaper(
  seedTitle: string,
  claims: DiscoveredClaim[],
  citingPaper: ResolvedPaper,
  client: LLMClient,
  model: string,
): Promise<PaperMatchResult> {
  const prompt = buildMatchPrompt(seedTitle, claims, citingPaper);

  try {
    const result = await client.generateText({
      purpose: "claim-family-filter",
      model,
      prompt,
      thinking: {
        type: "enabled",
        budgetTokens: DEFAULT_THINKING_BUDGET,
      },
    });

    const jsonSlice = extractJsonFromModelText(result.text);
    const parsed = matchResponseSchema.safeParse(
      JSON.parse(jsonSlice) as unknown,
    );

    if (!parsed.success) {
      return {
        citingTitle: citingPaper.title,
        directClaims: [],
        indirectClaims: [],
        error: `Parse: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      };
    }

    const direct: number[] = [];
    const indirect: number[] = [];
    for (const m of parsed.data.matches) {
      if (m.claimIndex < 1 || m.claimIndex > claims.length) continue;
      if (m.engagement === "direct") direct.push(m.claimIndex);
      else indirect.push(m.claimIndex);
    }

    return {
      citingTitle: citingPaper.title,
      directClaims: direct,
      indirectClaims: indirect,
    };
  } catch (err) {
    return {
      citingTitle: citingPaper.title,
      directClaims: [],
      indirectClaims: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

function aggregate(
  claims: DiscoveredClaim[],
  paperResults: PaperMatchResult[],
): ClaimEngagement[] {
  return claims.map((claim, i) => {
    const claimIdx = i + 1;
    const directPapers: string[] = [];
    let indirectCount = 0;

    for (const pr of paperResults) {
      if (pr.directClaims.includes(claimIdx)) directPapers.push(pr.citingTitle);
      if (pr.indirectClaims.includes(claimIdx)) indirectCount++;
    }

    return {
      claimIndex: i,
      claimText: claim.claimText,
      claimType: claim.claimType,
      directCount: directPapers.length,
      indirectCount,
      directPapers,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_THINKING_BUDGET = 4096;
const CONCURRENCY = 8;

export type ClaimRankingOptions = {
  model?: string | undefined;
};

export async function rankClaimsByEngagement(params: {
  seedTitle: string;
  claims: DiscoveredClaim[];
  citingPapers: ResolvedPaper[];
  client: LLMClient;
  options?: ClaimRankingOptions | undefined;
  onProgress?: (processed: number, total: number) => void;
}): Promise<ClaimRankingResult> {
  const { seedTitle, claims, citingPapers, client, options, onProgress } =
    params;
  const model = options?.model ?? DEFAULT_MODEL;

  const usable = citingPapers.filter(
    (p) => p.abstract != null && p.abstract.length > 50,
  );

  const paperResults: PaperMatchResult[] = [];
  for (let i = 0; i < usable.length; i += CONCURRENCY) {
    const batch = usable.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((paper) =>
        matchOnePaper(seedTitle, claims, paper, client, model),
      ),
    );
    paperResults.push(...batchResults);
    onProgress?.(Math.min(i + CONCURRENCY, usable.length), usable.length);
  }

  const engagements = aggregate(claims, paperResults);
  engagements.sort(
    (a, b) =>
      b.directCount - a.directCount || b.indirectCount - a.indirectCount,
  );

  const ledger = client.getLedger();
  const filterCost = ledger.byPurpose["claim-family-filter"];

  return {
    citingPapersAnalyzed: usable.length,
    citingPapersTotal: citingPapers.length,
    rankingModel: model,
    rankingEstimatedCostUsd: filterCost?.estimatedCostUsd ?? 0,
    engagements,
  };
}
