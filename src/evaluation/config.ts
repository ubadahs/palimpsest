import { z } from "zod";
import { thinkingEffortSchema } from "../contract/model-execution.js";
import { evaluationTaskSchema, type EvaluationTask } from "./types.js";
import { jevVariantSchema } from "./optimization-contract.js";

export const providerConfigSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  kind: z.enum(["anthropic", "jev", "bm25", "rules"]),
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
  /** Saved experiments record thinking in this shape, so it stays. */
  thinking: z
    .object({
      type: z.literal("adaptive"),
      effort: thinkingEffortSchema,
    })
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

const promptRevisionValues = [
  "evaluation-prompts-v1",
  "evaluation-prompts-v2",
  "evaluation-prompts-v3",
  "evaluation-prompts-v4",
  "evaluation-prompts-v5",
] as const;
type PromptRevision = (typeof promptRevisionValues)[number];

/** The only revision new trials run under; older experiments stay readable. */
export const CURRENT_PROMPT_REVISION: PromptRevision = "evaluation-prompts-v5";

type PromptReader = Pick<ProviderConfig, "kind" | "adjudicationEvidence">;

/**
 * What each revision after v2 reworded; v1 and v2 changed every prompt.
 * v3 reworded the role and adjudication questions Jev providers answer to the
 * production rubric. v4 put the verdict definitions and the whole-paper
 * adjudication prompt in plain words ("the cited paper", no "kernel"); the
 * selected-chunks prompt Anthropic providers read is frozen in each dataset,
 * so only Jev and whole-paper adjudication saw it change. v5 told bundled
 * records that a paper supporting part of the statement is faithfully cited;
 * only whole-paper adjudication renders that note live.
 */
const REWORDED: Partial<
  Record<
    PromptRevision,
    (provider: PromptReader, task: EvaluationTask) => boolean
  >
> = {
  "evaluation-prompts-v3": ({ kind }, task) =>
    kind === "jev" && (task === "role" || task === "adjudication"),
  "evaluation-prompts-v4": ({ kind, adjudicationEvidence }, task) =>
    task === "adjudication" &&
    (kind === "jev" ||
      (kind === "anthropic" && adjudicationEvidence === "seed_text")),
  "evaluation-prompts-v5": ({ kind, adjudicationEvidence }, task) =>
    task === "adjudication" &&
    kind === "anthropic" &&
    adjudicationEvidence === "seed_text",
};

/**
 * The revision whose prompts a provider was actually shown for a task under
 * `revision`: the latest one up to it that reworded them. A trial saved under
 * that revision is reusable under this one.
 */
export function promptsSeen(
  revision: PromptRevision,
  provider: PromptReader,
  task: EvaluationTask,
): PromptRevision {
  for (let index = promptRevisionValues.indexOf(revision); index > 0; index--) {
    const candidate = promptRevisionValues[index]!;
    const reworded = REWORDED[candidate];
    if (!reworded || reworded(provider, task)) return candidate;
  }
  return promptRevisionValues[0];
}

export const experimentConfigSchema = z.object({
  schemaVersion: z.literal("evaluation-experiment-config-v1"),
  promptRevision: z.enum(promptRevisionValues).default(CURRENT_PROMPT_REVISION),
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
