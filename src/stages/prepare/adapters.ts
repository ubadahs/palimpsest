/** Prepare's production adapter: citation-role classification. */

import type { ThinkingEffort } from "../../contract/model-execution.js";
import { isReviewPaperType } from "../../domain/attribution-signal.js";
import { type LLMCallRecord } from "../../integrations/llm-client.js";
import { contentAddressedModelExecution } from "../../pipeline/provenance-store.js";
import {
  llmRequestProvenanceFields,
  mapLlmFailureCode,
  modelExecutionTelemetry,
  type ProductionAdapterDeps,
} from "../production.js";
import {
  buildCitationRolePrompt,
  ROLE_CLASSIFICATION_PROMPT_ID,
  ROLE_CLASSIFICATION_PROMPT_VERSION,
  citationRoleResponseSchema,
} from "./prompts.js";
import {
  applyPrepareModelRole,
  classifyPrepareOccurrenceDeterministically,
  prepareRoleNeedsModelFallback,
  type PrepareAdapters,
} from "./run.js";

/**
 * Deterministic regex first, model second. The regex pass costs nothing and
 * settles most occurrences; only the ones it calls `unclear` reach a small
 * model, which is where the deterministic classifier lost the most records.
 */

export function buildPrepareAdapters(
  deps: ProductionAdapterDeps,
): PrepareAdapters {
  const store = deps.provenanceStore;
  const model = deps.runConfig.prepare.roleClassifierModel;
  // Naming a citation's role is a quick judgment, so the lowest effort.
  const effort: ThinkingEffort = "low";

  return {
    classifyCitation: async (input) => {
      const deterministic = classifyPrepareOccurrenceDeterministically(
        input.citationOccurrence,
        {
          isReviewMediated: isReviewPaperType(
            input.citingPaper.paper.paperType,
          ),
          occurrenceSourceClaimRecords: input.occurrenceSourceClaimRecords,
        },
      );
      if (!prepareRoleNeedsModelFallback(deterministic)) {
        return deterministic;
      }

      const prompt = buildCitationRolePrompt(input);
      const requestBody = {
        familyId: input.family.familyId,
        citationOccurrenceId: input.citationOccurrence.mentionId,
        promptText: prompt,
        llm: llmRequestProvenanceFields({
          purpose: "citation-role-classification",
          model,
          promptVersion: ROLE_CLASSIFICATION_PROMPT_VERSION,
          effort,
          forceRefresh: deps.forceRefresh === true,
        }),
      };
      const modelExecution = (
        responseBody: Record<string, unknown>,
        record?: LLMCallRecord,
      ) =>
        contentAddressedModelExecution({
          provider: "anthropic",
          model: record?.model ?? model,
          ...(record ? modelExecutionTelemetry(record) : {}),
          promptId: ROLE_CLASSIFICATION_PROMPT_ID,
          promptVersion: ROLE_CLASSIFICATION_PROMPT_VERSION,
          promptText: prompt,
          requestBody,
          responseBody,
          store,
          requestRole: "normalized-citation-role-request",
          responseRole: String(responseBody["role"]),
          stage: "prepare",
        });

      // Only the provider call is guarded: a failure after it is a programmer
      // error, and swallowing one here would report it as a provider outage.
      let result;
      try {
        result = await deps.llmClient.generateObject({
          purpose: "citation-role-classification",
          model,
          prompt,
          schema: citationRoleResponseSchema,
          context: { stageKey: "prepare" },
          effort,
          exactCache: {
            keyVersion: ROLE_CLASSIFICATION_PROMPT_VERSION,
          },
        });
      } catch (error) {
        const mapped = mapLlmFailureCode(error);
        return applyPrepareModelRole(deterministic, {
          citationRole: "unclear",
          rationale: `Model role fallback failed (${mapped.reasonCode}): ${mapped.reason}`,
          signals: [`model-role:${mapped.reasonCode}`],
          execution: modelExecution({
            role: "normalized-citation-role-failure",
            error: mapped.reason,
            ...(mapped.responseText != null
              ? { modelText: mapped.responseText }
              : {}),
          }),
        });
      }

      return applyPrepareModelRole(deterministic, {
        citationRole: result.object.citationRole,
        rationale: result.object.rationale,
        signals: [`model-role:${result.object.citationRole}`],
        execution: modelExecution(
          {
            role: "normalized-citation-role-response",
            object: result.object,
          },
          result.record,
        ),
      });
    },
  };
}
