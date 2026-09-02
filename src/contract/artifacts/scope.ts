/**
 * Canonical Scope artifact payload: frozen family identities, seed-text
 * materialization, and verified grounding.
 */
import { z } from "zod";

import { parsedBlockKindSchema } from "../../domain/parsing.js";
import { compareCodeUnits } from "../../shared/order.js";
import { buildStableId } from "../../shared/stable-identity.js";
import {
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "../lean-artifact-primitives.js";
import { modelExecutionSchema } from "../model-execution.js";
import { seedSectionRoleSchema } from "./seed-section-role.js";
import {
  addDuplicateIdentifierIssue,
  addIssue,
  addSortedUniqueIdentifierIssue,
  hasArtifactReference,
  normalizeWhitespace,
  sameArtifactReference,
  sameIdentifierSequence,
  sortedUniqueIdentifiers,
} from "./checks.js";

export type ScopedFamilyIdentityInputs = {
  seedId: string;
  normalizedClaim: string;
};

export function buildScopedFamilyId(input: ScopedFamilyIdentityInputs): string {
  return buildStableId("family", {
    identityKind: "scoped-family-v1",
    seedId: input.seedId,
    normalizedClaim: normalizeWhitespace(input.normalizedClaim),
  });
}

export const scopeFatalFailureCodeSchema = z.enum([
  "authentication",
  "authorization",
  "billing",
  "quota",
]);
export type ScopeFatalFailureCode = z.infer<typeof scopeFatalFailureCodeSchema>;

export const scopeNonfatalFailureCodeSchema = z.enum([
  "not_found",
  "unavailable",
  "timeout",
  "rate_limited",
  "transport",
  "invalid_response",
  "provider_failure",
]);
export type ScopeNonfatalFailureCode = z.infer<
  typeof scopeNonfatalFailureCodeSchema
>;

export const scopeFailureCodeSchema = z.union([
  scopeFatalFailureCodeSchema,
  scopeNonfatalFailureCodeSchema,
]);
export type ScopeFailureCode = z.infer<typeof scopeFailureCodeSchema>;

export const scopeGroundingStatusSchema = z.enum([
  "grounded",
  "ambiguous",
  "not_found",
  "seed_text_unavailable",
  "acquisition_failed",
  "grounding_failed",
  "invalid_grounding_output",
]);
export type ScopeGroundingStatus = z.infer<typeof scopeGroundingStatusSchema>;

export const scopeSeedTextBlockSchema = z
  .object({
    blockId: z.string().min(1),
    text: z.string().min(1),
    sectionTitle: z.string().min(1).optional(),
    blockKind: parsedBlockKindSchema,
    /** Coarse role derived from block kind and section title. */
    sectionRole: seedSectionRoleSchema.optional(),
    /**
     * In-text citations the seed itself makes inside this block. A block that
     * cites other work is more likely to be summarizing prior findings than
     * reporting its own.
     */
    citationMentionCount: z.number().int().nonnegative().optional(),
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().positive(),
  })
  .strict()
  .superRefine((block, context) => {
    if (block.charOffsetEnd <= block.charOffsetStart) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Seed-text block end must be greater than its start",
      });
    }
    if (block.charOffsetEnd - block.charOffsetStart !== block.text.length) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Seed-text block offsets must exactly bound its text",
      });
    }
  });
export type ScopeSeedTextBlock = z.infer<typeof scopeSeedTextBlockSchema>;

const scopeExternalExecutionSchema = z
  .object({
    kind: z.literal("external"),
    provider: z.string().min(1),
    requestHash: sha256DigestSchema,
    requestArtifact: artifactReferenceSchema,
    responseArtifact: artifactReferenceSchema,
  })
  .strict();

