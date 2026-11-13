import { z } from "zod";

import {
  artifactReferenceSchema,
  sha256DigestSchema,
} from "./artifacts/primitives.js";

/** How hard a model thinks: every supported model thinks adaptively. */
export const thinkingEffortSchema = z.enum(["low", "medium", "high", "max"]);
export type ThinkingEffort = z.infer<typeof thinkingEffortSchema>;

/**
 * Shared model-execution provenance shape used by Discover, Scope, Prepare,
 * Evidence, and Adjudicate adapter boundaries and persisted artifacts.
 *
 * `model` is what the call asked for; `servedModel` is what the provider says
 * it answered with, and the two differ whenever an alias resolves to a dated
 * snapshot. `exactCacheHit` and `effort` are the remaining facts needed to
 * tell a billed call from a replayed one. All three are optional and excluded
 * from result identity: they describe how an answer was obtained, not what it
 * was.
 */
export const modelExecutionSchema = z
  .object({
    kind: z.literal("model"),
    provider: z.string().min(1),
    model: z.string().min(1),
    servedModel: z.string().min(1).optional(),
    exactCacheHit: z.boolean().optional(),
    effort: thinkingEffortSchema.optional(),
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    promptContentHash: sha256DigestSchema,
    requestHash: sha256DigestSchema,
    requestArtifact: artifactReferenceSchema,
    responseArtifact: artifactReferenceSchema,
  })
  .strict();

export type ModelExecution = z.infer<typeof modelExecutionSchema>;
