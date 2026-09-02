/**
 * The artifact envelope every canonical stage shares: append-only decisions,
 * provenance, execution metadata, and the two integrity checks that earn their
 * place — the identity hash, and the exact inputs the stage was built from.
 */
import { z } from "zod";

import { compareCodeUnits } from "../../shared/order.js";
import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../../shared/stable-identity.js";
import {
  adjudicateArtifactPayloadSchema,
  validateAdjudicateArtifactLineage,
} from "../canonical-adjudicate.js";
import {
  reportArtifactPayloadSchema,
  validateReportArtifactLineage,
} from "../canonical-report.js";
import type { Result } from "../../domain/common.js";
import type { StageKey } from "../lean-stages.js";
import {
  artifactReferenceSchema,
  leanArtifactIdSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "../lean-artifact-primitives.js";
import { findDuplicate, sameArtifactReference } from "./checks.js";
import { discoverArtifactPayloadSchema } from "./discover.js";
import { scopeArtifactPayloadSchema } from "./scope.js";
import { prepareArtifactPayloadSchema } from "./prepare.js";
import { evidenceArtifactPayloadSchema } from "./evidence.js";

export const leanArtifactSchemaVersion = 1 as const;
export const leanArtifactVersion = 1 as const;

export const decisionActorSchema = z
  .object({
    kind: z.enum(["deterministic", "model", "external", "human"]),
    identifier: z.string().min(1),
  })
  .strict();

const decisionIdentitySchema = z
  .object({
    recordId: stableIdentifierSchema,
    decisionType: z.string().min(1),
    outcome: z.string().min(1),
    reason: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
    actor: decisionActorSchema,
    evidenceArtifacts: z.array(artifactReferenceSchema),
    supersedesDecisionId: stableIdentifierSchema.optional(),
  })
  .strict();
export type AppendOnlyDecisionInput = z.infer<typeof decisionIdentitySchema>;

export function buildDecisionId(
  input: AppendOnlyDecisionInput & { decisionId?: string },
): string {
  return buildStableId("decision", {
    recordId: input.recordId,
    decisionType: input.decisionType,
    outcome: input.outcome,
    reason: input.reason,
    actor: input.actor,
    evidenceArtifacts: sortedArtifactReferences(input.evidenceArtifacts),
    supersedesDecisionId: input.supersedesDecisionId,
  });
}

export const appendOnlyDecisionSchema = decisionIdentitySchema
  .extend({
    decisionId: stableIdentifierSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.decisionId !== buildDecisionId(decision)) {
      context.addIssue({
        code: "custom",
        path: ["decisionId"],
        message: "decisionId does not match the decision identity inputs",
      });
    }
  });
export type AppendOnlyDecision = z.infer<typeof appendOnlyDecisionSchema>;

export function createAppendOnlyDecision(
  input: AppendOnlyDecisionInput,
): AppendOnlyDecision {
  return appendOnlyDecisionSchema.parse({
    ...input,
    decisionId: buildDecisionId(input),
  });
}

const configurationProvenanceSchema = z
  .object({
    contentHash: sha256DigestSchema,
    sourceArtifact: artifactReferenceSchema.optional(),
  })
  .strict();

const codeProvenanceSchema = z
  .object({
    revision: z.string().min(1),
    repository: z.string().min(1).optional(),
    dirty: z.boolean().optional(),
    workingTreeContentHash: sha256DigestSchema.optional(),
  })
  .strict()
  .superRefine((code, context) => {
    if (code.dirty === true && code.workingTreeContentHash == null) {
      context.addIssue({
        code: "custom",
        path: ["workingTreeContentHash"],
        message: "Dirty code provenance requires a working-tree content hash",
      });
    }
  });

const promptProvenanceSchema = z
  .object({
    promptId: z.string().min(1),
    version: z.string().min(1),
    contentHash: sha256DigestSchema,
  })
  .strict();

const modelProvenanceSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    requestHash: sha256DigestSchema,
    requestArtifact: artifactReferenceSchema,
    responseArtifact: artifactReferenceSchema,
  })
  .strict();