const scopeDeterministicMaterializationSchema = z
  .object({
    kind: z.literal("deterministic"),
    implementation: z.string().min(1),
    sourceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict();

export const scopeSeedMaterializationSchema = z.discriminatedUnion("status", [
  z
    .object({
      seedId: stableIdentifierSchema,
      status: z.literal("materialized"),
      reason: z.string().min(1),
      seedTextArtifact: artifactReferenceSchema,
      sourceArtifacts: z.array(artifactReferenceSchema).min(1),
      parser: z
        .object({
          kind: z.string().min(1),
          version: z.string().min(1),
        })
        .strict(),
      blocks: z.array(scopeSeedTextBlockSchema).min(1),
      execution: z.union([
        scopeExternalExecutionSchema,
        scopeDeterministicMaterializationSchema,
      ]),
    })
    .strict()
    .superRefine((materialization, context) => {
      addDuplicateIdentifierIssue(
        materialization.blocks.map((block) => block.blockId),
        ["blocks"],
        context,
      );
      const sortedBlocks = [...materialization.blocks].sort(
        (left, right) =>
          left.charOffsetStart - right.charOffsetStart ||
          compareCodeUnits(left.blockId, right.blockId),
      );
      if (
        materialization.blocks.some(
          (block, index) => block !== sortedBlocks[index],
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["blocks"],
          message:
            "Seed-text blocks must be ordered by immutable source offset",
        });
      }
      for (let index = 1; index < materialization.blocks.length; index++) {
        const previous = materialization.blocks[index - 1]!;
        const current = materialization.blocks[index]!;
        if (current.charOffsetStart < previous.charOffsetEnd) {
          context.addIssue({
            code: "custom",
            path: ["blocks", index, "charOffsetStart"],
            message: "Seed-text blocks cannot overlap",
          });
        }
      }
    }),
  z
    .object({
      seedId: stableIdentifierSchema,
      status: z.literal("seed_text_unavailable"),
      reasonCode: scopeFailureCodeSchema,
      reason: z.string().min(1),
      provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
      execution: z.union([
        scopeExternalExecutionSchema,
        scopeDeterministicMaterializationSchema,
      ]),
    })
    .strict(),
  z
    .object({
      seedId: stableIdentifierSchema,
      status: z.literal("acquisition_failed"),
      reasonCode: scopeFailureCodeSchema,
      reason: z.string().min(1),
      provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
      execution: z.union([
        scopeExternalExecutionSchema,
        scopeDeterministicMaterializationSchema,
      ]),
    })
    .strict(),
]);
export type ScopeSeedMaterialization = z.infer<
  typeof scopeSeedMaterializationSchema
>;

export const scopeVerifiedEvidenceSpanSchema = z
  .object({
    text: z.string().min(1),
    blockId: z.string().min(1),
    blockKind: parsedBlockKindSchema,
    sectionTitle: z.string().min(1).optional(),
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().positive(),
    verificationStatus: z.literal("verified_exact"),
    sourceArtifact: artifactReferenceSchema,
  })
  .strict();
export type ScopeVerifiedEvidenceSpan = z.infer<
  typeof scopeVerifiedEvidenceSpanSchema
>;

const scopeQuoteVerificationSchema = z
  .object({
    status: z.enum(["verified_exact", "failed", "not_applicable"]),
    failures: z.array(
      z
        .object({
          proposedText: z.string(),
          proposedBlockId: z.string().min(1).optional(),
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const scopeGroundingSchema = z
  .object({
    status: scopeGroundingStatusSchema,
    detailReason: z.string().min(1),
    evidenceSpans: z.array(scopeVerifiedEvidenceSpanSchema),
    quoteVerification: scopeQuoteVerificationSchema,
    modelExecution: modelExecutionSchema.optional(),
    failure: z
      .object({
        code: scopeNonfatalFailureCodeSchema,
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((grounding, context) => {
    const requiresEvidence =
      grounding.status === "grounded" || grounding.status === "ambiguous";
    if (requiresEvidence && grounding.evidenceSpans.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceSpans"],
        message: `${grounding.status} grounding requires verified evidence`,
      });
    }
    if (
      (grounding.status === "seed_text_unavailable" ||
        grounding.status === "acquisition_failed" ||
        grounding.status === "grounding_failed" ||
        grounding.status === "invalid_grounding_output") &&
      grounding.evidenceSpans.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceSpans"],
        message: `${grounding.status} cannot carry accepted grounding evidence`,
      });
    }
    const isOperationallyUnavailable =
      grounding.status === "seed_text_unavailable" ||
      grounding.status === "acquisition_failed";
    if (isOperationallyUnavailable && grounding.modelExecution != null) {
      context.addIssue({
        code: "custom",
        path: ["modelExecution"],
        message: "Seed-text failure outcomes cannot claim model execution",
      });
    }
    if (!isOperationallyUnavailable && grounding.modelExecution == null) {
      context.addIssue({
        code: "custom",
        path: ["modelExecution"],
        message: `${grounding.status} requires model execution provenance`,
      });
    }
    if (grounding.status === "grounding_failed") {
      if (grounding.failure == null) {
        context.addIssue({
          code: "custom",
          path: ["failure"],
          message: "grounding_failed requires a typed provider failure",
        });
      }
    } else if (grounding.failure != null) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "Only grounding_failed can carry provider failure details",
      });
    }
    if (
      grounding.status === "not_found" &&
      (grounding.evidenceSpans.length !== 0 ||
        grounding.quoteVerification.status !== "not_applicable" ||
        grounding.quoteVerification.failures.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["quoteVerification"],
        message:
          "not_found requires zero accepted evidence and non-applicable quote verification",
      });
    }
    if (
      grounding.status === "grounding_failed" &&
      (grounding.quoteVerification.status !== "not_applicable" ||
        grounding.quoteVerification.failures.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["quoteVerification"],
        message:
          "grounding_failed cannot claim an output or quote-verification result",
      });
    }
    if (
      grounding.evidenceSpans.length > 0 &&
      grounding.quoteVerification.status !== "verified_exact"
    ) {
      context.addIssue({
        code: "custom",
        path: ["quoteVerification", "status"],
        message: "Accepted evidence requires exact quote verification",
      });
    }
    if (
      grounding.quoteVerification.status === "verified_exact" &&
      grounding.quoteVerification.failures.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["quoteVerification", "failures"],
        message: "Verified quote status cannot carry verification failures",
      });
    }
    if (
      grounding.quoteVerification.status === "failed" &&
      grounding.quoteVerification.failures.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["quoteVerification", "failures"],
        message: "Failed quote verification requires a reason",
      });
    }
  });
