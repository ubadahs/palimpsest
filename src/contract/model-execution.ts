import { z } from "zod";

import {
  artifactReferenceSchema,
  sha256DigestSchema,
} from "./lean-artifact-primitives.js";

/**
 * Shared model-execution provenance shape used by Discover, Scope, Evidence,
 * and Adjudicate adapter boundaries and persisted artifacts.
 */
export const modelExecutionSchema = z
  .object({
    kind: z.literal("model"),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    promptContentHash: sha256DigestSchema,
    requestHash: sha256DigestSchema,
    requestArtifact: artifactReferenceSchema,
    responseArtifact: artifactReferenceSchema,
  })
  .strict();

export type ModelExecution = z.infer<typeof modelExecutionSchema>;
