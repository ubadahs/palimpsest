import type { z } from "zod";

import {
  resolveThinkingEffort,
  type LLMPurpose,
} from "../../integrations/llm-client.js";
import { contentAddressedModelExecution } from "../../pipeline/provenance-store.js";
import {
  llmRequestProvenanceFields,
  mapLlmFailureCode,
  modelExecutionTelemetry,
  type ProductionAdapterDeps,
} from "../production.js";

export function createScopeModelRunner(deps: ProductionAdapterDeps) {
  const store = deps.provenanceStore;
  const model = deps.runConfig.scope.groundingModel;
  const effort = resolveThinkingEffort({
    enabled: deps.runConfig.scope.groundingThinking,
  });

  return async function runScopeModel<T extends z.ZodType>(input: {
    purpose: LLMPurpose;
    promptId: string;
    promptVersion: string;
    promptParts: { prefix: string; suffix: string };
    schema: T;
    identity: Record<string, unknown>;
    role: string;
  }) {
    const {
      purpose,
      promptId,
      promptVersion,
      promptParts,
      schema,
      identity,
      role,
    } = input;
    const prompt = `${promptParts.prefix}${promptParts.suffix}`;
    const requestBody = {
      ...identity,
      promptText: prompt,
      llm: llmRequestProvenanceFields({
        purpose,
        model,
        sharedPrefix: promptParts.prefix,
        batching: deps.llmClient.batching,
        promptVersion,
        effort,
        forceRefresh: deps.forceRefresh === true,
      }),
    };
    const request = {
      provider: "anthropic",
      promptId,
      promptVersion,
      promptText: prompt,
      requestBody,
      store,
      requestRole: `${role}-request`,
      stage: "scope",
    } as const;

    // Only the provider call is guarded. Provenance errors must abort.
    let result;
    try {
      result = await deps.llmClient.generateObject({
        purpose,
        model,
        promptPrefix: promptParts.prefix,
        promptSuffix: promptParts.suffix,
        schema,
        context: { stageKey: "scope" },
        effort,
        exactCache: { keyVersion: promptVersion },
      });
    } catch (error) {
      const mapped = mapLlmFailureCode(error);
      const responseRole = `${role}-failure`;
      return {
        status: "failed" as const,
        reasonCode: mapped.reasonCode,
        reason: mapped.reason,
        execution: contentAddressedModelExecution({
          ...request,
          model,
          responseBody: {
            role: responseRole,
            error: mapped.reason,
            ...(mapped.responseText != null
              ? { modelText: mapped.responseText }
              : {}),
          },
          responseRole,
        }),
      };
    }

    const responseRole = `${role}-response`;
    return {
      status: "completed" as const,
      rawOutput: result.object,
      execution: contentAddressedModelExecution({
        ...request,
        model: result.record.model,
        ...modelExecutionTelemetry(result.record),
        responseBody: { role: responseRole, object: result.object },
        responseRole,
      }),
    };
  };
}
