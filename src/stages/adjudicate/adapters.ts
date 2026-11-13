/** Adjudicate's production adapter: one model request per eligible record. The prompts live in `packet.ts` and `seed-text.ts`. */

import { z } from "zod";
import {
  adjudicateModelOutputSchema,
  hashAdjudicateRequest,
} from "../../contract/artifacts/adjudicate.js";
import {
  resolveThinkingEffort,
  type LLMCallRecord,
} from "../../integrations/llm-client.js";
import { contentAddressedModelExecution } from "../../pipeline/provenance-store.js";
import { canonicalSha256 } from "../../shared/stable-identity.js";
import {
  llmRequestProvenanceFields,
  mapLlmFailureCode,
  modelExecutionTelemetry,
  type ProductionAdapterDeps,
} from "../production.js";
import {
  adjudicatePromptText,
  type AdjudicateAdapterInput,
  type AdjudicateAdapters,
} from "./run.js";
import { seedTextAdjudicateReplySchema } from "./seed-text.js";

export function buildAdjudicateAdapters(
  deps: ProductionAdapterDeps,
): AdjudicateAdapters {
  const store = deps.provenanceStore;
  const model = deps.runConfig.adjudicate.model;
  // The first request that carries a seed text writes the provider's cache;
  // the rest of that seed's records wait for it so they read the cache
  // instead of each paying to write it.
  const cacheWrites = new Map<string, Promise<unknown>>();

  return {
    adjudicate: async (input: AdjudicateAdapterInput) => {
      const promptText = adjudicatePromptText(input);
      const expectedRequestHash = hashAdjudicateRequest(input);
      const effort = resolveThinkingEffort({
        enabled: deps.runConfig.adjudicate.thinking,
        effort: deps.runConfig.adjudicate.effort,
      });
      // A whole-seed-text request names the seed text by its hash: it keys
      // the cache write below, and stands in for the text in the stored
      // request, because the Evidence artifact this stage reads already
      // holds it.
      const seedTextContentHash =
        input.evidence === "seed_text"
          ? canonicalSha256(input.promptPrefix)
          : undefined;
      const llm = llmRequestProvenanceFields({
        purpose: "adjudication",
        model,
        ...(input.evidence === "seed_text"
          ? {
              sharedPrefix: input.promptPrefix,
              batching: deps.llmClient.batching,
            }
          : {}),
        promptVersion: input.promptVersion,
        effort,
        forceRefresh: deps.forceRefresh === true,
      });
      const requestBody = {
        purpose: input.purpose,
        recordId: input.recordId,
        promptId: input.promptId,
        promptVersion: input.promptVersion,
        ...(input.evidence === "seed_text"
          ? { seedTextContentHash, promptSuffix: input.promptSuffix }
          : { promptText }),
        llm,
      };
      const executionOf = (
        responseRole: string,
        responseBody: Record<string, unknown>,
        served: { model: string } & Partial<
          ReturnType<typeof modelExecutionTelemetry>
        >,
      ) =>
        contentAddressedModelExecution({
          provider: "anthropic",
          ...served,
          promptId: input.promptId,
          promptVersion: input.promptVersion,
          promptText,
          requestBody,
          responseBody: { role: responseRole, ...responseBody },
          store,
          requestRole: "normalized-adjudicate-request",
          responseRole,
          requestHash: expectedRequestHash,
          stage: "adjudicate",
        });
      const request = {
        purpose: "adjudication" as const,
        model,
        context: { stageKey: "adjudicate" as const },
        effort,
        exactCache: { keyVersion: input.promptVersion },
      };

      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let reply: { object: unknown; record: LLMCallRecord; rawOutput: unknown };
      try {
        if (input.evidence === "seed_text") {
          const cacheWrite = cacheWrites.get(seedTextContentHash!);
          if (cacheWrite) await cacheWrite;
          const sent = deps.llmClient.generateObject({
            ...request,
            promptPrefix: input.promptPrefix,
            promptSuffix: input.promptSuffix,
            schema: seedTextAdjudicateReplySchema,
          });
          if (!cacheWrite)
            cacheWrites.set(
              seedTextContentHash!,
              sent.catch(() => undefined),
            );
          const result = await sent;
          // The stage verifies the quotes against the seed text.
          reply = { ...result, rawOutput: result.object };
        } else {
          const result = await deps.llmClient.generateObject({
            ...request,
            prompt: input.promptText,
            schema: adjudicateModelResponseSchema,
          });
          const mapped = mapAdjudicateResponse(result.object, input.packet);
          reply = {
            ...result,
            rawOutput: mapped.ok ? mapped.data : { mappingError: mapped.error },
          };
        }
      } catch (error) {
        const failure = mapLlmFailureCode(error);
        return {
          status: "failed" as const,
          reasonCode: failure.reasonCode,
          reason: failure.reason,
          execution: executionOf(
            "normalized-adjudicate-failure",
            {
              error: failure.reason,
              ...(failure.responseText != null
                ? { modelText: failure.responseText }
                : {}),
            },
            { model },
          ),
        };
      }

      return {
        status: "completed" as const,
        rawOutput: reply.rawOutput,
        execution: executionOf(
          "normalized-adjudicate-response",
          {
            object: reply.object,
            ...(input.evidence === "seed_text"
              ? {}
              : { mapped: reply.rawOutput }),
          },
          {
            model: reply.record.model,
            ...modelExecutionTelemetry(reply.record),
          },
        ),
      };
    },
  };
}

/** Model reply with chunks referenced by number; mapped to ids before the contract schema. */

export const adjudicateModelResponseSchema = z
  .object({
    citingAssertion: z.string().min(1),
    sourceStatement: z.string().min(1),
    verdict: z.string().min(1),
    mutationKinds: z.array(z.string()).default([]),
    direction: z.string().min(1),
    rationale: z.string().min(1),
    confidence: z.string().min(1),
    citedChunks: z.array(z.number().int().positive()).min(1),
  })
  .strict();

/**
 * Turns the model's chunk numbers into ids and applies the contract schema.
 * The reply's field shape is guaranteed by the output schema; the verdict
 * vocabulary and the chunk references are not.
 */

function mapAdjudicateResponse(
  reply: z.infer<typeof adjudicateModelResponseSchema>,
  packet: AdjudicateAdapterInput["packet"],
):
  | { ok: true; data: z.infer<typeof adjudicateModelOutputSchema> }
  | { ok: false; error: string } {
  const { citedChunks, ...rest } = reply;
  const citedChunkIds = [
    ...new Set(
      citedChunks.flatMap((handle) => {
        const chunk = packet.selectedChunks[handle - 1];
        return chunk ? [chunk.chunkId] : [];
      }),
    ),
  ];
  const result = adjudicateModelOutputSchema.safeParse({
    ...rest,
    citedChunkIds,
  });
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  return {
    ok: false,
    error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? result.error.message}`,
  };
}
