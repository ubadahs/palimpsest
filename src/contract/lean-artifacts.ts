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

export type SeedIdentityInputs = {
  doi: string;
};

export function buildSeedId(input: SeedIdentityInputs): string {
  return buildStableId("seed", {
    identityKind: "seed-v1",
    doi: normalizeDoi(input.doi),
  });
}

export type NeighborhoodQueryIdentityInputs = {
  seedId: string;
  provider: string;
  query: string;
  limit: number;
  yearRange?: {
    from?: number | undefined;
    to?: number | undefined;
  };
};

export function buildNeighborhoodQueryId(
  input: NeighborhoodQueryIdentityInputs,
): string {
  return buildStableId("neighborhood", {
    identityKind: "citing-neighborhood-v1",
    seedId: input.seedId,
    provider: normalizeWhitespace(input.provider),
    query: normalizeWhitespace(input.query),
    limit: input.limit,
    yearRange: input.yearRange,
  });
}

export type CitingPaperRecordIdentityInputs = {
  seedId: string;
  provider: string;
  providerRecordId: string;
};

export function buildCitingPaperRecordId(
  input: CitingPaperRecordIdentityInputs,
): string {
  return buildStableId("citing-paper", {
    identityKind: "citing-paper-observation-v1",
    seedId: input.seedId,
    provider: normalizeWhitespace(input.provider),
    providerRecordId: input.providerRecordId.trim(),
  });
}

export const citationSourceLocatorSchema = z
  .object({
    kind: z.enum([
      "xml_path",
      "block_id",
      "page_coordinates",
      "provider_occurrence_id",
      "other",
    ]),
    value: z.string().min(1),
  })
  .strict();
export type CitationSourceLocator = z.infer<typeof citationSourceLocatorSchema>;

export type CitationOccurrenceIdentityInputs = {
  seedId: string;
  citingPaperRecordId?: string | undefined;
  citingPaperId: string;
  citedPaperId: string;
  mentionIndex: number;
  refId?: string | undefined;
  charOffsetStart?: number | undefined;
  charOffsetEnd?: number | undefined;
  sourceLocator?: CitationSourceLocator | undefined;
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
  normalizedClaim: string;
  sourceClaimRecordIds: readonly string[];
};

export function buildClaimCandidateId(
  input: ClaimCandidateIdentityInputs,
): string {
  return buildStableId("candidate", {
    identityKind: "claim-candidate-v1",
    seedId: input.seedId,
    normalizedClaim: normalizeWhitespace(input.normalizedClaim),
    sourceClaimRecordIds: sortedUniqueIdentifiers(input.sourceClaimRecordIds),
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
    resolution: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("resolved"),
          provider: z.string().min(1),
          requestHash: sha256DigestSchema,
          requestArtifact: artifactReferenceSchema,
          responseArtifact: artifactReferenceSchema,
          paper: z
            .object({
              paperId: z.string().min(1),
              providerRecordId: z.string().min(1),
              title: z.string().min(1),
              doi: z.string().min(1).optional(),
              authors: z.array(z.string()),
              publicationYear: z.number().int().optional(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          status: z.literal("failed"),
          provider: z.string().min(1),
          reasonCode: z.string().min(1),
          reason: z.string().min(1),
          requestHash: sha256DigestSchema,
          requestArtifact: artifactReferenceSchema,
          responseArtifact: artifactReferenceSchema,
        })
        .strict(),
    ]),
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

export const discoverNeighborhoodQuerySchema = z
  .object({
    neighborhoodId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    provider: z.string().min(1),
    query: z.string().min(1),
    configuredLimit: z.number().int().nonnegative(),
    configuredYearRange: z
      .object({
        from: z.number().int().optional(),
        to: z.number().int().optional(),
      })
      .strict()
      .optional(),
    status: z.enum(["completed", "failed", "not_attempted"]),
    statusReason: z.string().min(1),
    returnedCount: z.number().int().nonnegative(),
    providerReportedTotal: z.number().int().nonnegative().optional(),
    coverage: z.enum(["complete", "truncated", "unknown"]),
    requestHash: sha256DigestSchema.optional(),
    requestArtifact: artifactReferenceSchema.optional(),
    responseArtifact: artifactReferenceSchema.optional(),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.neighborhoodId !==
      buildNeighborhoodQueryId({
        seedId: query.seedId,
        provider: query.provider,
        query: query.query,
        limit: query.configuredLimit,
        ...(query.configuredYearRange
          ? { yearRange: query.configuredYearRange }
          : {}),
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["neighborhoodId"],
        message: "neighborhoodId does not match the configured query boundary",
      });
    }
    const hasExecution =
      query.requestHash != null &&
      query.requestArtifact != null &&
      query.responseArtifact != null;
    if (query.status === "not_attempted" && hasExecution) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A not-attempted neighborhood cannot carry query execution",
      });
    }
    if (query.status !== "not_attempted" && !hasExecution) {
      context.addIssue({
        code: "custom",
        path: ["requestArtifact"],
        message:
          "An attempted neighborhood requires request/response provenance",
      });
    }
    if (query.status !== "completed" && query.returnedCount !== 0) {
      context.addIssue({
        code: "custom",
        path: ["returnedCount"],
        message: "Only completed neighborhood queries can return papers",
      });
    }
  });
