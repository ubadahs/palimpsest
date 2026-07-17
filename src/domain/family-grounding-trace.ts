import { z } from "zod";

import { claimGroundingSchema } from "./pre-screen.js";

/** Per-family grounding trace persisted in the grounding-trace sidecar. */
export const familyGroundingTraceSchema = z
  .object({
    familyId: z.string().min(1),
    canonicalTrackedClaim: z.string().min(1),
    grounding: claimGroundingSchema,
    /** Present when an LLM grounding call ran; includes Anthropic cache token fields when reported. */
    llmUsage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
        cacheWriteTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();
export type FamilyGroundingTrace = z.infer<typeof familyGroundingTraceSchema>;
