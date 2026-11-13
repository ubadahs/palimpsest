/** Evidence's production adapter: relevance reranking of BM25 candidates. */

import type { z } from "zod";
import { evidenceRerankOutputSchema } from "../../contract/artifacts/index.js";
import type { ThinkingEffort } from "../../contract/model-execution.js";
import { contentAddressedModelExecution } from "../../pipeline/provenance-store.js";
import {
  llmRequestProvenanceFields,
  mapLlmFailureCode,
  modelExecutionTelemetry,
  type ProductionAdapterDeps,
} from "../production.js";
import {
  buildRelevanceRerankPrompt,
  RERANK_PROMPT_ID,
  RERANK_PROMPT_VERSION,
  rerankModelResponseSchema,
} from "./prompts.js";
import type { EvidenceAdapters, EvidenceRerankerInput } from "./run.js";

export function buildEvidenceAdapters(
  deps: ProductionAdapterDeps,
): EvidenceAdapters {
  if (!deps.runConfig.evidence.rerankEnabled) {
    return {};
  }
  const store = deps.provenanceStore;
  const model = deps.runConfig.evidence.rerankModel;
  // Ranking passages is a quick judgment, so the lowest effort.
  const effort: ThinkingEffort = "low";

  return {
    rerank: async (input: EvidenceRerankerInput) => {
      const prompt = buildRelevanceRerankPrompt(input);
      const requestBody = {
        familyId: input.familyId,
        bm25RunId: input.bm25RunId,
        topN: input.topN,
        candidateChunkIds: input.candidates.map((c) => c.chunkId),
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "evidence-rerank",
          model,
          promptVersion: RERANK_PROMPT_VERSION,
          effort,
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "evidence-rerank",
          model,
          prompt,
          schema: rerankModelResponseSchema,
          context: { stageKey: "evidence" },
          effort,
          exactCache: { keyVersion: RERANK_PROMPT_VERSION },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: mapped.reasonCode,
          reason: mapped.reason,
          execution: contentAddressedModelExecution({
            provider: "anthropic",
            model,
            promptId: RERANK_PROMPT_ID,
            promptVersion: RERANK_PROMPT_VERSION,
            promptText: prompt,
            requestBody,
            responseBody: {
              role: "normalized-evidence-rerank-failure",
              error: mapped.reason,
              ...(mapped.responseText != null
                ? { modelText: mapped.responseText }
                : {}),
            },
            store,
            requestRole: "normalized-evidence-rerank-request",
            responseRole: "normalized-evidence-rerank-failure",
            stage: "evidence",
          }),
        };
      }

      const parsed = mapRerankResponse(result.object, input.candidates);
      const execution = contentAddressedModelExecution({
        provider: "anthropic",
        model: result.record.model,
        ...modelExecutionTelemetry(result.record),
        promptId: RERANK_PROMPT_ID,
        promptVersion: RERANK_PROMPT_VERSION,
        promptText: prompt,
        requestBody,
        responseBody: {
          role: "normalized-evidence-rerank-response",
          object: result.object,
          mapped: parsed.ok ? parsed.data : { mappingError: parsed.error },
        },
        store,
        requestRole: "normalized-evidence-rerank-request",
        responseRole: "normalized-evidence-rerank-response",
        stage: "evidence",
      });
      if (!parsed.ok) {
        return {
          status: "failed" as const,
          reasonCode: "invalid_response" as const,
          reason: parsed.error,
          execution,
        };
      }
      return {
        status: "completed" as const,
        rawOutput: parsed.data,
        execution,
      };
    },
  };
}

/**
 * Turns the model's candidate numbers into chunk ids. The reply's shape is
 * guaranteed by the output schema; what can still go wrong is a number that
 * names no candidate, or a set that names none of them.
 */

function mapRerankResponse(
  reply: z.infer<typeof rerankModelResponseSchema>,
  candidates: EvidenceRerankerInput["candidates"],
):
  | { ok: true; data: z.infer<typeof evidenceRerankOutputSchema> }
  | { ok: false; error: string } {
  const seen = new Set<string>();
  const mapped = reply.results.flatMap((entry) => {
    const candidate = candidates[entry.candidate - 1];
    if (!candidate || seen.has(candidate.chunkId)) return [];
    seen.add(candidate.chunkId);
    return [
      {
        chunkId: candidate.chunkId,
        relevanceScore: entry.relevanceScore,
        rationale: entry.rationale?.trim() || "(no rationale given)",
      },
    ];
  });
  mapped.sort((left, right) => right.relevanceScore - left.relevanceScore);
  const result = evidenceRerankOutputSchema.safeParse({
    results: mapped.map((entry, index) => ({ ...entry, rank: index + 1 })),
  });
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  return {
    ok: false,
    error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
  };
}
