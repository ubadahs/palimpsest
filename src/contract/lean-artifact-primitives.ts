import { z } from "zod";

import { uniqueSorted } from "../shared/order.js";
import { stageKeySchema } from "./lean-stages.js";

/**
 * Cycle-free primitives shared by lean stage envelopes and stage-focused
 * contract modules. Keep scientific stage payloads out of this module.
 */
export const sha256DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");

export const stableIdentifierSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*_[a-f0-9]{64}$/,
    "Expected a namespaced stable identifier",
  );

export const leanArtifactIdSchema = z
  .string()
  .regex(/^artifact_[a-f0-9]{64}$/, "Expected a stable artifact identifier");

export const artifactReferenceSchema = z
  .object({
    artifactId: stableIdentifierSchema,
    contentHash: sha256DigestSchema,
    role: z.string().min(1),
    canonicalStage: stageKeySchema.optional(),
    uri: z.string().min(1).optional(),
  })
  .strict();

export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

/**
 * Validate, deduplicate, and order a provenance reference list. Every artifact
 * that records where its inputs came from goes through this, so two runs that
 * saw the same inputs produce the same bytes.
 */
export function uniqueSortedArtifactReferences(
  references: readonly ArtifactReference[],
): ArtifactReference[] {
  return uniqueSorted(
    references.map((reference) => artifactReferenceSchema.parse(reference)),
  );
}
