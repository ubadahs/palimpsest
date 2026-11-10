import { z } from "zod";
import { evaluationTaskSchema } from "./types.js";
import { jevVariantSchema } from "./optimization-contract.js";

export const providerConfigSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  kind: z.enum(["anthropic", "jev", "djev", "bm25", "rules"]),
  model: z.string().min(1),
  tasks: z.array(evaluationTaskSchema).min(1).optional(),
  endpoint: z.string().url().optional(),
  endpointEnv: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  concurrency: z.number().int().positive().default(6),
  minimumRequestIntervalMs: z.number().int().nonnegative().optional(),
  maxTransientRetries: z.number().int().min(0).max(3).optional(),
  rerankBatchSize: z.number().int().positive().max(20).optional(),
  rerankMinFallbackBatchSize: z.number().int().positive().max(20).optional(),
  maxContextCharacters: z.number().int().positive().optional(),
  implementationRevision: z.string().optional(),
  weights: z.string().optional(),
  quantization: z.string().optional(),
  inferenceSettings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  thinking: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("adaptive"),
        effort: z.enum(["low", "medium", "high", "max"]),
      }),
      z.object({
        type: z.literal("enabled"),
        budgetTokens: z.number().int().positive(),
      }),
    ])
    .optional(),
  /**
   * What an Anthropic adjudicator reads from the seed paper: the chunks the
   * run selected (the default, and what production does) or its whole text.
   */
  adjudicationEvidence: z.enum(["selected_chunks", "seed_text"]).optional(),
  pricePerMillionInputTokensUsd: z.number().nonnegative().optional(),
  pricePerMillionOutputTokensUsd: z.number().nonnegative().optional(),
  /** Defaults to a tenth of the input price; newer models charge less. */
  pricePerMillionCacheReadTokensUsd: z.number().nonnegative().optional(),
  instanceHourlyUsd: z.number().nonnegative().optional(),
  billingWindowSeconds: z.number().positive().optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const experimentConfigSchema = z.object({
  schemaVersion: z.literal("evaluation-experiment-config-v1"),
  promptRevision: z
    .enum(["evaluation-prompts-v1", "evaluation-prompts-v2"])
    .default("evaluation-prompts-v2"),
  tasks: z.array(evaluationTaskSchema).min(1),
  providers: z.array(providerConfigSchema).min(1),
  repetitions: z.number().int().positive().default(1),
  maxRequests: z.number().int().positive().optional(),
  maxDurationSeconds: z.number().int().positive().optional(),
  optimization: z
    .object({
      variants: z.array(jevVariantSchema).min(1),
      baselineReferences: z
        .array(
          z.object({
            experimentId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
            providerId: z.string().min(1),
          }),
        )
        .default([]),
      maxAttempts: z.number().int().positive().max(200).default(200),
      maxActiveSeconds: z.number().int().positive().max(1800).default(1800),
      requestTimeoutMs: z.number().int().positive().max(30_000).default(30_000),
      concurrency: z.number().int().min(1).max(6).default(1),
      minimumRequestIntervalMs: z.number().int().nonnegative().default(8_000),
      probeMinimumRequestIntervalMs: z.number().int().nonnegative().default(0),
      retryBaseDelayMs: z
        .number()
        .int()
        .nonnegative()
        .max(30_000)
        .default(2_000),
      stopAfterConsecutiveServiceFailures: z
        .number()
        .int()
        .positive()
        .optional(),
    })
    .optional(),
});
export type ExperimentConfig = z.infer<typeof experimentConfigSchema>;
