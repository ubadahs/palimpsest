import { createHash } from "node:crypto";

import type {
  ClaimGrounding,
  ClaimGroundingLlmParsedResponse,
  GroundingTraceLlmCall,
  ParsedPaperDocument,
  QuoteVerificationResult,
  ResolvedPaper,
  SeedPaperInput,
} from "../domain/types.js";
import { claimGroundingLlmParsedResponseSchema } from "../domain/pre-screen-grounding-trace.js";
import type { LLMClient } from "../integrations/llm-client.js";
import { createLLMClient } from "../integrations/llm-client.js";
import { extractJsonFromModelText } from "../shared/extract-json-from-text.js";

/** Bump when instructions or JSON shape change (stored in trace artifacts). */
export const GROUNDING_LLM_PROMPT_TEMPLATE_VERSION = "2026-04-06-v1";

const MAX_LLM_SUPPORT_SPANS = 8;

/**
 * Statuses that block downstream analysis.
 *
 * `not_found` is intentionally excluded: if citers attribute a claim to the
 * seed paper that the LLM cannot ground there, that is a fidelity finding
 * worth surfacing — not a reason to discard the family.
 *
 * Infrastructure failures (`no_seed_fulltext`, `materialize_failed`) still
 * block because evidence retrieval needs the seed paper's full text.
 */
const GROUNDING_BLOCKS_DOWNSTREAM: ReadonlySet<ClaimGrounding["status"]> =
  new Set(["not_attempted", "no_seed_fulltext", "materialize_failed"]);

export type SeedClaimLlmGroundingOptions = {
  apiKey: string;
  /** Anthropic model id (e.g. claude-opus-4-6). */
  model?: string;
  useThinking?: boolean;
  /** Optional pre-existing LLM client for shared ledger tracking. */
  llmClient?: LLMClient;
};

export function buildSeedFullTextForLlm(doc: ParsedPaperDocument): string {
  return doc.blocks
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}

export function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function verifyQuotesInManuscript(
  quotes: string[],
  manuscript: string,
): QuoteVerificationResult {
  const failures: QuoteVerificationResult["failures"] = [];
  for (const q of quotes) {
    const normalizedQuote = q.trim();
    if (normalizedQuote.length === 0) {
      continue;
    }
    if (!manuscript.includes(normalizedQuote)) {
      failures.push({
        quote:
          normalizedQuote.length > 200
            ? `${normalizedQuote.slice(0, 197)}…`
            : normalizedQuote,
        reason: "Not found as a contiguous substring of the manuscript text.",
      });
    }
  }
  return {
    overallOk: failures.length === 0,
    failures,
  };
}

export function applyCanonicalGroundingBlocksDownstream(
  grounding: ClaimGrounding,
): ClaimGrounding {
  return {
    ...grounding,
    blocksDownstream: GROUNDING_BLOCKS_DOWNSTREAM.has(grounding.status),
  };
}

export function mapLlmParsedResponseToClaimGrounding(params: {
  analystClaim: string;
  response: ClaimGroundingLlmParsedResponse;
  manuscript: string;
}): { grounding: ClaimGrounding; quoteVerification: QuoteVerificationResult } {
  const { analystClaim, response, manuscript } = params;
  const cappedSpans = response.supportSpans.slice(0, MAX_LLM_SUPPORT_SPANS);
  const quotes = cappedSpans.map((s) => s.verbatimQuote);
  const quoteVerification = verifyQuotesInManuscript(quotes, manuscript);

  let detailReason = response.detailReason;
  let status = response.status;
  if (!quoteVerification.overallOk) {
    const first = quoteVerification.failures[0]!;
    detailReason = `${detailReason} (verification: a quoted passage was not found verbatim in the manuscript — possible paraphrase or model error; first issue: ${first.reason})`;
    if (status === "grounded") {
      status = "ambiguous";
    }
  }

  const normalized = response.normalizedClaim.trim() || analystClaim;

  const grounding: ClaimGrounding = applyCanonicalGroundingBlocksDownstream({
    status,
    analystClaim,
    normalizedClaim: normalized,
    supportSpans: cappedSpans.map((s) => {
      const raw = s.verbatimQuote;
      const text = raw.length > 800 ? `${raw.slice(0, 797)}...` : raw;
      const span: ClaimGrounding["supportSpans"][number] = { text };
      if (s.sectionHint != null && s.sectionHint.trim().length > 0) {
        span.sectionTitle = s.sectionHint.trim();
      }
      return span;
    }),
    blocksDownstream: false,
    detailReason,
  });

  return { grounding, quoteVerification };
}