export type ScopeGrounding = z.infer<typeof scopeGroundingSchema>;

export const scopeCandidateDecisionSchema = z.discriminatedUnion(
  "disposition",
  [
    z
      .object({
        candidateId: stableIdentifierSchema,
        seedId: stableIdentifierSchema,
        disposition: z.literal("scoped"),
        familyId: stableIdentifierSchema,
        discoverRank: z.number().int().positive(),
        discoverReason: z.string().min(1),
        sourceClaimRecordIds: z.array(stableIdentifierSchema).min(1),
        memberMentionIds: z.array(stableIdentifierSchema).min(1),
      })
      .strict()
      .superRefine((decision, context) => {
        addSortedUniqueIdentifierIssue(
          decision.sourceClaimRecordIds,
          ["sourceClaimRecordIds"],
          context,
        );
        addSortedUniqueIdentifierIssue(
          decision.memberMentionIds,
          ["memberMentionIds"],
          context,
        );
      }),
    z
      .object({
        candidateId: stableIdentifierSchema,
        seedId: stableIdentifierSchema,
        disposition: z.literal("deferred_upstream"),
        discoverRank: z.number().int().positive(),
        discoverReason: z.string().min(1),
      })
      .strict(),
  ],
);
export type ScopeCandidateDecision = z.infer<
  typeof scopeCandidateDecisionSchema
>;

