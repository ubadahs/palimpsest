/** Evaluation arm that adjudicates from the whole seed paper. */
import { canonicalAdjudicatePacketSchema } from "../adjudication/canonical-adjudicate-packet.js";
import {
  buildSeedTextAdjudicatePrompt,
  resolveSeedTextJudgment,
  seedTextAdjudicateReplySchema,
} from "../adjudication/seed-text-adjudicate.js";
import type { LLMClient } from "../integrations/llm-client.js";
import type { ProviderConfig } from "./config.js";
import {
  anthropicCall,
  ProviderRequestError,
  type ProviderCall,
  type ProviderPrediction,
} from "./providers.js";
import type { EvaluationCase, SeedDocument } from "./types.js";

type AdjudicationCase = Extract<EvaluationCase, { task: "adjudication" }>;

export function readsSeedText(
  provider: ProviderConfig,
  item: EvaluationCase,
): item is AdjudicationCase {
  return (
    provider.adjudicationEvidence === "seed_text" &&
    item.task === "adjudication"
  );
}

export async function adjudicateFromSeedText(input: {
  item: AdjudicationCase;
  seed: SeedDocument | undefined;
  provider: ProviderConfig;
  llm: LLMClient | undefined;
  requestSequence?: number | undefined;
}): Promise<{
  prediction: ProviderPrediction;
  calls: ProviderCall[];
  diagnostics: unknown;
}> {
  const { item, seed, provider, llm } = input;
  if (!llm) throw new Error("Missing Anthropic client");
  if (!seed)
    throw new ProviderRequestError(
      `Dataset holds no seed text for ${item.seedDoi}; rebuild it with the current builder`,
      "provider_failure",
    );
  const prompt = buildSeedTextAdjudicatePrompt({
    packet: canonicalAdjudicatePacketSchema.parse(item.packet),
    seed,
  });
  if (
    provider.maxContextCharacters != null &&
    prompt.prefix.length + prompt.suffix.length > provider.maxContextCharacters
  )
    throw new ProviderRequestError(
      "Prompt exceeds configured context limit",
      "context_limit",
    );
  const result = await llm.generateObject({
    purpose: "adjudication",
    model: provider.model,
    promptPrefix: prompt.prefix,
    promptSuffix: prompt.suffix,
    schema: seedTextAdjudicateReplySchema,
    ...(provider.thinking ? { thinking: provider.thinking } : {}),
  });
  const call = anthropicCall(result.record, provider, input.requestSequence);
  const judgment = resolveSeedTextJudgment(result.object, seed.blocks);
  // The seed text is in the dataset; saving it again per trial would only
  // repeat it.
  const request = { seedDoi: seed.seedDoi, suffix: prompt.suffix };
  if (!judgment.ok)
    throw new ProviderRequestError(judgment.error, "invalid_response", [call], {
      request,
      response: result.object,
    });
  return {
    prediction: { verdict: judgment.data.verdict },
    calls: [call],
    diagnostics: { request, response: judgment.data },
  };
}