export type DiscoverNeighborhoodQuery = z.infer<
  typeof discoverNeighborhoodQuerySchema
>;

const paperDispositionSchema = z
  .object({
    status: z.string().min(1),
    reason: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    provenanceArtifacts: z.array(artifactReferenceSchema),
  })
  .strict();

export const discoverCitingPaperRecordSchema = z
  .object({
    citingPaperRecordId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    neighborhoodId: stableIdentifierSchema,
    provider: z.string().min(1),
    providerRecordId: z.string().min(1),
    providerPosition: z.number().int().nonnegative(),
    paper: z
      .object({
        paperId: z.string().min(1),
        title: z.string().min(1),
        doi: z.string().min(1).optional(),
        authors: z.array(z.string()),
        publicationYear: z.number().int().optional(),
        fullTextAvailability: z.enum([
          "available",
          "abstract_only",
          "unavailable",
          "unknown",
        ]),
      })
      .strict(),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
    probe: paperDispositionSchema.extend({
      status: z.enum(["selected", "not_selected"]),
    }),
    materialization: paperDispositionSchema.extend({
      status: z.enum(["not_attempted", "succeeded", "unavailable", "failed"]),
    }),
    harvest: paperDispositionSchema.extend({
      status: z.enum(["not_attempted", "succeeded", "no_mentions", "failed"]),
      observedMentionCount: z.number().int().nonnegative(),
    }),
  })
  .strict()
  .superRefine((paper, context) => {
    if (paper.citingPaperRecordId !== buildCitingPaperRecordId(paper)) {
      context.addIssue({
        code: "custom",
        path: ["citingPaperRecordId"],
        message: "citingPaperRecordId does not match its source observation",
      });
    }
    if (
      paper.probe.status === "not_selected" &&
      (paper.materialization.status !== "not_attempted" ||
        paper.harvest.status !== "not_attempted")
    ) {
      context.addIssue({
        code: "custom",
        path: ["probe"],
        message: "An unprobed paper cannot be materialized or harvested",
      });
    }
    if (
      paper.materialization.status !== "succeeded" &&
      paper.harvest.status !== "not_attempted"
    ) {
      context.addIssue({
        code: "custom",
        path: ["harvest"],
        message: "Harvest requires successful materialization",
      });
    }
    if (
      paper.harvest.status !== "succeeded" &&
      paper.harvest.observedMentionCount !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["harvest", "observedMentionCount"],
        message: "Only successful harvests can report citation occurrences",
      });
    }
  });
export type DiscoverCitingPaperRecord = z.infer<
  typeof discoverCitingPaperRecordSchema
>;

