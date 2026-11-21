/**
 * Scope artifact payload: frozen family identities, seed-text
 * materialization, and verified grounding.
 */
import { z } from "zod";

import { parsedBlockKindSchema } from "../../domain/parsing.js";
import { compareCodeUnits, sortedUnique } from "../../shared/order.js";
import { buildStableId } from "../../shared/stable-identity.js";
import {
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
} from "./primitives.js";
import { modelExecutionSchema } from "../model-execution.js";
import { seedSectionRoleSchema } from "./seed-section-role.js";
import {
  scopeCitationStatementSchema,
  scopeSeedInventorySchema,
  scopeStatementAssessmentBatchSchema,
  scopeVerifiedEvidenceSpanSchema,
  type ScopeVerifiedEvidenceSpan,
} from "./scope-statements.js";
import {
  addDuplicateIdentifierIssue,
  addIssue,
  normalizeWhitespace,
  sameIdentifierSequence,
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
      grounding.evidenceSpans.length > 0 &&
      grounding.quoteVerification.status !== "verified_exact"
    ) {
      context.addIssue({
        code: "custom",
        path: ["quoteVerification", "status"],
        message: "Accepted evidence requires exact quote verification",
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
      .strict(),
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
    claim: z.string().min(1),
    normalizedClaim: z.string().min(1),
    grounding: scopeGroundingSchema,
    /**
     * Each ID must reference a Discover `citationMentions` occurrence record;
     * Prepare derives its record IDs from those occurrences.
     */
    includedCitationOccurrenceIds: z.array(stableIdentifierSchema),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict();
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
        role: z.literal("discover-input"),
        stage: z.literal("discover"),
      })
      .strict(),
    candidateDecisions: z.array(scopeCandidateDecisionSchema),
    seedMaterializations: z.array(scopeSeedMaterializationSchema),
    seedInventories: z.array(scopeSeedInventorySchema),
    citationStatements: z.array(scopeCitationStatementSchema),
    statementAssessments: z.array(scopeStatementAssessmentBatchSchema),
    families: z.array(scopedFamilySchema),
  })
  .strict()
  .superRefine(validateScopePayload);
export type ScopeArtifactPayload = z.infer<typeof scopeArtifactPayloadSchema>;