export const scopedFamilySchema = z
  .object({
    familyId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    candidateIds: z.array(stableIdentifierSchema).min(1),
    sourceClaimRecordIds: z.array(stableIdentifierSchema).min(1),
    trackedClaim: z.string().min(1),
    normalizedClaim: z.string().min(1),
    grounding: scopeGroundingSchema,
    /**
     * Each ID must reference a Discover `citationMentions` occurrence record;
     * Prepare derives its record IDs from those occurrences.
     */
    includedCitationOccurrenceIds: z.array(stableIdentifierSchema),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict()
  .superRefine((family, context) => {
    if (
      family.familyId !==
      buildScopedFamilyId({
        seedId: family.seedId,
        normalizedClaim: family.normalizedClaim,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["familyId"],
        message: "familyId does not match seed and normalized claim",
      });
    }
    addSortedUniqueIdentifierIssue(
      family.candidateIds,
      ["candidateIds"],
      context,
    );
    addSortedUniqueIdentifierIssue(
      family.sourceClaimRecordIds,
      ["sourceClaimRecordIds"],
      context,
    );
    addSortedUniqueIdentifierIssue(
      family.includedCitationOccurrenceIds,
      ["includedCitationOccurrenceIds"],
      context,
    );
  });
export type ScopedFamily = z.infer<typeof scopedFamilySchema>;

/**
 * Stage-specific Scope agents populate frozen family membership and grounding.
 * Every citation occurrence Scope sees is accounted for in the envelope's
 * append-only decisions rather than disappearing from scientific history.
 */
export const scopeArtifactPayloadSchema = z
  .object({
    discoverArtifact: artifactReferenceSchema
      .extend({
        role: z.literal("canonical-discover-input"),
        canonicalStage: z.literal("discover"),
      })
      .strict(),
    candidateDecisions: z.array(scopeCandidateDecisionSchema),
    seedMaterializations: z.array(scopeSeedMaterializationSchema),
    families: z.array(scopedFamilySchema),
  })
  .strict()
  .superRefine(validateScopePayload);
export type ScopeArtifactPayload = z.infer<typeof scopeArtifactPayloadSchema>;

function validateScopePayload(
  payload: ScopeArtifactPayload,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIdentifierIssue(
    payload.candidateDecisions.map((decision) => decision.candidateId),
    ["candidateDecisions"],
    context,
  );
  addSortedUniqueIdentifierIssue(
    payload.seedMaterializations.map(
      (materialization) => materialization.seedId,
    ),
    ["seedMaterializations"],
    context,
  );
  addSortedUniqueIdentifierIssue(
    payload.families.map((family) => family.familyId),
    ["families"],
    context,
  );

  const materializationsBySeedId = new Map(
    payload.seedMaterializations.map((materialization) => [
      materialization.seedId,
      materialization,
    ]),
  );
  const familiesById = new Map(
    payload.families.map((family) => [family.familyId, family]),
  );
  const scopedDecisions = payload.candidateDecisions.filter(
    (decision) => decision.disposition === "scoped",
  );

  for (const decision of scopedDecisions) {
    const family = familiesById.get(decision.familyId);
    if (!family) {
      addIssue(
        context,
        ["candidateDecisions"],
        `Scoped candidate references an unknown family: ${decision.familyId}`,
      );
      continue;
    }
    if (family.seedId !== decision.seedId) {
      addIssue(
        context,
        ["candidateDecisions"],
        `Scoped candidate and family belong to different seeds: ${decision.candidateId}`,
      );
    }
    if (!family.candidateIds.includes(decision.candidateId)) {
      addIssue(
        context,
        ["candidateDecisions"],
        `Scoped candidate is missing from its family: ${decision.candidateId}`,
      );
    }
  }

  const familySeedIds = new Set<string>();
  for (const family of payload.families) {
    familySeedIds.add(family.seedId);
    const familyDecisions = scopedDecisions.filter(
      (decision) => decision.familyId === family.familyId,
    );
    const expectedCandidateIds = familyDecisions
      .map((decision) => decision.candidateId)
      .sort(compareCodeUnits);
    const expectedClaimRecordIds = sortedUniqueIdentifiers(
      familyDecisions.flatMap((decision) => decision.sourceClaimRecordIds),
    );
    const expectedMentionIds = sortedUniqueIdentifiers(
      familyDecisions.flatMap((decision) => decision.memberMentionIds),
    );
    if (!sameIdentifierSequence(family.candidateIds, expectedCandidateIds)) {
      addIssue(
        context,
        ["families"],
        `Family candidate references are incomplete or dangling: ${family.familyId}`,
      );
    }
    if (
      !sameIdentifierSequence(
        family.sourceClaimRecordIds,
        expectedClaimRecordIds,
      )
    ) {
      addIssue(
        context,
        ["families"],
        `Family source claim references are incomplete or dangling: ${family.familyId}`,
      );
    }
    if (
      !sameIdentifierSequence(
        family.includedCitationOccurrenceIds,
        expectedMentionIds,
      )
    ) {
      addIssue(
        context,
        ["families"],
        `Family occurrence membership must exactly equal its Discover candidate membership: ${family.familyId}`,
      );
    }

    const materialization = materializationsBySeedId.get(family.seedId);
    if (!materialization) {
      addIssue(
        context,
        ["seedMaterializations"],
        `Family has no seed materialization outcome: ${family.familyId}`,
      );
      continue;
    }
    validateFamilyGroundingAgainstSeedText(family, materialization, context);
    if (
      !hasArtifactReference(
        family.provenanceArtifacts,
        payload.discoverArtifact,
      )
    ) {
      addIssue(
        context,
        ["families"],
        `Family does not reference the immutable Discover input: ${family.familyId}`,
      );
    }
    for (const reference of scopeMaterializationArtifactReferences(
      materialization,
    )) {
      if (!hasArtifactReference(family.provenanceArtifacts, reference)) {
        addIssue(
          context,
          ["families"],
          `Family is missing seed-materialization provenance ${reference.artifactId}: ${family.familyId}`,
        );
      }
    }
    if (family.grounding.modelExecution) {
      for (const reference of [
        family.grounding.modelExecution.requestArtifact,
        family.grounding.modelExecution.responseArtifact,
      ]) {
        if (!hasArtifactReference(family.provenanceArtifacts, reference)) {
          addIssue(
            context,
            ["families"],
            `Family is missing grounding provenance ${reference.artifactId}: ${family.familyId}`,
          );
        }
      }
    }
  }

  for (const materialization of payload.seedMaterializations) {
    if (!familySeedIds.has(materialization.seedId)) {
      addIssue(
        context,
        ["seedMaterializations"],
        `Seed materialization has no scoped family: ${materialization.seedId}`,
      );
    }
  }
}

function validateFamilyGroundingAgainstSeedText(
  family: ScopedFamily,
  materialization: ScopeSeedMaterialization,
  context: z.RefinementCtx,
): void {
  if (materialization.status === "seed_text_unavailable") {
    if (family.grounding.status !== "seed_text_unavailable") {
      addIssue(
        context,
        ["families"],
        `Grounding must preserve seed-text unavailability: ${family.familyId}`,
      );
    }
    return;
  }
  if (materialization.status === "acquisition_failed") {
    if (family.grounding.status !== "acquisition_failed") {
      addIssue(
        context,
        ["families"],
        `Grounding must preserve seed acquisition failure: ${family.familyId}`,
      );
    }
    return;
  }
  if (
    family.grounding.status === "seed_text_unavailable" ||
    family.grounding.status === "acquisition_failed"
  ) {
    addIssue(
      context,
      ["families"],
      `Materialized seed text cannot have an unavailable grounding outcome: ${family.familyId}`,
    );
    return;
  }

  const blocksById = new Map(
    materialization.blocks.map((block) => [block.blockId, block]),
  );
  for (const span of family.grounding.evidenceSpans) {
    const block = blocksById.get(span.blockId);
    if (!block) {
      addIssue(
        context,
        ["families"],
        `Grounding evidence references an unknown seed-text block: ${span.blockId}`,
      );
      continue;
    }
    const relativeStart = span.charOffsetStart - block.charOffsetStart;
    const relativeEnd = span.charOffsetEnd - block.charOffsetStart;
    const exactText = block.text.slice(relativeStart, relativeEnd);
    if (
      relativeStart < 0 ||
      relativeEnd > block.text.length ||
      relativeEnd <= relativeStart ||
      exactText !== span.text
    ) {
      addIssue(
        context,
        ["families"],
        `Grounding evidence is not an exact span of seed-text block ${span.blockId}`,
      );
    }
    if (
      span.blockKind !== block.blockKind ||
      span.sectionTitle !== block.sectionTitle
    ) {
      addIssue(
        context,
        ["families"],
        `Grounding evidence locator metadata differs from seed-text block ${span.blockId}`,
      );
    }
    if (
      !sameArtifactReference(
        span.sourceArtifact,
        materialization.seedTextArtifact,
      )
    ) {
      addIssue(
        context,
        ["families"],
        `Grounding evidence does not reference its immutable seed-text artifact: ${span.blockId}`,
      );
    }
  }
}

function scopeMaterializationArtifactReferences(
  materialization: ScopeSeedMaterialization,
): ArtifactReference[] {
  const executionArtifacts =
    materialization.execution.kind === "external"
      ? [
          materialization.execution.requestArtifact,
          materialization.execution.responseArtifact,
        ]
      : materialization.execution.sourceArtifacts;
  return materialization.status === "materialized"
    ? [
        materialization.seedTextArtifact,
        ...materialization.sourceArtifacts,
        ...executionArtifacts,
      ]
    : [...materialization.provenanceArtifacts, ...executionArtifacts];
}