export const leanArtifactProvenanceSchema = z
  .object({
    configuration: configurationProvenanceSchema.optional(),
    code: codeProvenanceSchema.optional(),
    prompts: z.array(promptProvenanceSchema),
    models: z.array(modelProvenanceSchema),
  })
  .strict();
export type LeanArtifactProvenance = z.infer<
  typeof leanArtifactProvenanceSchema
>;

const deterministicExecutionSchema = z
  .object({
    kind: z.literal("deterministic"),
    implementation: z.string().min(1),
    replayableFromInputs: z.literal(true),
  })
  .strict();

function externalExecutionSchema<
  const Kind extends "model" | "external" | "hybrid",
>(kind: Kind) {
  return z
    .object({
      kind: z.literal(kind),
      implementation: z.string().min(1),
      replayableFromInputs: z.literal(false),
      responseArtifacts: z.array(artifactReferenceSchema).min(1),
    })
    .strict();
}

export const leanExecutionMetadataSchema = z.union([
  deterministicExecutionSchema,
  externalExecutionSchema("model"),
  externalExecutionSchema("external"),
  externalExecutionSchema("hybrid"),
]);
export type LeanExecutionMetadata = z.infer<typeof leanExecutionMetadataSchema>;

const commonLeanArtifactEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(leanArtifactSchemaVersion),
    artifactVersion: z.literal(leanArtifactVersion),
    artifactId: leanArtifactIdSchema,
    contentHash: sha256DigestSchema,
    runId: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    inputArtifacts: z.array(artifactReferenceSchema),
    provenance: leanArtifactProvenanceSchema,
    execution: leanExecutionMetadataSchema,
    decisions: z.array(appendOnlyDecisionSchema),
  })
  .strict();

export const discoverArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("discover"),
    payload: discoverArtifactPayloadSchema,
  })
  .strict()
  .superRefine(validateLeanArtifactIdentity);
export type DiscoverArtifact = z.infer<typeof discoverArtifactSchema>;
export const scopeArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("scope"),
    payload: scopeArtifactPayloadSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    validateLeanArtifactIdentity(artifact, context);
    validateStageInputLineage(
      artifact,
      {
        stageLabel: "Scope",
        inputs: [artifact.payload.discoverArtifact],
      },
      context,
    );
  });
export type ScopeArtifact = z.infer<typeof scopeArtifactSchema>;
export const prepareArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("prepare"),
    payload: prepareArtifactPayloadSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    validateLeanArtifactIdentity(artifact, context);
    validateStageInputLineage(
      artifact,
      {
        stageLabel: "Prepare",
        runId: artifact.payload.lineage.runId,
        inputs: [
          artifact.payload.lineage.scopeArtifact,
          artifact.payload.lineage.discoverArtifact,
        ],
      },
      context,
    );
  });
export type PrepareArtifact = z.infer<typeof prepareArtifactSchema>;
export const evidenceArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("evidence"),
    payload: evidenceArtifactPayloadSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    validateLeanArtifactIdentity(artifact, context);
    validateStageInputLineage(
      artifact,
      {
        stageLabel: "Evidence",
        runId: artifact.payload.lineage.runId,
        inputs: [
          artifact.payload.lineage.prepareArtifact,
          artifact.payload.lineage.scopeArtifact,
        ],
      },
      context,
    );
  });
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;
export const adjudicateArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("adjudicate"),
    payload: adjudicateArtifactPayloadSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    validateLeanArtifactIdentity(artifact, context);
    validateStageInputLineage(
      artifact,
      {
        stageLabel: "Adjudicate",
        runId: artifact.payload.lineage.runId,
        inputs: [
          artifact.payload.lineage.evidenceArtifact,
          artifact.payload.lineage.prepareArtifact,
        ],
      },
      context,
    );
    validateAdjudicateArtifactLineage(artifact, context);
  });