function buildLlmGroundingPromptPrefix(params: {
  seedPaper: ResolvedPaper;
  manuscript: string;
}): string {
  return `You are assisting a metascience project that audits citation fidelity.

The analyst has named a **tracked claim** they believe appears in the **seed paper** below. Your job is to decide whether that claim is actually supported in the manuscript, using only the supplied full text.
The specific tracked claim to judge appears after this shared manuscript context.

## Seed paper

Title: ${params.seedPaper.title}
DOI: ${params.seedPaper.doi}

## Full manuscript text (single document)

${params.manuscript}

## Instructions

1. Read the full manuscript. Do not assume anything outside this text.
2. If the tracked claim is supported (directly or with minor rephrasing), set status to "grounded" and include 1–3 **verbatim** quotes copied exactly from the manuscript above (must be exact substrings).
3. If several distinct passages support the claim with similar strength and picking one would be arbitrary, use status "ambiguous" and include up to 3 verbatim quotes.
4. If the claim is not supported by the manuscript, use status "not_found" and leave supportSpans empty (or include only contradictory evidence quotes if helpful).
5. normalizedClaim: a short neutral paraphrase of what the manuscript actually supports relative to the analyst claim (or the analyst claim if you cannot improve it).
6. detailReason: 2–4 sentences explaining your decision.

## Response format

Respond with a single JSON object (no markdown fences) with exactly these fields:
{
  "status": "grounded" | "ambiguous" | "not_found",
  "normalizedClaim": "string",
  "supportSpans": [ { "verbatimQuote": "string", "sectionHint": "optional string" } ],
  "detailReason": "string"
}

Quotes must be copy-paste exact substrings of the manuscript text.`;
}

function buildLlmGroundingPromptSuffix(analystClaim: string): string {
  return `

## Analyst tracked claim (hypothesis)

"${analystClaim}"

Evaluate only this tracked claim against the manuscript above and return the JSON object.`;
}

/**
 * Full-manuscript LLM claim grounding (canonical pre-screen path).
 * Persists raw model text via the returned `llmCall` for sidecar artifacts.
 */
