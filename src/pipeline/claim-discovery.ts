/**
 * Claim discovery: given a parsed paper, extract the empirical claim units
 * that the paper advances as its own contribution.
 *
 * Single LLM call with Opus over the claim-bearing sections (Abstract,
 * Results, Discussion, Conclusion). Each extracted claim is a self-contained
 * assertion suitable as a seed for downstream screening.
 */

import type {
  ClaimDiscoveryLlmResponse,
  ClaimDiscoveryResult,
  DiscoveredClaim,
  ParsedPaperBlock,
  ParsedPaperDocument,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import { claimDiscoveryLlmResponseSchema } from "../domain/discovery.js";
import type { LLMCallRecord, LLMClient } from "../integrations/llm-client.js";
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";

// ---------------------------------------------------------------------------
// Section filtering — keep only the parts of the paper that carry claims.
// ---------------------------------------------------------------------------

const CLAIM_BEARING_SECTION_PATTERNS = [
  /^abstract$/i,
  /result/i,
  /finding/i,
  /discussion/i,
  /conclusion/i,
  /summary/i,
];

const EXCLUDED_SECTION_PATTERNS = [
  /method/i,
  /material/i,
  /supplement/i,
  /acknowledg/i,
  /appendix/i,
  /reference/i,
  /data\s*availability/i,
  /author\s*contrib/i,
  /funding/i,
  /competing\s*interest/i,
  /conflict/i,
];

function isClaimBearingBlock(block: ParsedPaperBlock): boolean {
  if (block.blockKind === "abstract") return true;
  if (
    block.blockKind === "figure_caption" ||
    block.blockKind === "table_caption"
  )
    return false;

  const section = block.sectionTitle ?? "";

  for (const pattern of EXCLUDED_SECTION_PATTERNS) {
    if (pattern.test(section)) return false;
  }

  // No section title — include by default (unstructured documents).
  if (section.length === 0) return true;

  for (const pattern of CLAIM_BEARING_SECTION_PATTERNS) {
    if (pattern.test(section)) return true;
  }

  // Unknown section title — include to avoid missing claims in papers
  // with non-standard headings.
  return true;
}

function buildManuscriptForDiscovery(doc: ParsedPaperDocument): string {
  return doc.blocks
    .filter(isClaimBearingBlock)
    .map((b) => {
      const prefix = b.sectionTitle ? `[${b.sectionTitle}]\n` : "";
      return `${prefix}${b.text.trim()}`;
    })
    .filter((t) => t.length > 0)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

import { LLM_PROMPT_VERSIONS } from "../config/llm-versions.js";

export const DISCOVERY_PROMPT_TEMPLATE_VERSION = LLM_PROMPT_VERSIONS.discovery;

function buildDiscoveryPrompt(params: {
  paper: ResolvedPaper;
  manuscript: string;
}): string {
  return `You are a scientific claim extraction agent for a metascience project that audits citation fidelity.

Your task: read the manuscript below and extract every distinct **empirical claim** that this paper advances as **its own contribution**.

## Paper

Title: ${params.paper.title}
DOI: ${params.paper.doi ?? "unknown"}

## Manuscript text (claim-bearing sections only)

${params.manuscript}

## What counts as a claim

A claim is a **discrete, empirically testable assertion about observations, measurements, or experimental results** that this paper presents as its own work. Each claim should be:

- **The paper's own finding**, not a finding it attributes to another study. If a sentence says "Smith et al. found X", that is NOT a claim of this paper — skip it.
- **Specific enough to be checkable** against data. "We investigated X" is not a claim. "X increased Y by 30% under condition Z" is.
- **Self-contained** — understandable without reading the surrounding paragraph. Resolve pronouns and abbreviations where possible.
- **Atomic** — one assertion per claim. "A increased B and C decreased D" should be two claims, not one. But "A increased B in a dose-dependent manner" is one claim.

## Claim types

Classify each claim:
- **finding**: an empirical observation or result (this is the primary target)
- **interpretation**: an inference or conclusion drawn from the findings (e.g. "these results suggest that...")
- **methodological**: a claim about a technique or approach the paper developed (e.g. "our method achieves 95% accuracy on benchmark X")

## How to extract

1. Read each section. Focus on Results, Discussion, and Conclusion.
2. For each distinct empirical assertion, write a normalized claim and copy the verbatim source sentence(s).
3. Note any references cited alongside the claim (these become downstream edges for fidelity auditing).
4. Assign confidence: **high** if the claim is clearly stated and unambiguous, **medium** if it requires some inference from context.

## Response format

Respond with a single JSON object (no markdown fences):
{
  "claims": [
    {
      "claimText": "Normalized, self-contained assertion",
      "sourceSpans": ["Verbatim sentence from the manuscript"],
      "section": "Results",
      "citedReferences": ["[12]", "Smith et al., 2020"],
      "claimType": "finding",
      "confidence": "high"
    }
  ]
}

If you find no extractable claims, return {"claims": []}.

Extract every claim you can find. Be thorough but precise. Prefer more claims at higher granularity over fewer coarse ones.`;
}

// ---------------------------------------------------------------------------
// Parse and validate LLM response
// ---------------------------------------------------------------------------

function parseLlmResponse(rawText: string): Result<ClaimDiscoveryLlmResponse> {
  try {
    const jsonSlice = extractJsonFromModelText(rawText);
    const parsed: unknown = JSON.parse(jsonSlice);
    const result = claimDiscoveryLlmResponseSchema.safeParse(parsed);
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
// Verify source spans exist in the manuscript
// ---------------------------------------------------------------------------

function verifySourceSpans(
  claims: DiscoveredClaim[],
  manuscript: string,
): DiscoveredClaim[] {
  return claims.map((claim) => ({
    ...claim,
    sourceSpans: claim.sourceSpans.filter((span) => manuscript.includes(span)),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ClaimDiscoveryOptions = {
  model?: string | undefined;
  useThinking?: boolean | undefined;
};

const DEFAULT_MODEL = "claude-haiku-4-5";

export async function discoverClaims(params: {
  paper: ResolvedPaper;
  parsedDocument: ParsedPaperDocument;
  client: LLMClient;
  options?: ClaimDiscoveryOptions;
}): Promise<ClaimDiscoveryResult> {
  const { paper, parsedDocument, client, options } = params;
  const modelId = options?.model ?? DEFAULT_MODEL;
  const useThinking = options?.useThinking ?? false;
  const manuscript = buildManuscriptForDiscovery(parsedDocument);

  if (manuscript.length === 0) {
    return {
      doi: paper.doi ?? "unknown",
      resolvedPaper: paper,
      status: "no_fulltext",
      statusDetail: "No claim-bearing text blocks found in parsed document.",
      claims: [],
      findingCount: 0,
      totalClaimCount: 0,
      llmModel: undefined,
      llmInputTokens: undefined,
      llmOutputTokens: undefined,
      llmEstimatedCostUsd: undefined,
      generatedAt: new Date().toISOString(),
    };
  }

  const prompt = buildDiscoveryPrompt({ paper, manuscript });

  let rawText: string;
  let record: LLMCallRecord;
  try {
    const result = await client.generateText({
      purpose: "claim-discovery",
      model: modelId,
      prompt,
      ...(useThinking
        ? { thinking: { type: "enabled" as const, budgetTokens: 8000 } }
        : {}),
    });
    rawText = result.text;
    record = result.record;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      doi: paper.doi ?? "unknown",
      resolvedPaper: paper,
      status: "llm_failed",
      statusDetail: `LLM call failed: ${msg}`,
      claims: [],
      findingCount: 0,
      totalClaimCount: 0,
      llmModel: modelId,
      llmInputTokens: undefined,
      llmOutputTokens: undefined,
      llmEstimatedCostUsd: undefined,
      generatedAt: new Date().toISOString(),
    };
  }

  const parsed = parseLlmResponse(rawText);
  if (!parsed.ok) {
    return {
      doi: paper.doi ?? "unknown",
      resolvedPaper: paper,
      status: "llm_failed",
      statusDetail: `LLM returned invalid JSON: ${parsed.error}`,
      claims: [],
      findingCount: 0,
      totalClaimCount: 0,
      llmModel: record.model,
      llmInputTokens: record.inputTokens,
      llmOutputTokens: record.outputTokens,
      llmEstimatedCostUsd: record.estimatedCostUsd,
      generatedAt: new Date().toISOString(),
    };
  }

  const verified = verifySourceSpans(parsed.data.claims, manuscript);
  // Drop claims whose every source span failed verification.
  const retained = verified.filter((c) => c.sourceSpans.length > 0);
  const findings = retained.filter((c) => c.claimType === "finding");

  return {
    doi: paper.doi ?? "unknown",
    resolvedPaper: paper,
    status: "completed",
    statusDetail: `Extracted ${String(retained.length)} claims (${String(findings.length)} findings) from ${paper.title}.`,
    claims: retained,
    findingCount: findings.length,
    totalClaimCount: retained.length,
    llmModel: record.model,
    llmInputTokens: record.inputTokens,
    llmOutputTokens: record.outputTokens,
    llmEstimatedCostUsd: record.estimatedCostUsd,
    generatedAt: new Date().toISOString(),
  };
}
