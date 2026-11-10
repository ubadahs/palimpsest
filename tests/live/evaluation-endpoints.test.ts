import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLLMClient } from "../../src/integrations/llm-client.js";
import { providerConfigSchema } from "../../src/evaluation/config.js";
import {
  createRequestBudget,
  executeProviderCase,
} from "../../src/evaluation/providers.js";
import type { EvaluationCase } from "../../src/evaluation/types.js";

const enabled = process.env.PALIMPSEST_EVAL_ENDPOINT_SMOKE === "1";
const roleCase: EvaluationCase = {
  caseId: "invented-role",
  runId: "invented",
  seedDoi: "10.0/invented",
  recordId: "invented-record",
  sourceArtifactHashes: { report: "invented" },
  task: "role",
  occurrenceId: "invented-occurrence",
  context:
    "The citing paper reports that a fictional 2026 study measured a 20% rise in enzyme Q activity.",
  claims: ["The fictional study measured a 20% rise in enzyme Q activity"],
  deterministicRole: "substantive_attribution",
  deterministicUnclear: false,
  anthropicPrompt:
    "Classify the role of this citation. Return citationRole and rationale as JSON. The citing paper reports that a fictional study measured a 20% rise in enzyme Q activity. Choose substantive_attribution, background_context, methods_materials, acknowledgment_or_low_information, or unclear.",
};

describe.skipIf(!enabled)(
  "opt-in invented-example evaluation endpoints",
  () => {
    it("has at least one configured provider", () => {
      expect(
        Boolean(
          process.env.ANTHROPIC_API_KEY ||
          process.env.TYPESAFE_API_KEY ||
          process.env.AI_GATEWAY_API_KEY ||
          process.env.DJEV_ENDPOINT,
        ),
      ).toBe(true);
    });

    it.skipIf(!process.env.ANTHROPIC_API_KEY)(
      "Anthropic structured role",
      async () => {
        const provider = providerConfigSchema.parse({
          id: "anthropic",
          kind: "anthropic",
          model: "claude-haiku-5-5",
        });
        const llm = createLLMClient({
          apiKey: process.env.ANTHROPIC_API_KEY!,
          defaultModel: provider.model,
          forceRefresh: true,
        });
        const result = await executeProviderCase(
          roleCase,
          provider,
          undefined,
          llm,
          new AbortController().signal,
        );
        expect(
          z.object({ role: z.string() }).safeParse(result.prediction).success,
        ).toBe(true);
      },
    );

    it.skipIf(!process.env.TYPESAFE_API_KEY && !process.env.AI_GATEWAY_API_KEY)(
      "Jev structured role",
      async () => {
        const gateway = Boolean(process.env.AI_GATEWAY_API_KEY);
        const provider = providerConfigSchema.parse({
          id: "jev",
          kind: "jev",
          model: gateway ? "typesafe-ai/jev" : "jev-1.13.0",
          ...(gateway
            ? {
                endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
                apiKeyEnv: "AI_GATEWAY_API_KEY",
              }
            : {}),
        });
        const budget = createRequestBudget(provider, () => 1);
        const result = await executeProviderCase(
          roleCase,
          provider,
          budget,
          undefined,
          new AbortController().signal,
        );
        expect(
          z.object({ role: z.string() }).safeParse(result.prediction).success,
        ).toBe(true);
      },
    );

    it.skipIf(!process.env.DJEV_ENDPOINT)("djev native span", async () => {
      const provider = providerConfigSchema.parse({
        id: "djev",
        kind: "djev",
        model: "dgemma",
        endpoint: process.env.DJEV_ENDPOINT,
        apiKeyEnv: "DJEV_API_KEY",
      });
      const budget = createRequestBudget(provider, () => 1);
      const item: EvaluationCase = {
        ...roleCase,
        task: "span",
        claimRecordId: "invented-claim",
        claim: "enzyme Q activity rose by 20%",
        context:
          "The imaginary assay found that enzyme Q activity rose by 20% in a toy sample.",
      };
      const result = await executeProviderCase(
        item,
        provider,
        budget,
        undefined,
        new AbortController().signal,
      );
      expect(
        z.object({ span: z.unknown() }).safeParse(result.prediction).success,
      ).toBe(true);
    });
  },
);
