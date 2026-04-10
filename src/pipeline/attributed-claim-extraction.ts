/**
 * Attributed-claim extraction (Phase 3 of discover redesign).
 *
 * Given harvested in-text mentions of a seed paper, ask an LLM to determine
 * whether each mention contains an in-scope empirical attribution and, if so,
 * extract the attributed claim text.
 *
 * One LLM call per citing paper (batching all mentions from that paper).
 */

import { z } from "zod";

import type {
  AttributedClaimExtractionRecord,
  HarvestedSeedMention,
  ResolvedPaper,
} from "../domain/types.js";
import type { LLMCallRecord, LLMClient } from "../integrations/llm-client.js";
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const ATTRIBUTED_CLAIM_PROMPT_TEMPLATE_VERSION = "2026-04-08-v1";

const DEFAULT_MODEL = "claude-haiku-4-5";

function buildExtractionPrompt(params: {
  seedPaper: ResolvedPaper;
  citingPaperTitle: string;
  mentions: HarvestedSeedMention[];
}): string {
  const mentionBlock = params.mentions
    .map(
      (m, i) =>
        `### Mention ${String(i + 1)} (id: ${m.mentionId})\nSection: ${m.sectionTitle ?? "unknown"}\nContext:\n> ${m.rawContext}`,
    )
    .join("\n\n");

  return `You are a scientific attribution extraction agent for a metascience project that audits citation fidelity.

## Task

A citing paper references a seed paper in one or more places. For each mention below, determine whether the citing paper is **attributing an empirical claim** to the seed paper, and if so, extract exactly what it claims the seed paper showed.

## Seed paper

Title: ${params.seedPaper.title}
DOI: ${params.seedPaper.doi ?? "unknown"}

## Citing paper

Title: ${params.citingPaperTitle}

## Mentions

${mentionBlock}

## What counts as an in-scope empirical attribution

An in-scope mention is one where the citing paper **asserts that the seed paper found, demonstrated, or showed something empirical**. Examples:

- "Smith et al. (2020) showed that vLGN neurons respond to contrast changes" → in scope
- "Using the method from Smith et al. (2020), we..." → NOT in scope (methodological reference only)
- "...consistent with prior work [12]" → NOT in scope (vague agreement, no specific claim attributed)
- "Smith et al. (2020) reported that X; however, we found Y" → in scope (specific attribution even if contested)

## Response format

Respond with a JSON object (no markdown fences):
{
  "extractions": [
    {
      "mentionId": "the mention id from above",
      "inScopeEmpiricalAttribution": true,
      "attributedClaimText": "Self-contained statement of what the citing paper claims the seed paper showed. Write this as: 'The seed paper [showed/found/demonstrated] that ...'",
      "supportSpanText": "Verbatim span from the mention context that supports your extraction",
      "confidence": "high",
      "reasonIfExcluded": null
    }
  ]
}

For mentions that are NOT in-scope empirical attributions, set:
- "inScopeEmpiricalAttribution": false
- "attributedClaimText": null
- "supportSpanText": null
- "confidence": null
- "reasonIfExcluded": "brief reason (e.g. 'methodological reference only', 'vague agreement')"

Return one entry per mention. Do not merge or skip mentions.`;
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

const extractionItemSchema = z
  .object({
    mentionId: z.string(),
    inScopeEmpiricalAttribution: z.boolean(),
    attributedClaimText: z.string().nullable(),
    supportSpanText: z.string().nullable(),
    confidence: z.enum(["high", "medium", "low"]).nullable(),
    reasonIfExcluded: z.string().nullable(),
  })
  .passthrough();

const extractionResponseSchema = z.object({
  extractions: z.array(extractionItemSchema),
});

type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

function parseLlmResponse(
  rawText: string,
): { ok: true; data: ExtractionResponse } | { ok: false; error: string } {
  try {
    const jsonSlice = extractJsonFromModelText(rawText);
    const parsed: unknown = JSON.parse(jsonSlice);
    const result = extractionResponseSchema.safeParse(parsed);
    if (result.success) {
      return { ok: true, data: result.data };
    }
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "JSON parse failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AttributedClaimExtractionOptions = {
  model?: string | undefined;
  useThinking?: boolean | undefined;
};

/**
 * Extract attributed claims from a batch of harvested mentions belonging to
 * one citing paper. Returns one `AttributedClaimExtractionRecord` per mention.
 *
 * On LLM failure the returned records have `inScopeEmpiricalAttribution: false`
 * with the failure reason captured in `reasonIfExcluded`.
 */
export async function extractAttributedClaims(params: {
  seedPaper: ResolvedPaper;
  citingPaperTitle: string;
  mentions: HarvestedSeedMention[];
  client: LLMClient;
  options?: AttributedClaimExtractionOptions;
}): Promise<AttributedClaimExtractionRecord[]> {
  const { seedPaper, citingPaperTitle, mentions, client, options } = params;
  if (mentions.length === 0) return [];

  const modelId = options?.model ?? DEFAULT_MODEL;
  const useThinking = options?.useThinking ?? false;
  const prompt = buildExtractionPrompt({
    seedPaper,
    citingPaperTitle,
    mentions,
  });

  let rawText: string;
  let record: LLMCallRecord;
  try {
    const result = await client.generateText({
      purpose: "attributed-claim-extraction",
      model: modelId,
      prompt,
      ...(useThinking
        ? { thinking: { type: "enabled" as const, budgetTokens: 8000 } }
        : {}),
    });
    rawText = result.text;
    record = result.record;
  } catch (err) {
    // LLM call failed — produce fallback records for every mention.
    const msg = err instanceof Error ? err.message : String(err);
    return mentions.map((m) => makeFallbackRecord(m, modelId, msg));
  }

  const parsed = parseLlmResponse(rawText);
  if (!parsed.ok) {
    return mentions.map((m) =>
      makeFallbackRecord(
        m,
        record.model,
        `LLM returned invalid JSON: ${parsed.error}`,
      ),
    );
  }

  // Index LLM results by mentionId for lookup.
  const resultsByMentionId = new Map(
    parsed.data.extractions.map((e) => [e.mentionId, e]),
  );

  const provenance = {
    model: record.model,
    promptTemplateId: ATTRIBUTED_CLAIM_PROMPT_TEMPLATE_VERSION,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    estimatedCostUsd: record.estimatedCostUsd,
    generatedAt: record.timestamp,
    ...(record.cacheReadTokens != null
      ? { cacheReadTokens: record.cacheReadTokens }
      : {}),
    ...(record.cacheWriteTokens != null
      ? { cacheWriteTokens: record.cacheWriteTokens }
      : {}),
  };

  return mentions.map((m): AttributedClaimExtractionRecord => {
    const item = resultsByMentionId.get(m.mentionId);
    if (!item) {
      return {
        recordId: `rec-${m.mentionId}`,
        mentionId: m.mentionId,
        citingPaperId: m.citingPaperId,
        inScopeEmpiricalAttribution: false,
        attributedClaimText: undefined,
        supportSpanText: undefined,
        confidence: undefined,
        reasonIfExcluded: "LLM did not return a result for this mention",
        llmCallProvenance: provenance,
      };
    }

    return {
      recordId: `rec-${m.mentionId}`,
      mentionId: m.mentionId,
      citingPaperId: m.citingPaperId,
      inScopeEmpiricalAttribution: item.inScopeEmpiricalAttribution,
      attributedClaimText: item.attributedClaimText ?? undefined,
      supportSpanText: item.supportSpanText ?? undefined,
      confidence: item.confidence ?? undefined,
      reasonIfExcluded: item.reasonIfExcluded ?? undefined,
      llmCallProvenance: provenance,
    };
  });
}

function makeFallbackRecord(
  mention: HarvestedSeedMention,
  model: string,
  reason: string,
): AttributedClaimExtractionRecord {
  return {
    recordId: `rec-${mention.mentionId}`,
    mentionId: mention.mentionId,
    citingPaperId: mention.citingPaperId,
    inScopeEmpiricalAttribution: false,
    attributedClaimText: undefined,
    supportSpanText: undefined,
    confidence: undefined,
    reasonIfExcluded: reason,
    llmCallProvenance: {
      model,
      promptTemplateId: ATTRIBUTED_CLAIM_PROMPT_TEMPLATE_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      generatedAt: new Date().toISOString(),
    },
  };
}