function validateScopePayload(
  payload: ScopeArtifactPayload,
  context: z.RefinementCtx,
): void {
  const materializationsBySeedId = new Map(
    payload.seedMaterializations.map((materialization) => [
      materialization.seedId,
      materialization,
    ]),
  );
  validateStatementLineage(payload, materializationsBySeedId, context);
  const decisionsByFamilyId = new Map<
    string,
    Extract<ScopeCandidateDecision, { disposition: "scoped" }>[]
  >();
  for (const decision of payload.candidateDecisions) {
    if (decision.disposition !== "scoped") continue;
    const decisions = decisionsByFamilyId.get(decision.familyId);
    if (decisions) decisions.push(decision);
    else decisionsByFamilyId.set(decision.familyId, [decision]);
  }

  for (const family of payload.families) {
    const familyDecisions = decisionsByFamilyId.get(family.familyId) ?? [];
    const expectedCandidateIds = familyDecisions
      .map((decision) => decision.candidateId)
      .sort(compareCodeUnits);
    const expectedClaimRecordIds = sortedUnique(
      familyDecisions.flatMap((decision) => decision.sourceClaimRecordIds),
    );
    const expectedMentionIds = sortedUnique(
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
    if (materialization) {
      validateSpansAgainstSeedText(
        family.grounding.evidenceSpans,
        materialization,
        ["families"],
        context,
      );
    }
  }
}

function validateStatementLineage(
  payload: ScopeArtifactPayload,
  materializationsBySeedId: Map<string, ScopeSeedMaterialization>,
  context: z.RefinementCtx,
): void {
  addDuplicateIdentifierIssue(
    payload.citationStatements.map((statement) => statement.statementId),
    ["citationStatements"],
    context,
  );
  addDuplicateIdentifierIssue(
    payload.citationStatements.map((statement) => statement.claimRecordId),
    ["citationStatements"],
    context,
  );
  addDuplicateIdentifierIssue(
    payload.statementAssessments.map((batch) => batch.batchId),
    ["statementAssessments"],
    context,
  );
  const findingIdsBySeedId = new Map<string, Set<string>>();
  for (const inventory of payload.seedInventories) {
    const materialization = materializationsBySeedId.get(inventory.seedId);
    if (
      !materialization ||
      (materialization.status === "materialized"
        ? inventory.seedTextArtifact?.artifactId !==
            materialization.seedTextArtifact.artifactId ||
          inventory.seedTextArtifact.contentHash !==
            materialization.seedTextArtifact.contentHash
        : inventory.seedTextArtifact !== undefined ||
          inventory.status !== materialization.status)
    ) {
      addIssue(
        context,
        ["seedInventories"],
        "An inventory must name its seed materialization",
      );
    }
    findingIdsBySeedId.set(
      inventory.seedId,
      new Set(inventory.findings.map((finding) => finding.findingId)),
    );
    addDuplicateIdentifierIssue(
      inventory.findings.map((finding) => finding.findingId),
      ["seedInventories"],
      context,
    );
    if (materialization) {
      validateSpansAgainstSeedText(
        inventory.findings.flatMap((finding) => finding.evidenceSpans),
        materialization,
        ["seedInventories"],
        context,
      );
    }
  }
  if (
    findingIdsBySeedId.size !== payload.seedInventories.length ||
    findingIdsBySeedId.size !== materializationsBySeedId.size
  ) {
    addIssue(
      context,
      ["seedInventories"],
      "Each seed materialization requires one inventory outcome",
    );
  }
  const batches = new Map(
    payload.statementAssessments.map((batch) => [batch.batchId, batch]),
  );
  const submitted = new Map<string, Set<string>>();
  for (const batch of payload.statementAssessments) {
    addDuplicateIdentifierIssue(
      batch.statementIds,
      ["statementAssessments"],
      context,
    );
    submitted.set(batch.batchId, new Set(batch.statementIds));
  }
  for (const statement of payload.citationStatements) {
    const findings = findingIdsBySeedId.get(statement.seedId);
    if (
      !findings ||
      statement.assessment.findingIds.some((id) => !findings.has(id))
    ) {
      addIssue(
        context,
        ["citationStatements"],
        "Statement assessment must name findings from its seed inventory",
      );
    }
    const batchId = statement.assessment.batchId;
    if (
      batchId &&
      (batches.get(batchId)?.seedId !== statement.seedId ||
        !submitted.get(batchId)?.delete(statement.statementId))
    ) {
      addIssue(
        context,
        ["citationStatements"],
        "Statement assessment must belong to its model batch",
      );
    }
  }
  if ([...submitted.values()].some((ids) => ids.size > 0)) {
    addIssue(
      context,
      ["statementAssessments"],
      "Model batches require an outcome for every statement",
    );
  }
}

function validateSpansAgainstSeedText(
  spans: readonly ScopeVerifiedEvidenceSpan[],
  materialization: ScopeSeedMaterialization,
  path: string[],
  context: z.RefinementCtx,
): void {
  if (materialization.status !== "materialized") return;
  const blocksById = new Map(
    materialization.blocks.map((block) => [block.blockId, block]),
  );
  for (const span of spans) {
    const block = blocksById.get(span.blockId);
    if (!block) {
      addIssue(
        context,
        path,
        `Seed-text evidence names missing block ${span.blockId}`,
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
      exactText !== span.text ||
      span.sourceArtifact.artifactId !==
        materialization.seedTextArtifact.artifactId ||
      span.sourceArtifact.contentHash !==
        materialization.seedTextArtifact.contentHash
    ) {
      addIssue(
        context,
        path,
        `Evidence is not an exact span of seed-text block ${span.blockId}`,
      );
    }
  }
}