export async function runLlmFullDocumentClaimGrounding(params: {
  seed: SeedPaperInput;
  seedPaper: ResolvedPaper;
  parsedDocument: ParsedPaperDocument;
  options: SeedClaimLlmGroundingOptions;
}): Promise<{
  grounding: ClaimGrounding;
  llmCall: GroundingTraceLlmCall | undefined;
}> {
  const { seed, seedPaper, parsedDocument, options } = params;
  const analystClaim = seed.trackedClaim.trim();
  const manuscript = buildSeedFullTextForLlm(parsedDocument);
  const modelId = options.model ?? "claude-sonnet-4-6";
  const useThinking = options.useThinking ?? true;

  if (manuscript.length === 0) {
    return {
      grounding: applyCanonicalGroundingBlocksDownstream({
        status: "no_seed_fulltext",
        analystClaim,
        normalizedClaim: analystClaim,
        supportSpans: [],
        blocksDownstream: false,
        detailReason:
          "No manuscript text to send to the LLM (empty parsed document).",
      }),
      llmCall: undefined,
    };
  }

  const promptPrefix = buildLlmGroundingPromptPrefix({
    seedPaper,
    manuscript,
  });
  const promptSuffix = buildLlmGroundingPromptSuffix(analystClaim);
  const promptText = `${promptPrefix}${promptSuffix}`;
  const manuscriptSha256 = sha256Utf8(manuscript);

  const baseLlmFields = {
    modelId,
    promptTemplateVersion: GROUNDING_LLM_PROMPT_TEMPLATE_VERSION,
    promptText,
    manuscriptCharCount: manuscript.length,
    manuscriptSha256,
  } as const;

  const client =
    options.llmClient ??
    createLLMClient({ apiKey: options.apiKey, defaultModel: modelId });

  try {
    const result = await client.generateText({
      purpose: "seed-grounding",
      model: modelId,
      promptPrefix,
      promptSuffix,
      ...(useThinking
        ? { thinking: { type: "enabled" as const, budgetTokens: 8000 } }
        : {}),
    });
    const rawResponseText = result.text;

    let parsedResponse: ClaimGroundingLlmParsedResponse | undefined;
    let parseError: string | undefined;
    try {
      const jsonSlice = extractJsonFromModelText(rawResponseText);
      const asJson: unknown = JSON.parse(jsonSlice);
      const pr = claimGroundingLlmParsedResponseSchema.safeParse(asJson);
      if (pr.success) {
        parsedResponse = pr.data;
      } else {
        const issue = pr.error.issues[0];
        parseError = `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? pr.error.message}`;
      }
    } catch (err) {
      parseError =
        err instanceof Error
          ? err.message
          : "JSON.parse failed for LLM output.";
    }

    const inT = result.record.inputTokens;
    const outT = result.record.outputTokens;

    const cacheFields =
      result.record.cacheReadTokens != null ||
      result.record.cacheWriteTokens != null
        ? {
            ...(result.record.cacheReadTokens != null
              ? { cacheReadTokens: result.record.cacheReadTokens }
              : {}),
            ...(result.record.cacheWriteTokens != null
              ? { cacheWriteTokens: result.record.cacheWriteTokens }
              : {}),
          }
        : {};

    if (!parsedResponse) {
      const grounding = applyCanonicalGroundingBlocksDownstream({
        status: "not_attempted",
        analystClaim,
        normalizedClaim: analystClaim,
        supportSpans: [],
        blocksDownstream: false,
        detailReason: `LLM returned invalid grounding JSON: ${parseError ?? "unknown parse error"}`,
      });
      return {
        grounding,
        llmCall: {
          ...baseLlmFields,
          rawResponseText,
          parseError,
          quoteVerification: undefined,
          inputTokens: inT,
          outputTokens: outT,
          totalTokens: result.record.totalTokens,
          latencyMs: result.record.latencyMs,
          finishReason: result.record.finishReason,
          estimatedCostUsd: result.record.estimatedCostUsd,
          ...cacheFields,
        },
      };
    }

    const { grounding: mapped, quoteVerification } =
      mapLlmParsedResponseToClaimGrounding({
        analystClaim,
        response: parsedResponse,
        manuscript,
      });

    return {
      grounding: mapped,
      llmCall: {
        ...baseLlmFields,
        rawResponseText,
        parsedResponse,
        parseError,
        quoteVerification,
        inputTokens: inT,
        outputTokens: outT,
        totalTokens: result.record.totalTokens,
        latencyMs: result.record.latencyMs,
        finishReason: result.record.finishReason,
        estimatedCostUsd: result.record.estimatedCostUsd,
        ...cacheFields,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      grounding: applyCanonicalGroundingBlocksDownstream({
        status: "not_attempted",
        analystClaim,
        normalizedClaim: analystClaim,
        supportSpans: [],
        blocksDownstream: false,
        detailReason: `LLM claim grounding failed: ${msg}`,
      }),
      llmCall: {
        ...baseLlmFields,
        rawResponseText: "",
        parseError: msg,
        quoteVerification: undefined,
        latencyMs: 0,
        finishReason: undefined,
        estimatedCostUsd: undefined,
      },
    };
  }
}