export type AdjudicateArtifact = z.infer<typeof adjudicateArtifactSchema>;
export const reportArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("report"),
    payload: reportArtifactPayloadSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    validateLeanArtifactIdentity(artifact, context);
    validateStageInputLineage(
      artifact,
      {
        stageLabel: "Report",
        runId: artifact.payload.lineage.runId,
        inputs: [
          artifact.payload.lineage.discoverArtifact,
          artifact.payload.lineage.scopeArtifact,
          artifact.payload.lineage.prepareArtifact,
          artifact.payload.lineage.evidenceArtifact,
          artifact.payload.lineage.adjudicateArtifact,
        ],
      },
      context,
    );
    validateReportArtifactLineage(artifact, context);
  });
export type ReportArtifact = z.infer<typeof reportArtifactSchema>;

export const leanStageArtifactSchema = z.discriminatedUnion("canonicalStage", [
  discoverArtifactSchema,
  scopeArtifactSchema,
  prepareArtifactSchema,
  evidenceArtifactSchema,
  adjudicateArtifactSchema,
  reportArtifactSchema,
]);
export type LeanStageArtifact = z.infer<typeof leanStageArtifactSchema>;

type LeanArtifactIdentityInput = Pick<
  LeanStageArtifact,
  | "schemaVersion"
  | "artifactVersion"
  | "runId"
  | "canonicalStage"
  | "contentHash"
  | "inputArtifacts"
  | "provenance"
  | "execution"
>;

/**
 * Hash scientific content and append-only provenance semantically. Envelope
 * creation time and decision recording times are observational and
 * deliberately excluded; their stable IDs still bind every substantive field.
 */
export function computeLeanArtifactContentHash(input: {
  payload: unknown;
  decisions: readonly AppendOnlyDecision[];
}): string {
  return canonicalSha256({
    contentVersion: 1,
    payload: input.payload,
    decisions: input.decisions.map(decisionContentForHash),
  });
}

/**
 * Artifact identity includes run/stage lineage, semantic content, immutable
 * inputs, and execution provenance. `createdAt` is deliberately excluded.
 */
export function computeLeanArtifactId(
  input: LeanArtifactIdentityInput,
): string {
  return buildStableId("artifact", {
    schemaVersion: input.schemaVersion,
    artifactVersion: input.artifactVersion,
    runId: input.runId,
    canonicalStage: input.canonicalStage,
    contentHash: input.contentHash,
    inputArtifacts: sortedArtifactReferences(input.inputArtifacts),
    provenance: normalizeProvenanceForIdentity(input.provenance),
    execution: normalizeExecutionForIdentity(input.execution),
  });
}

type LeanStageArtifactBuildInput =
  | Omit<z.input<typeof discoverArtifactSchema>, "artifactId" | "contentHash">
  | Omit<z.input<typeof scopeArtifactSchema>, "artifactId" | "contentHash">
  | Omit<z.input<typeof prepareArtifactSchema>, "artifactId" | "contentHash">
  | Omit<z.input<typeof evidenceArtifactSchema>, "artifactId" | "contentHash">
  | Omit<z.input<typeof adjudicateArtifactSchema>, "artifactId" | "contentHash">
  | Omit<z.input<typeof reportArtifactSchema>, "artifactId" | "contentHash">;

export function createLeanStageArtifact(
  input: LeanStageArtifactBuildInput,
): LeanStageArtifact {
  const contentHash = computeLeanArtifactContentHash(input);
  const artifactId = computeLeanArtifactId({
    schemaVersion: input.schemaVersion,
    artifactVersion: input.artifactVersion,
    runId: input.runId,
    canonicalStage: input.canonicalStage,
    contentHash,
    inputArtifacts: input.inputArtifacts,
    provenance: input.provenance,
    execution: input.execution,
  });
  return leanStageArtifactSchema.parse({
    ...input,
    artifactId,
    contentHash,
  });
}

export function parseLeanStageArtifact(
  value: unknown,
): Result<LeanStageArtifact> {
  const parsed = leanStageArtifactSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") || "<root>";
  return {
    ok: false,
    error: `Invalid lean stage artifact at ${path}: ${issue?.message ?? parsed.error.message}`,
  };
}

