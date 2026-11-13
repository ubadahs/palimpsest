/** Browser-safe contracts for the bounded Jev optimization experiment. */
import { z } from "zod";

export const jevVariantSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  task: z.enum(["role", "rerank"]),
  layout: z.enum(["role-v2", "shared-passages", "passage-per-question"]),
  batchSize: z.number().int().min(1).max(20).optional(),
  questionOrder: z.enum(["stable", "reversed"]).default("stable"),
  repetition: z.number().int().positive().default(1),
  phase: z.enum(["fixture", "fallback", "main", "comparison", "probe"]),
  caseIds: z.array(z.string().min(1)).optional(),
  concurrencyCeiling: z.number().int().min(1).max(6).optional(),
});
export type JevVariant = z.infer<typeof jevVariantSchema>;

export type JevRequestSpec = {
  requestId: string;
  requestHash: string;
  variantId: string;
  caseId: string;
  batchIndex: number;
  body: unknown;
  /** Exact answer key -> frozen candidate ID. Role requests use decision -> role. */
  answerMap: Record<string, string>;
  candidateIds: string[];
};

export const jevAttemptSchema = z.object({
  schemaVersion: z.literal("evaluation-jev-attempt-v1"),
  attemptId: z.string().min(1),
  experimentId: z.string().min(1),
  requestId: z.string().min(1),
  requestHash: z.string().min(1),
  variantId: z.string().min(1),
  caseId: z.string().min(1),
  providerId: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  status: z.enum([
    "in_flight",
    "success",
    "http_error",
    "network_error",
    "invalid_response",
    "interrupted",
  ]),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  queueWaitMs: z.number().nonnegative(),
  retryWaitMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  httpStatus: z.number().int().optional(),
  providerRequestId: z.string().optional(),
  servedModel: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
    })
    .optional(),
  error: z.string().optional(),
  diagnostics: z
    .object({
      responseHeaders: z.record(z.string(), z.string()),
      errorBody: z.string().optional(),
      bodyTruncated: z.boolean().optional(),
    })
    .optional(),
  response: z.unknown().optional(),
});
export type JevAttempt = z.infer<typeof jevAttemptSchema>;

export const jevResultSchema = z.object({
  requestId: z.string().min(1),
  requestHash: z.string().min(1),
  variantId: z.string().min(1),
  caseId: z.string().min(1),
  attemptId: z.string().min(1),
  scores: z
    .record(
      z.string(),
      z.object({
        score: z.number().min(0).max(2),
        probabilities: z
          .record(z.string(), z.number().min(0).max(1))
          .optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
  role: z.string().optional(),
  roleProbabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  roleConfidence: z.number().min(0).max(1).optional(),
});
export type JevResult = z.infer<typeof jevResultSchema>;