export const discoverCitationOccurrenceSchema = z
  .object({
    mentionId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    citingPaperRecordId: stableIdentifierSchema,
    citingPaperId: z.string().min(1),
    citedPaperId: z.string().min(1),
    mentionIndex: z.number().int().nonnegative(),
    refId: z.string().min(1).optional(),
    charOffsetStart: z.number().int().nonnegative().optional(),
    charOffsetEnd: z.number().int().nonnegative().optional(),
    sourceLocator: citationSourceLocatorSchema.optional(),
    identityStrength: z.enum([
      "strong_source_offsets",
      "strong_source_locator",
      "weak_context_fallback",
    ]),
    citationMarker: z.string(),
    rawContext: z.string(),
    sectionTitle: z.string().optional(),
    seedRefLabel: z.string().optional(),
    isBundledCitation: z.boolean(),
    bundleSize: z.number().int().positive(),
    bundleRefIds: z.array(z.string().min(1)),
    bundlePattern: z.string().min(1),
    observationProvenance: z
      .object({
        sourceType: z.string().min(1),
        parser: z.string().min(1),
        parserVersion: z.string().min(1).optional(),
        artifacts: z.array(artifactReferenceSchema).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((mention, context) => {
    const hasOffsetStart = mention.charOffsetStart != null;
    const hasOffsetEnd = mention.charOffsetEnd != null;
    if (hasOffsetStart !== hasOffsetEnd) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetStart"],
        message: "Citation source offsets must be both present or both absent",
      });
    } else if (
      mention.charOffsetStart != null &&
      mention.charOffsetEnd != null &&
      mention.charOffsetEnd <= mention.charOffsetStart
    ) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Citation source offset end must be greater than start",
      });
    }
    if (mention.mentionId !== buildCitationOccurrenceId(mention)) {
      context.addIssue({
        code: "custom",
        path: ["mentionId"],
        message: "mentionId does not match the citation occurrence",
      });
    }
    if (mention.identityStrength !== citationIdentityStrength(mention)) {
      context.addIssue({
        code: "custom",
        path: ["identityStrength"],
        message:
          "identityStrength does not match the available source location",
      });
    }
    if (
      (mention.isBundledCitation && mention.bundleSize < 2) ||
      (!mention.isBundledCitation && mention.bundleSize !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["bundleSize"],
        message: "bundleSize is inconsistent with isBundledCitation",
      });
    }
    if (mention.bundleRefIds.length > mention.bundleSize) {
      context.addIssue({
        code: "custom",
        path: ["bundleRefIds"],
        message: "bundleRefIds cannot exceed the observed bundle size",
      });
    }
  });
export type DiscoverCitationOccurrence = z.infer<
  typeof discoverCitationOccurrenceSchema
>;

export type AttributedClaimRecordIdentityInputs = {
  seedId: string;
  mentionId: string;
  /** Deterministic ordinal only among records with the same normalized text. */
  duplicateOrdinal: number;
  extractedClaimText: string;
};

export function buildAttributedClaimRecordId(
  input: AttributedClaimRecordIdentityInputs,
): string {
  return buildStableId("claim-record", {
    identityKind: "attributed-claim-record-v2",
    seedId: input.seedId,
    mentionId: input.mentionId,
    normalizedClaimText: normalizeDiscoverClaimText(input.extractedClaimText),
    duplicateOrdinal: input.duplicateOrdinal,
  });
}

export function normalizeDiscoverClaimText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export type ClaimExtractionObservationIdentityInputs = {
  seedId: string;
  mentionId: string;
};

export function buildClaimExtractionObservationId(
  input: ClaimExtractionObservationIdentityInputs,
): string {
  return buildStableId("extraction", {
    identityKind: "claim-extraction-observation-v1",
    seedId: input.seedId,
    mentionId: input.mentionId,
  });
}

const discoverModelExecutionSchema = z
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

export const discoverClaimExtractionObservationSchema = z
  .object({
    extractionId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    mentionId: stableIdentifierSchema,
    status: z.enum(["claims_extracted", "no_claims", "failed"]),
    reason: z.string().min(1),
    claimRecordIds: z.array(stableIdentifierSchema),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
    execution: z.union([
      z
        .object({
          kind: z.literal("deterministic"),
          implementation: z.string().min(1),
        })
        .strict(),
      discoverModelExecutionSchema,
    ]),
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      observation.extractionId !==
      buildClaimExtractionObservationId(observation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["extractionId"],
        message: "extractionId does not match the source citation occurrence",
      });
    }
    if (
      observation.status === "claims_extracted" &&
      observation.claimRecordIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["claimRecordIds"],
        message: "claims_extracted requires at least one claim record",
      });
    }
    if (
      observation.status !== "claims_extracted" &&
      observation.claimRecordIds.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["claimRecordIds"],
        message: "Only claims_extracted observations can reference claims",
      });
    }
    addDuplicateIdentifierIssue(
      observation.claimRecordIds,
      ["claimRecordIds"],
      context,
    );
  });