function validateLeanArtifactIdentity(
  artifact: z.infer<typeof commonLeanArtifactEnvelopeSchema> & {
    canonicalStage: StageKey;
    payload: unknown;
  },
  context: z.RefinementCtx,
): void {
  const duplicateDecisionId = findDuplicate(
    artifact.decisions.map((decision) => decision.decisionId),
  );
  if (duplicateDecisionId) {
    context.addIssue({
      code: "custom",
      path: ["decisions"],
      message: `Duplicate append-only decision ID: ${duplicateDecisionId}`,
    });
  }

  const expectedContentHash = computeLeanArtifactContentHash(artifact);
  if (artifact.contentHash !== expectedContentHash) {
    context.addIssue({
      code: "custom",
      path: ["contentHash"],
      message: "contentHash does not match payload and decision records",
    });
  }

  const expectedArtifactId = computeLeanArtifactId(artifact);
  if (artifact.artifactId !== expectedArtifactId) {
    context.addIssue({
      code: "custom",
      path: ["artifactId"],
      message: "artifactId does not match the stable artifact identity inputs",
    });
  }
}

/**
 * The other integrity check every stage keeps: the artifact belongs to its
 * run, and it names the exact inputs it was built from, in the fixed canonical
 * order. Combined with the identity hash, that is enough to prove a chain.
 *
 * Nothing here re-derives the payload. The per-stage validators that used to
 * live beside this one re-checked decisions, provenance arrays, and embedded
 * copies against the very payload their builder had just written from — five
 * near-identical walks that could only fail if the builder were inconsistent
 * with itself, which its own tests cover.
 */
function validateStageInputLineage(
  artifact: {
    runId: string;
    inputArtifacts: readonly ArtifactReference[];
  },
  expected: {
    stageLabel: string;
    runId?: string | undefined;
    inputs: readonly ArtifactReference[];
  },
  context: z.RefinementCtx,
): void {
  if (expected.runId != null && artifact.runId !== expected.runId) {
    context.addIssue({
      code: "custom",
      path: ["payload", "lineage", "runId"],
      message: `${expected.stageLabel} run ID must match its verified input lineage`,
    });
  }
  if (
    artifact.inputArtifacts.length !== expected.inputs.length ||
    !expected.inputs.every((reference, index) =>
      sameArtifactReference(artifact.inputArtifacts[index], reference),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["inputArtifacts"],
      message: `${expected.stageLabel} must reference its exact canonical inputs in canonical order`,
    });
  }
}

function sortedArtifactReferences(
  references: readonly ArtifactReference[],
): ArtifactReference[] {
  return [...references].sort((left, right) =>
    compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
  );
}

function normalizeProvenanceForIdentity(
  provenance: LeanArtifactProvenance,
): LeanArtifactProvenance {
  return {
    ...(provenance.configuration
      ? { configuration: provenance.configuration }
      : {}),
    ...(provenance.code ? { code: provenance.code } : {}),
    prompts: [...provenance.prompts].sort((left, right) =>
      compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
    ),
    models: [...provenance.models].sort((left, right) =>
      compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
    ),
  };
}

function normalizeExecutionForIdentity(
  execution: LeanExecutionMetadata,
): LeanExecutionMetadata {
  return execution.kind === "deterministic"
    ? execution
    : {
        ...execution,
        responseArtifacts: sortedArtifactReferences(
          execution.responseArtifacts,
        ),
      };
}

function decisionContentForHash(decision: AppendOnlyDecision) {
  return {
    decisionId: decision.decisionId,
    recordId: decision.recordId,
    decisionType: decision.decisionType,
    outcome: decision.outcome,
    reason: decision.reason,
    actor: decision.actor,
    evidenceArtifacts: sortedArtifactReferences(decision.evidenceArtifacts),
    supersedesDecisionId: decision.supersedesDecisionId,
  };
}
