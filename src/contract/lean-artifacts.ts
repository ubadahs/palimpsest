import { z } from "zod";

import {
  adjudicationVerdictSchema,
  claimGroundingStatusSchema,
  citationMentionSchema,
  citationRoleSchema,
  confidenceSchema,
  evaluationModeSchema,
  evidenceSpanSchema,
  retrievalQualitySchema,
  seedClaimSupportSpanSchema,
  taskEvidenceRetrievalStatusSchema,
  transmissionModifiersSchema,
} from "../domain/types.js";
import type { Result } from "../domain/types.js";
import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../shared/stable-identity.js";
import {
  canonicalStageKeySchema,
  type CanonicalStageKey,
} from "./lean-stages.js";

export const leanArtifactSchemaVersion = 1 as const;
export const leanArtifactVersion = 1 as const;

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
    canonicalStage: canonicalStageKeySchema.optional(),
    uri: z.string().min(1).optional(),
  })
  .strict();
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

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

const exclusionIdentitySchema = z
  .object({
    recordId: stableIdentifierSchema,
    reasonCode: z.string().min(1),
    reason: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
    actor: decisionActorSchema,
    evidenceArtifacts: z.array(artifactReferenceSchema),
    decisionId: stableIdentifierSchema.optional(),
    supersedesExclusionId: stableIdentifierSchema.optional(),
  })
  .strict();
export type AppendOnlyExclusionInput = z.infer<typeof exclusionIdentitySchema>;

export function buildExclusionId(
  input: AppendOnlyExclusionInput & { exclusionId?: string },
): string {
  return buildStableId("exclusion", {
    recordId: input.recordId,
    reasonCode: input.reasonCode,
    reason: input.reason,
    actor: input.actor,
    evidenceArtifacts: sortedArtifactReferences(input.evidenceArtifacts),
    decisionId: input.decisionId,
    supersedesExclusionId: input.supersedesExclusionId,
  });
}

export const appendOnlyExclusionSchema = exclusionIdentitySchema
  .extend({
    exclusionId: stableIdentifierSchema,
  })
  .strict()
  .superRefine((exclusion, context) => {
    if (exclusion.exclusionId !== buildExclusionId(exclusion)) {
      context.addIssue({
        code: "custom",
        path: ["exclusionId"],
        message: "exclusionId does not match the exclusion identity inputs",
      });
    }
  });
export type AppendOnlyExclusion = z.infer<typeof appendOnlyExclusionSchema>;