export type DiscoverClaimExtractionObservation = z.infer<
  typeof discoverClaimExtractionObservationSchema
>;

export const discoverAttributedClaimRecordSchema = z
  .object({
    claimRecordId: stableIdentifierSchema,
    extractionId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    mentionId: stableIdentifierSchema,
    /** Raw model-response order; preserved as content but excluded from identity. */
    sourceClaimIndex: z.number().int().nonnegative(),
    /** Order-independent discriminator among equal normalized claim texts. */
    duplicateOrdinal: z.number().int().nonnegative(),
    extractedClaimText: z.string().min(1),
    supportSpanText: z.string().min(1).optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.claimRecordId !== buildAttributedClaimRecordId(record)) {
      context.addIssue({
        code: "custom",
        path: ["claimRecordId"],
        message:
          "claimRecordId does not match seed, mention, normalized claim, and duplicate ordinal",
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
    normalizedClaim: z.string().min(1),
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
        normalizedClaim: candidate.normalizedClaim,
        sourceClaimRecordIds: candidate.sourceClaimRecordIds,
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
    rank: z.number().int().positive(),
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
    neighborhoodQueries: z.array(discoverNeighborhoodQuerySchema),
    citingPapers: z.array(discoverCitingPaperRecordSchema),
    citationMentions: z.array(discoverCitationOccurrenceSchema),
    claimExtractionObservations: z.array(
      discoverClaimExtractionObservationSchema,
    ),
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
export type DiscoverArtifact = z.infer<typeof discoverArtifactSchema>;
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
  const uniqueCollections: Array<{
    values: string[];
    path: string;
  }> = [
    { values: payload.seeds.map((seed) => seed.seedId), path: "seeds" },
    {
      values: payload.neighborhoodQueries.map((query) => query.neighborhoodId),
      path: "neighborhoodQueries",
    },
    {
      values: payload.citingPapers.map((paper) => paper.citingPaperRecordId),
      path: "citingPapers",
    },
    {
      values: payload.citationMentions.map((mention) => mention.mentionId),
      path: "citationMentions",
    },
    {
      values: payload.claimExtractionObservations.map(
        (observation) => observation.extractionId,
      ),
      path: "claimExtractionObservations",
    },
    {
      values: payload.attributedClaimRecords.map(
        (record) => record.claimRecordId,
      ),
      path: "attributedClaimRecords",
    },
    {
      values: payload.claimCandidates.map((candidate) => candidate.candidateId),
      path: "claimCandidates",
    },
    {
      values: payload.candidateDispositions.map(
        (disposition) => disposition.candidateId,
      ),
      path: "candidateDispositions",
    },
  ];
  for (const collection of uniqueCollections) {
    addDuplicateIdentifierIssue(collection.values, [collection.path], context);
  }

  const seedsById = new Map(payload.seeds.map((seed) => [seed.seedId, seed]));
  const neighborhoodsById = new Map(
    payload.neighborhoodQueries.map((query) => [query.neighborhoodId, query]),
  );
  const citingPapersById = new Map(
    payload.citingPapers.map((paper) => [paper.citingPaperRecordId, paper]),
  );
  const mentionsById = new Map(
    payload.citationMentions.map((mention) => [mention.mentionId, mention]),
  );
  const extractionsById = new Map(
    payload.claimExtractionObservations.map((observation) => [
      observation.extractionId,
      observation,
    ]),
  );
  const claimRecordsById = new Map(
    payload.attributedClaimRecords.map((record) => [
      record.claimRecordId,
      record,
    ]),
  );
  const candidatesById = new Map(
    payload.claimCandidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  const dispositionIds = new Set(
    payload.candidateDispositions.map((disposition) => disposition.candidateId),
  );

  for (const seed of payload.seeds) {
    const queryCount = payload.neighborhoodQueries.filter(
      (query) => query.seedId === seed.seedId,
    ).length;
    if (queryCount !== 1) {
      addDiscoverLedgerIssue(
        context,
        ["neighborhoodQueries"],
        `Seed must have exactly one declared neighborhood boundary: ${seed.seedId}`,
      );
    }
  }

  payload.neighborhoodQueries.forEach((query, index) => {
    if (!seedsById.has(query.seedId)) {
      addDiscoverLedgerIssue(
        context,
        ["neighborhoodQueries", index, "seedId"],
        "Neighborhood query references an unknown seed",
      );
    }
    const returnedPapers = payload.citingPapers.filter(
      (paper) => paper.neighborhoodId === query.neighborhoodId,
    );
    if (returnedPapers.length !== query.returnedCount) {
      addDiscoverLedgerIssue(
        context,
        ["neighborhoodQueries", index, "returnedCount"],
        "Neighborhood returnedCount does not match its citing-paper ledger",
      );
    }
    const duplicatePosition = findDuplicate(
      returnedPapers.map((paper) => String(paper.providerPosition)),
    );
    if (duplicatePosition) {
      addDiscoverLedgerIssue(
        context,
        ["citingPapers"],
        `Duplicate provider position in neighborhood ${query.neighborhoodId}: ${duplicatePosition}`,
      );
    }
  });

  payload.citingPapers.forEach((paper, index) => {
    const neighborhood = neighborhoodsById.get(paper.neighborhoodId);
    if (!seedsById.has(paper.seedId)) {
      addDiscoverLedgerIssue(
        context,
        ["citingPapers", index, "seedId"],
        "Citing-paper observation references an unknown seed",
      );
    }
    if (!neighborhood) {
      addDiscoverLedgerIssue(
        context,
        ["citingPapers", index, "neighborhoodId"],
        "Citing-paper observation references an unknown neighborhood",
      );
    } else if (
      neighborhood.seedId !== paper.seedId ||
      neighborhood.provider !== paper.provider
    ) {
      addDiscoverLedgerIssue(
        context,
        ["citingPapers", index, "neighborhoodId"],
        "Citing paper and neighborhood have inconsistent seed/provider identity",
      );
    }
    const observedMentionCount = payload.citationMentions.filter(
      (mention) => mention.citingPaperRecordId === paper.citingPaperRecordId,
    ).length;
    if (observedMentionCount !== paper.harvest.observedMentionCount) {
      addDiscoverLedgerIssue(
        context,
        ["citingPapers", index, "harvest", "observedMentionCount"],
        "Harvest mention count does not match citation occurrence records",
      );
    }
    if (paper.harvest.status === "succeeded" && observedMentionCount === 0) {
      addDiscoverLedgerIssue(
        context,
        ["citingPapers", index, "harvest", "status"],
        "A successful harvest must preserve at least one occurrence",
      );
    }
  });

  payload.citationMentions.forEach((mention, index) => {
    const seed = seedsById.get(mention.seedId);
    const citingPaper = citingPapersById.get(mention.citingPaperRecordId);
    if (!seed) {
      addDiscoverLedgerIssue(
        context,
        ["citationMentions", index, "seedId"],
        "Citation occurrence references an unknown seed",
      );
    }
    if (!citingPaper) {
      addDiscoverLedgerIssue(
        context,
        ["citationMentions", index, "citingPaperRecordId"],
        "Citation occurrence references an unknown citing-paper observation",
      );
    } else if (
      citingPaper.seedId !== mention.seedId ||
      citingPaper.paper.paperId !== mention.citingPaperId
    ) {
      addDiscoverLedgerIssue(
        context,
        ["citationMentions", index, "citingPaperRecordId"],
        "Citation occurrence and citing-paper observation are inconsistent",
      );
    }
    if (
      seed?.resolution.status === "resolved" &&
      seed.resolution.paper.paperId !== mention.citedPaperId
    ) {
      addDiscoverLedgerIssue(
        context,
        ["citationMentions", index, "citedPaperId"],
        "Citation occurrence does not reference its resolved seed paper",
      );
    }
    const extractionCount = payload.claimExtractionObservations.filter(
      (observation) => observation.mentionId === mention.mentionId,
    ).length;
    if (extractionCount !== 1) {
      addDiscoverLedgerIssue(
        context,
        ["claimExtractionObservations"],
        `Citation occurrence must have exactly one extraction outcome: ${mention.mentionId}`,
      );
    }
  });

  payload.claimExtractionObservations.forEach((observation, index) => {
    const mention = mentionsById.get(observation.mentionId);
    if (!mention) {
      addDiscoverLedgerIssue(
        context,
        ["claimExtractionObservations", index, "mentionId"],
        "Extraction observation references an unknown mention",
      );
    } else if (mention.seedId !== observation.seedId) {
      addDiscoverLedgerIssue(
        context,
        ["claimExtractionObservations", index, "mentionId"],
        "Extraction observation and mention belong to different seeds",
      );
    }
    for (const claimRecordId of observation.claimRecordIds) {
      const record = claimRecordsById.get(claimRecordId);
      if (!record) {
        addDiscoverLedgerIssue(
          context,
          ["claimExtractionObservations", index, "claimRecordIds"],
          `Extraction references an unknown claim record: ${claimRecordId}`,
        );
      } else if (
        record.extractionId !== observation.extractionId ||
        record.mentionId !== observation.mentionId ||
        record.seedId !== observation.seedId
      ) {
        addDiscoverLedgerIssue(
          context,
          ["claimExtractionObservations", index, "claimRecordIds"],
          `Extraction and claim record are inconsistent: ${claimRecordId}`,
        );
      }
    }
  });

  const claimRecordsByExtraction = new Map<
    string,
    DiscoverAttributedClaimRecord[]
  >();
  payload.attributedClaimRecords.forEach((record, index) => {
    const mention = mentionsById.get(record.mentionId);
    const extraction = extractionsById.get(record.extractionId);
    const extractionRecords =
      claimRecordsByExtraction.get(record.extractionId) ?? [];
    extractionRecords.push(record);
    claimRecordsByExtraction.set(record.extractionId, extractionRecords);
    if (!mention) {
      addDiscoverLedgerIssue(
        context,
        ["attributedClaimRecords", index, "mentionId"],
        "Attributed claim record references an unknown mention",
      );
    } else if (mention.seedId !== record.seedId) {
      addDiscoverLedgerIssue(
        context,
        ["attributedClaimRecords", index, "mentionId"],
        "Attributed claim record and mention belong to different seeds",
      );
    }
    if (!extraction?.claimRecordIds.includes(record.claimRecordId)) {
      addDiscoverLedgerIssue(
        context,
        ["attributedClaimRecords", index, "extractionId"],
        "Attributed claim record is not owned by its extraction observation",
      );
    }
  });
  for (const [extractionId, records] of claimRecordsByExtraction) {
    const sourceIndexes = records
      .map((record) => record.sourceClaimIndex)
      .sort((left, right) => left - right);
    if (sourceIndexes.some((sourceIndex, index) => sourceIndex !== index)) {
      addDiscoverLedgerIssue(
        context,
        ["attributedClaimRecords"],
        `Source claim indexes must be unique and contiguous within extraction: ${extractionId}`,
      );
    }

    const recordsByNormalizedClaim = new Map<
      string,
      DiscoverAttributedClaimRecord[]
    >();
    for (const record of records) {
      const normalizedClaim = normalizeDiscoverClaimText(
        record.extractedClaimText,
      );
      const duplicateGroup =
        recordsByNormalizedClaim.get(normalizedClaim) ?? [];
      duplicateGroup.push(record);
      recordsByNormalizedClaim.set(normalizedClaim, duplicateGroup);
    }
    for (const [normalizedClaim, duplicateGroup] of recordsByNormalizedClaim) {
      const ordinals = duplicateGroup
        .map((record) => record.duplicateOrdinal)
        .sort((left, right) => left - right);
      if (ordinals.some((ordinal, index) => ordinal !== index)) {
        addDiscoverLedgerIssue(
          context,
          ["attributedClaimRecords"],
          `Duplicate ordinals must be unique and contiguous for extraction ${extractionId} and claim ${normalizedClaim}`,
        );
      }
    }
  }

  const claimCandidateMembershipCount = new Map<string, number>();
  payload.claimCandidates.forEach((candidate, index) => {
    if (!seedsById.has(candidate.seedId)) {
      addDiscoverLedgerIssue(
        context,
        ["claimCandidates", index, "seedId"],
        "Claim candidate references an unknown seed",
      );
    }
    const expectedMentionIds = new Set<string>();
    for (const claimRecordId of candidate.sourceClaimRecordIds) {
      const claimRecord = claimRecordsById.get(claimRecordId);
      claimCandidateMembershipCount.set(
        claimRecordId,
        (claimCandidateMembershipCount.get(claimRecordId) ?? 0) + 1,
      );
      if (!claimRecord) {
        addDiscoverLedgerIssue(
          context,
          ["claimCandidates", index, "sourceClaimRecordIds"],
          `Claim candidate references unknown attributed claim record: ${claimRecordId}`,
        );
      } else if (claimRecord.seedId !== candidate.seedId) {
        addDiscoverLedgerIssue(
          context,
          ["claimCandidates", index, "sourceClaimRecordIds"],
          `Claim candidate source record belongs to another seed: ${claimRecordId}`,
        );
      } else {
        expectedMentionIds.add(claimRecord.mentionId);
      }
    }
    const actualMentionIds = new Set(candidate.memberMentionIds);
    if (
      expectedMentionIds.size !== actualMentionIds.size ||
      [...expectedMentionIds].some(
        (mentionId) => !actualMentionIds.has(mentionId),
      )
    ) {
      addDiscoverLedgerIssue(
        context,
        ["claimCandidates", index, "memberMentionIds"],
        "Candidate mention membership must exactly cover its source claim records",
      );
    }
    for (const mentionId of candidate.memberMentionIds) {
      const mention = mentionsById.get(mentionId);
      if (!mention) {
        addDiscoverLedgerIssue(
          context,
          ["claimCandidates", index, "memberMentionIds"],
          `Claim candidate references unknown mention: ${mentionId}`,
        );
      } else if (mention.seedId !== candidate.seedId) {
        addDiscoverLedgerIssue(
          context,
          ["claimCandidates", index, "memberMentionIds"],
          `Claim candidate mention belongs to another seed: ${mentionId}`,
        );
      }
    }
    if (!dispositionIds.has(candidate.candidateId)) {
      addDiscoverLedgerIssue(
        context,
        ["candidateDispositions"],
        `Missing disposition for candidate: ${candidate.candidateId}`,
      );
    }
  });

  for (const record of payload.attributedClaimRecords) {
    if (claimCandidateMembershipCount.get(record.claimRecordId) !== 1) {
      addDiscoverLedgerIssue(
        context,
        ["claimCandidates"],
        `Attributed claim record must belong to exactly one candidate: ${record.claimRecordId}`,
      );
    }
  }

  const ranksBySeed = new Map<string, number[]>();
  payload.candidateDispositions.forEach((disposition, index) => {
    const candidate = candidatesById.get(disposition.candidateId);
    if (!candidate) {
      addDiscoverLedgerIssue(
        context,
        ["candidateDispositions", index, "candidateId"],
        "Disposition references an unknown claim candidate",
      );
      return;
    }
    const ranks = ranksBySeed.get(candidate.seedId) ?? [];
    ranks.push(disposition.rank);
    ranksBySeed.set(candidate.seedId, ranks);
  });
  for (const [seedId, ranks] of ranksBySeed) {
    const sortedRanks = [...ranks].sort((left, right) => left - right);
    if (sortedRanks.some((rank, index) => rank !== index + 1)) {
      addDiscoverLedgerIssue(
        context,
        ["candidateDispositions"],
        `Candidate ranks must be unique and contiguous within seed: ${seedId}`,
      );
    }
  }
}

function addDiscoverLedgerIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
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
  sourceLocator?: CitationSourceLocator | undefined;
  citationMarker: string;
  rawContext: string;
}) {
  if (input.charOffsetStart != null && input.charOffsetEnd != null) {
    return {
      kind: "char_offsets",
      start: input.charOffsetStart,
      end: input.charOffsetEnd,
    };
  }
  if (input.sourceLocator) {
    return {
      kind: "source_locator",
      locator: input.sourceLocator,
    };
  }
  return {
    kind: "mention_fallback",
    mentionIndex: input.mentionIndex,
    citationMarker: normalizeWhitespace(input.citationMarker),
    rawContext: normalizeWhitespace(input.rawContext),
  };
}

function citationIdentityStrength(input: {
  charOffsetStart?: number | undefined;
  charOffsetEnd?: number | undefined;
  sourceLocator?: CitationSourceLocator | undefined;
}):
  | "strong_source_offsets"
  | "strong_source_locator"
  | "weak_context_fallback" {
  if (input.charOffsetStart != null && input.charOffsetEnd != null) {
    return "strong_source_offsets";
  }
  return input.sourceLocator
    ? "strong_source_locator"
    : "weak_context_fallback";
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