export function createAppendOnlyExclusion(
  input: AppendOnlyExclusionInput,
): AppendOnlyExclusion {
  return appendOnlyExclusionSchema.parse({
    ...input,
    exclusionId: buildExclusionId(input),
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

export type SeedIdentityInputs = {
  doi: string;
};

export function buildSeedId(input: SeedIdentityInputs): string {
  return buildStableId("seed", {
    identityKind: "seed-v1",
    doi: normalizeDoi(input.doi),
  });
}

export type CitationOccurrenceIdentityInputs = {
  seedId: string;
  citingPaperId: string;
  citedPaperId: string;
  mentionIndex: number;
  refId?: string | undefined;
  charOffsetStart?: number | undefined;
  charOffsetEnd?: number | undefined;
  citationMarker: string;
  rawContext: string;
};

/**
 * Occurrence identity excludes parser and source-format implementation data.
 * Complete source offsets are preferred. Without them, normalized marker and
 * context plus mention index form a weaker fallback that can change if context
 * windows or mention ordering change.
 */
export function buildCitationOccurrenceId(
  input: CitationOccurrenceIdentityInputs,
): string {
  return buildStableId("mention", {
    identityKind: "citation-occurrence-v1",
    seedId: input.seedId,
    citingPaperId: input.citingPaperId.trim(),
    citedPaperId: input.citedPaperId.trim(),
    refId: input.refId,
    sourceLocation: buildCitationSourceLocation(input),
  });
}

export type ClaimCandidateIdentityInputs = {
  seedId: string;
  canonicalClaim: string;
  memberMentionIds: readonly string[];
};

export function buildClaimCandidateId(
  input: ClaimCandidateIdentityInputs,
): string {
  return buildStableId("candidate", {
    identityKind: "claim-candidate-v1",
    seedId: input.seedId,
    canonicalClaim: normalizeWhitespace(input.canonicalClaim),
    memberMentionIds: sortedUniqueIdentifiers(input.memberMentionIds),
  });
}

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

export const discoverSeedSchema = z
  .object({
    seedId: stableIdentifierSchema,
    doi: z.string().min(1),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict()
  .superRefine((seed, context) => {
    if (seed.seedId !== buildSeedId(seed)) {
      context.addIssue({
        code: "custom",
        path: ["seedId"],
        message: "seedId does not match the normalized seed DOI",
      });
    }
  });
export type DiscoverSeed = z.infer<typeof discoverSeedSchema>;

export const discoverCitationOccurrenceSchema = z
  .object({
    mentionId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    citingPaperId: z.string().min(1),
    citedPaperId: z.string().min(1),
    mentionIndex: z.number().int().nonnegative(),
    refId: z.string().min(1).optional(),
    charOffsetStart: z.number().int().nonnegative().optional(),
    charOffsetEnd: z.number().int().nonnegative().optional(),
    citationMarker: z.string(),
    rawContext: z.string(),
    observationProvenance: z
      .object({
        sourceType: z.string().min(1),
        parser: z.string().min(1),
        artifacts: z.array(artifactReferenceSchema).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((mention, context) => {
    if (mention.mentionId !== buildCitationOccurrenceId(mention)) {
      context.addIssue({
        code: "custom",
        path: ["mentionId"],
        message: "mentionId does not match the citation occurrence",
      });
    }
  });
export type DiscoverCitationOccurrence = z.infer<
  typeof discoverCitationOccurrenceSchema
>;

export type AttributedClaimRecordIdentityInputs = {
  seedId: string;
  mentionId: string;
  extractedClaimText: string;
};

export function buildAttributedClaimRecordId(
  input: AttributedClaimRecordIdentityInputs,
): string {
  return buildStableId("claim-record", {
    identityKind: "attributed-claim-record-v1",
    seedId: input.seedId,
    mentionId: input.mentionId,
    extractedClaimText: normalizeWhitespace(input.extractedClaimText),
  });
}

export const discoverAttributedClaimRecordSchema = z
  .object({
    claimRecordId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    mentionId: stableIdentifierSchema,
    extractedClaimText: z.string().min(1),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.claimRecordId !== buildAttributedClaimRecordId(record)) {
      context.addIssue({
        code: "custom",
        path: ["claimRecordId"],
        message:
          "claimRecordId does not match seed, mention, and extracted claim",
      });
    }
  });
export type DiscoverAttributedClaimRecord = z.infer<
  typeof discoverAttributedClaimRecordSchema
>;

export const discoverClaimCandidateSchema = z
  .object({
    candidateId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    canonicalClaim: z.string().min(1),
    memberMentionIds: z.array(stableIdentifierSchema).min(1),
    sourceClaimRecordIds: z.array(stableIdentifierSchema).min(1),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      candidate.candidateId !==
      buildClaimCandidateId({
        seedId: candidate.seedId,
        canonicalClaim: candidate.canonicalClaim,
        memberMentionIds: candidate.memberMentionIds,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidateId"],
        message: "candidateId does not match claim text and membership",
      });
    }
    addDuplicateIdentifierIssue(
      candidate.memberMentionIds,
      ["memberMentionIds"],
      context,
    );
    addDuplicateIdentifierIssue(
      candidate.sourceClaimRecordIds,
      ["sourceClaimRecordIds"],
      context,
    );
  });
export type DiscoverClaimCandidate = z.infer<
  typeof discoverClaimCandidateSchema
>;

export const discoverCandidateDispositionSchema = z
  .object({
    candidateId: stableIdentifierSchema,
    selectedForScope: z.boolean(),
    rank: z.number().int().positive().optional(),
    reason: z.string().min(1),
  })
  .strict();

/**
 * Stage-specific Discover agents will populate this lossless ledger. Selection
 * annotates the complete candidate set; it never removes seeds, mentions, claim
 * candidates, membership, or provenance references.
 */
export const discoverArtifactPayloadSchema = z
  .object({
    seeds: z.array(discoverSeedSchema).min(1),
    citationMentions: z.array(discoverCitationOccurrenceSchema),
    attributedClaimRecords: z.array(discoverAttributedClaimRecordSchema),
    claimCandidates: z.array(discoverClaimCandidateSchema),
    candidateDispositions: z.array(discoverCandidateDispositionSchema),
  })
  .strict()
  .superRefine(validateDiscoverLedger);
export type DiscoverArtifactPayload = z.infer<
  typeof discoverArtifactPayloadSchema
>;

export const scopedFamilySchema = z
  .object({
    familyId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    candidateIds: z.array(stableIdentifierSchema).min(1),
    trackedClaim: z.string().min(1),
    normalizedClaim: z.string().min(1),
    grounding: z
      .object({
        status: claimGroundingStatusSchema,
        evidenceSpans: z.array(seedClaimSupportSpanSchema),
        detailReason: z.string().min(1),
      })
      .strict(),
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
    addDuplicateIdentifierIssue(family.candidateIds, ["candidateIds"], context);
    addDuplicateIdentifierIssue(
      family.includedCitationOccurrenceIds,
      ["includedCitationOccurrenceIds"],
      context,
    );
  });
export type ScopedFamily = z.infer<typeof scopedFamilySchema>;

/**
 * Stage-specific Scope agents will populate frozen family membership and
 * grounding. Excluded citation occurrences remain in the envelope's append-only
 * decisions and exclusions rather than disappearing from scientific history.
 */
export const scopeArtifactPayloadSchema = z
  .object({
    families: z.array(scopedFamilySchema),
  })
  .strict()
  .superRefine((payload, context) => {
    addDuplicateIdentifierIssue(
      payload.families.map((family) => family.familyId),
      ["families"],
      context,
    );
  });
export type ScopeArtifactPayload = z.infer<typeof scopeArtifactPayloadSchema>;

const preparedPaperIdentitySchema = z
  .object({
    paperId: z.string().min(1),
    title: z.string().min(1),
    doi: z.string().min(1).optional(),
  })
  .strict();

export type CitationInstanceIdentityInputs = Omit<
  CitationOccurrenceIdentityInputs,
  "seedId"
> & {
  seedDoi: string;
};

/**
 * Prepared-record identity is derived from the Discover occurrence, remaining
 * independent of classification and observation implementation metadata.
 */
export function buildCitationInstanceRecordId(
  input: CitationInstanceIdentityInputs,
): string {
  const citationOccurrenceId = buildCitationOccurrenceId({
    ...input,
    seedId: buildSeedId({ doi: input.seedDoi }),
  });
  return buildStableId("record", {
    identityKind: "prepared-citation-instance-v1",
    citationOccurrenceId,
  });
}

const preparedSeedIdentitySchema = z
  .object({
    seedId: stableIdentifierSchema,
    doi: z.string().min(1),
    trackedClaim: z.string().min(1),
  })
  .strict()
  .superRefine((seed, context) => {
    if (seed.seedId !== buildSeedId(seed)) {
      context.addIssue({
        code: "custom",
        path: ["seedId"],
        message: "seedId does not match the normalized seed DOI",
      });
    }
  });

export const preparedCitationInstanceSchema = z
  .object({
    recordId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    seed: preparedSeedIdentitySchema,
    citingPaper: preparedPaperIdentitySchema,
    citedPaper: preparedPaperIdentitySchema,
    mention: citationMentionSchema.extend({
      mentionIndex: z.number().int().nonnegative(),
      rawContext: z.string(),
      refId: z.string().optional(),
      charOffsetStart: z.number().int().nonnegative().optional(),
      charOffsetEnd: z.number().int().nonnegative().optional(),
      sourceType: z.enum(["jats_xml", "grobid_tei", "pdf_text"]),
      parser: z.string().min(1),
    }),
    classification: z
      .object({
        citationRole: citationRoleSchema,
        evaluationMode: evaluationModeSchema,
        modifiers: transmissionModifiersSchema,
        signals: z.array(z.string()),
      })
      .strict(),
  })
  .strict()
  .superRefine((record, context) => {
    const identityInputs: CitationInstanceIdentityInputs = {
      seedDoi: record.seed.doi,
      citingPaperId: record.citingPaper.paperId,
      citedPaperId: record.citedPaper.paperId,
      mentionIndex: record.mention.mentionIndex,
      refId: record.mention.refId,
      charOffsetStart: record.mention.charOffsetStart,
      charOffsetEnd: record.mention.charOffsetEnd,
      citationMarker: record.mention.citationMarker,
      rawContext: record.mention.rawContext,
    };
    const expectedOccurrenceId = buildCitationOccurrenceId({
      ...identityInputs,
      seedId: record.seed.seedId,
    });
    if (record.citationOccurrenceId !== expectedOccurrenceId) {
      context.addIssue({
        code: "custom",
        path: ["citationOccurrenceId"],
        message:
          "citationOccurrenceId does not match the source citation occurrence",
      });
    }
    const expectedId = buildCitationInstanceRecordId(identityInputs);
    if (record.recordId !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["recordId"],
        message:
          "recordId does not match the citation-instance identity inputs",
      });
    }
  });
export type PreparedCitationInstance = z.infer<
  typeof preparedCitationInstanceSchema
>;

export const prepareArtifactPayloadSchema = z
  .object({
    records: z.array(preparedCitationInstanceSchema),
  })
  .strict();
export type PrepareArtifactPayload = z.infer<
  typeof prepareArtifactPayloadSchema
>;

export const evidenceArtifactPayloadSchema = z
  .object({
    records: z.array(
      z
        .object({
          recordId: stableIdentifierSchema,
          evidenceRetrievalStatus: taskEvidenceRetrievalStatusSchema,
          evidenceSpans: z.array(evidenceSpanSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type EvidenceArtifactPayload = z.infer<
  typeof evidenceArtifactPayloadSchema
>;

export const adjudicateArtifactPayloadSchema = z
  .object({
    records: z.array(
      z
        .object({
          recordId: stableIdentifierSchema,
          verdict: adjudicationVerdictSchema,
          comparison: z.string().min(1),
          rationale: z.string().min(1),
          retrievalQuality: retrievalQualitySchema,
          judgeConfidence: confidenceSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type AdjudicateArtifactPayload = z.infer<
  typeof adjudicateArtifactPayloadSchema
>;

export const reportArtifactPayloadSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    recordIds: z.array(stableIdentifierSchema),
    verdictCounts: z.partialRecord(
      adjudicationVerdictSchema,
      z.number().int().nonnegative(),
    ),
    metrics: z.record(
      z.string().min(1),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
    markdown: z.string(),
  })
  .strict();
export type ReportArtifactPayload = z.infer<typeof reportArtifactPayloadSchema>;

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
    exclusions: z.array(appendOnlyExclusionSchema),
  })
  .strict();

export const discoverArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("discover"),
    payload: discoverArtifactPayloadSchema,
  })
  .strict()
  .superRefine(validateLeanArtifactIdentity);
export const scopeArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("scope"),
    payload: scopeArtifactPayloadSchema,
  })
  .strict()
  .superRefine(validateLeanArtifactIdentity);
export const prepareArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("prepare"),
    payload: prepareArtifactPayloadSchema,
  })
  .strict()
  .superRefine(validateLeanArtifactIdentity);
export const evidenceArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("evidence"),
    payload: evidenceArtifactPayloadSchema,
  })
  .strict()
  .superRefine(validateLeanArtifactIdentity);
export const adjudicateArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("adjudicate"),
    payload: adjudicateArtifactPayloadSchema,
  })
  .strict()
  .superRefine(validateLeanArtifactIdentity);
export const reportArtifactSchema = commonLeanArtifactEnvelopeSchema
  .extend({
    canonicalStage: z.literal("report"),
    payload: reportArtifactPayloadSchema,
  })
  .strict()
  .superRefine(validateLeanArtifactIdentity);

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
 * creation time and decision/exclusion recording times are observational and
 * deliberately excluded; their stable IDs still bind every substantive field.
 */
export function computeLeanArtifactContentHash(input: {
  payload: unknown;
  decisions: readonly AppendOnlyDecision[];
  exclusions: readonly AppendOnlyExclusion[];
}): string {
  return canonicalSha256({
    contentVersion: 1,
    payload: input.payload,
    decisions: input.decisions.map(decisionContentForHash),
    exclusions: input.exclusions.map(exclusionContentForHash),
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
    canonicalStage: CanonicalStageKey;
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

  const duplicateExclusionId = findDuplicate(
    artifact.exclusions.map((exclusion) => exclusion.exclusionId),
  );
  if (duplicateExclusionId) {
    context.addIssue({
      code: "custom",
      path: ["exclusions"],
      message: `Duplicate append-only exclusion ID: ${duplicateExclusionId}`,
    });
  }

  const expectedContentHash = computeLeanArtifactContentHash(artifact);
  if (artifact.contentHash !== expectedContentHash) {
    context.addIssue({
      code: "custom",
      path: ["contentHash"],
      message:
        "contentHash does not match payload and decision/exclusion records",
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

function validateDiscoverLedger(
  payload: DiscoverArtifactPayload,
  context: z.RefinementCtx,
): void {
  addDuplicateIdentifierIssue(
    payload.seeds.map((seed) => seed.seedId),
    ["seeds"],
    context,
  );
  addDuplicateIdentifierIssue(
    payload.citationMentions.map((mention) => mention.mentionId),
    ["citationMentions"],
    context,
  );
  addDuplicateIdentifierIssue(
    payload.attributedClaimRecords.map((record) => record.claimRecordId),
    ["attributedClaimRecords"],
    context,
  );
  addDuplicateIdentifierIssue(
    payload.claimCandidates.map((candidate) => candidate.candidateId),
    ["claimCandidates"],
    context,
  );
  addDuplicateIdentifierIssue(
    payload.candidateDispositions.map((disposition) => disposition.candidateId),
    ["candidateDispositions"],
    context,
  );

  const seedIds = new Set(payload.seeds.map((seed) => seed.seedId));
  const mentionsById = new Map(
    payload.citationMentions.map((mention) => [mention.mentionId, mention]),
  );
  const claimRecordsById = new Map(
    payload.attributedClaimRecords.map((record) => [
      record.claimRecordId,
      record,
    ]),
  );
  const candidateIds = new Set(
    payload.claimCandidates.map((candidate) => candidate.candidateId),
  );
  const dispositionIds = new Set(
    payload.candidateDispositions.map((disposition) => disposition.candidateId),
  );

  payload.citationMentions.forEach((mention, index) => {
    if (!seedIds.has(mention.seedId)) {
      context.addIssue({
        code: "custom",
        path: ["citationMentions", index, "seedId"],
        message: "Citation occurrence references an unknown seed",
      });
    }
  });

  payload.attributedClaimRecords.forEach((record, index) => {
    const mention = mentionsById.get(record.mentionId);
    if (!seedIds.has(record.seedId)) {
      context.addIssue({
        code: "custom",
        path: ["attributedClaimRecords", index, "seedId"],
        message: "Attributed claim record references an unknown seed",
      });
    }
    if (!mention) {
      context.addIssue({
        code: "custom",
        path: ["attributedClaimRecords", index, "mentionId"],
        message: "Attributed claim record references an unknown mention",
      });
    } else if (mention.seedId !== record.seedId) {
      context.addIssue({
        code: "custom",
        path: ["attributedClaimRecords", index, "mentionId"],
        message:
          "Attributed claim record and mention belong to different seeds",
      });
    }
  });

  payload.claimCandidates.forEach((candidate, index) => {
    if (!seedIds.has(candidate.seedId)) {
      context.addIssue({
        code: "custom",
        path: ["claimCandidates", index, "seedId"],
        message: "Claim candidate references an unknown seed",
      });
    }
    for (const mentionId of candidate.memberMentionIds) {
      const mention = mentionsById.get(mentionId);
      if (!mention) {
        context.addIssue({
          code: "custom",
          path: ["claimCandidates", index, "memberMentionIds"],
          message: `Claim candidate references unknown mention: ${mentionId}`,
        });
      } else if (mention.seedId !== candidate.seedId) {
        context.addIssue({
          code: "custom",
          path: ["claimCandidates", index, "memberMentionIds"],
          message: `Claim candidate mention belongs to another seed: ${mentionId}`,
        });
      }
    }
    for (const claimRecordId of candidate.sourceClaimRecordIds) {
      const claimRecord = claimRecordsById.get(claimRecordId);
      if (!claimRecord) {
        context.addIssue({
          code: "custom",
          path: ["claimCandidates", index, "sourceClaimRecordIds"],
          message: `Claim candidate references unknown attributed claim record: ${claimRecordId}`,
        });
      } else if (claimRecord.seedId !== candidate.seedId) {
        context.addIssue({
          code: "custom",
          path: ["claimCandidates", index, "sourceClaimRecordIds"],
          message: `Claim candidate source record belongs to another seed: ${claimRecordId}`,
        });
      } else if (!candidate.memberMentionIds.includes(claimRecord.mentionId)) {
        context.addIssue({
          code: "custom",
          path: ["claimCandidates", index, "sourceClaimRecordIds"],
          message: `Claim candidate source record belongs to a non-member mention: ${claimRecordId}`,
        });
      }
    }
    if (!dispositionIds.has(candidate.candidateId)) {
      context.addIssue({
        code: "custom",
        path: ["candidateDispositions"],
        message: `Missing disposition for candidate: ${candidate.candidateId}`,
      });
    }
  });

  payload.candidateDispositions.forEach((disposition, index) => {
    if (!candidateIds.has(disposition.candidateId)) {
      context.addIssue({
        code: "custom",
        path: ["candidateDispositions", index, "candidateId"],
        message: "Disposition references an unknown claim candidate",
      });
    }
  });
}

function addDuplicateIdentifierIssue(
  values: readonly string[],
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  const duplicate = findDuplicate(values);
  if (duplicate) {
    context.addIssue({
      code: "custom",
      path,
      message: `Duplicate stable identifier: ${duplicate}`,
    });
  }
}

function buildCitationSourceLocation(input: {
  mentionIndex: number;
  charOffsetStart?: number | undefined;
  charOffsetEnd?: number | undefined;
  citationMarker: string;
  rawContext: string;
}) {
  return input.charOffsetStart != null && input.charOffsetEnd != null
    ? {
        kind: "char_offsets",
        start: input.charOffsetStart,
        end: input.charOffsetEnd,
      }
    : {
        kind: "mention_fallback",
        mentionIndex: input.mentionIndex,
        citationMarker: normalizeWhitespace(input.citationMarker),
        rawContext: normalizeWhitespace(input.rawContext),
      };
}

function sortedUniqueIdentifiers(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

function normalizeDoi(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//, "");
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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

function exclusionContentForHash(exclusion: AppendOnlyExclusion) {
  return {
    exclusionId: exclusion.exclusionId,
    recordId: exclusion.recordId,
    reasonCode: exclusion.reasonCode,
    reason: exclusion.reason,
    actor: exclusion.actor,
    evidenceArtifacts: sortedArtifactReferences(exclusion.evidenceArtifacts),
    decisionId: exclusion.decisionId,
    supersedesExclusionId: exclusion.supersedesExclusionId,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
