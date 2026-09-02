import { z } from "zod";

import {
  confidenceSchema,
  evaluationModeSchema,
  type CitationRole,
} from "../domain/classification.js";
import { paperTypeSchema, type Result } from "../domain/common.js";
import { parsedBlockKindSchema } from "../domain/parsing.js";
import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../shared/stable-identity.js";
import {
  adjudicateArtifactPayloadSchema,
  validateAdjudicateArtifactLineage,
} from "./canonical-adjudicate.js";
import {
  evidenceRerankStatusSchema,
  evidenceRetrievalStatusSchema,
} from "./canonical-evidence-statuses.js";
import {
  reportArtifactPayloadSchema,
  validateReportArtifactLineage,
} from "./canonical-report.js";
import {
  artifactReferenceSchema,
  leanArtifactIdSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "./lean-artifact-primitives.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "./model-execution.js";
import type { CanonicalStageKey } from "./lean-stages.js";

export {
  artifactReferenceSchema,
  leanArtifactIdSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "./lean-artifact-primitives.js";
export {
  adjudicateArtifactPayloadSchema,
  adjudicateFailureCodeSchema,
  adjudicateFatalFailureCodeSchema,
  adjudicateGateCodeSchema,
  adjudicateLineageSchema,
  adjudicateNonfatalFailureCodeSchema,
  adjudicateRecordOutcomeSchema,
  buildAdjudicationResultId,
  canonicalAdjudicateMethod,
  canonicalAdjudicateMethodId,
  canonicalAdjudicateMethodSchema,
  canonicalAdjudicateModelOutputSchema,
  hashCanonicalAdjudicatePrompt,
  hashCanonicalAdjudicateRequest,
  type AdjudicateArtifactPayload,
  type AdjudicateFailureCode,
  type AdjudicateFatalFailureCode,
  type AdjudicateGateCode,
  type AdjudicateLineage,
  type AdjudicateNonfatalFailureCode,
  type AdjudicateRecordOutcome,
  type CanonicalAdjudicateMethod,
  type CanonicalAdjudicateModelOutput,
} from "./canonical-adjudicate.js";
export {
  evidenceRerankStatusSchema,
  evidenceRetrievalStatusSchema,
  type EvidenceRerankStatus,
  type EvidenceRetrievalStatus,
} from "./canonical-evidence-statuses.js";
export {
  REPORT_INTERPRETATION_WARNING,
  REPORT_PUBLICATION_REASON,
  REQUIRED_REPORT_RATE_METRIC_IDS,
  buildReportDecisionRecordId,
  buildReportCount,
  buildReportRate,
  canonicalReportMethod,
  canonicalReportMethodId,
  canonicalReportMethodSchema,
  reportArtifactPayloadSchema,
  reportInterpretationStatusSchema,
  reportLineageSchema,
  reportRateSchema,
  reportRecordTraceSchema,
  type CanonicalReportMethod,
  type ReportArtifactPayload,
  type ReportCount,
  type ReportDecisionSummary,
  type ReportExclusionSummary,
  type ReportFunnelCounts,
  type ReportLineage,
  type ReportRate,
  type ReportRecordTrace,
  type ReportInterpretationStatus,
} from "./canonical-report.js";

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
 * Occurrence identity excludes parser/source-format implementation data.
 * Stable source locators are preferred; valid char offsets are next; mention
 * index remains a final tie-break so distinct harvest rows never collapse.
 */
export function buildCitationOccurrenceId(
  input: CitationOccurrenceIdentityInputs,
): string {
  return buildStableId("mention", {
    identityKind: "citation-occurrence-v2",
    seedId: input.seedId,
    citingPaperId: input.citingPaperId.trim(),
    citedPaperId: input.citedPaperId.trim(),
    refId: input.refId,
    mentionIndex: input.mentionIndex,
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
              paperType: paperTypeSchema.optional(),
              referencedWorksCount: z.number().int().nonnegative().optional(),
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
        paperType: paperTypeSchema.optional(),
        referencedWorksCount: z.number().int().nonnegative().optional(),
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
    targetRefIds: z.array(z.string().min(1)).default([]),
    charOffsetStart: z.number().int().nonnegative().optional(),
    charOffsetEnd: z.number().int().nonnegative().optional(),
    sourceLocator: citationSourceLocatorSchema.optional(),
    citationGroupOrdinal: z.number().int().nonnegative().optional(),
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

/**
 * Paper-scoped identity of one citation group. `citationGroupOrdinal` restarts
 * at zero in every paragraph, so it is only unique together with the source
 * locator; mentions without a locator fall back to a namespaced mention index.
 */
export function buildCitationGroupKey(
  mention: Pick<
    DiscoverCitationOccurrence,
    "citingPaperId" | "sourceLocator" | "mentionIndex"
  >,
): string {
  const group = mention.sourceLocator
    ? `loc:${mention.sourceLocator.value}`
    : `m:${String(mention.mentionIndex)}`;
  return `${mention.citingPaperId}:${group}`;
}

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
      modelExecutionSchema,
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

export const discoverClaimSupportSpanSchema = z
  .object({
    text: z.string().min(1),
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().positive(),
    verificationStatus: z.literal("verified_exact"),
  })
  .strict()
  .superRefine((span, context) => {
    if (span.charOffsetEnd <= span.charOffsetStart) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message:
          "supportSpan charOffsetEnd must be greater than charOffsetStart",
      });
    }
    if (span.charOffsetEnd - span.charOffsetStart !== span.text.length) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message:
          "supportSpan text length must equal charOffsetEnd - charOffsetStart",
      });
    }
  });
export type DiscoverClaimSupportSpan = z.infer<
  typeof discoverClaimSupportSpanSchema
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
    /**
     * Exact-verified citing-side support span with offsets into the occurrence
     * rawContext. Absent when extraction omitted a span or verification failed.
     */
    supportSpan: discoverClaimSupportSpanSchema.optional(),
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

export const discoverCandidateSelectionAnnotationSchema = z
  .object({
    policyVersion: z.literal("adaptive-portfolio-v3"),
    uniqueCitingPaperCount: z.number().int().nonnegative(),
    uniqueCitationGroupCount: z.number().int().nonnegative(),
    sourceRecordCount: z.number().int().positive(),
    mentionCount: z.number().int().positive(),
    confidenceAggregate: z.number().min(0).max(1),
    specificityScore: z.number().min(0).max(1),
    informativeTokenCount: z.number().int().nonnegative(),
    namedOrAlphanumericTermCount: z.number().int().nonnegative(),
    quantityCount: z.number().int().nonnegative(),
    comparisonCount: z.number().int().nonnegative(),
    conditionCount: z.number().int().nonnegative(),
    genericLanguagePenalty: z.number().min(0).max(1),
    claimShape: z.enum([
      "atomic",
      "methods_protocol",
      "compound",
      "citing_meta",
    ]),
    lexicalFingerprint: z
      .object({
        wordShingleHash: z.string().min(1),
        charShingleHash: z.string().min(1),
        wordShingles: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export const discoverCandidateDispositionSchema = z
  .object({
    candidateId: stableIdentifierSchema,
    selectedForScope: z.boolean(),
    rank: z.number().int().positive(),
    reason: z.string().min(1),
    annotation: discoverCandidateSelectionAnnotationSchema,
    selectionStep: z.number().int().nonnegative().optional(),
    componentScores: z
      .object({
        prevalence: z.number(),
        specificity: z.number(),
        confidence: z.number(),
        novelty: z.number(),
        utility: z.number(),
      })
      .strict()
      .optional(),
    marginalUtility: z.number().optional(),
    projectedRecordCost: z.number().int().nonnegative().optional(),
    bindingConstraint: z
      .enum([
        "selected",
        "max_families",
        "max_prepared_records",
        "min_marginal_novelty",
        "exhausted",
      ])
      .optional(),
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
 * Stage-specific Scope agents will populate frozen family membership and
 * grounding. Excluded citation occurrences remain in the envelope's append-only
 * decisions and exclusions rather than disappearing from scientific history.
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

export type CitationInstanceIdentityInputs = {
  familyId: string;
  citationOccurrenceId: string;
};

/**
 * A prepared record is one scoped family × citation occurrence pair. Identity
 * excludes parser, model, timestamp, context formatting, and classification.
 */
export function buildCitationInstanceRecordId(
  input: CitationInstanceIdentityInputs,
): string {
  return buildStableId("record", {
    identityKind: "prepared-family-citation-occurrence-v2",
    familyId: input.familyId,
    citationOccurrenceId: input.citationOccurrenceId,
  });
}

export const prepareFatalFailureCodeSchema = z.enum([
  "authentication",
  "authorization",
  "billing",
  "quota",
]);
export type PrepareFatalFailureCode = z.infer<
  typeof prepareFatalFailureCodeSchema
>;

export const prepareNonfatalFailureCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "transport",
  "invalid_response",
  "provider_failure",
]);
export type PrepareNonfatalFailureCode = z.infer<
  typeof prepareNonfatalFailureCodeSchema
>;

export const prepareClassificationFailureCodeSchema = z.union([
  prepareFatalFailureCodeSchema,
  prepareNonfatalFailureCodeSchema,
]);
export type PrepareClassificationFailureCode = z.infer<
  typeof prepareClassificationFailureCodeSchema
>;

export const prepareClassificationModifiersSchema = z
  .object({
    isBundled: z.boolean(),
    isReviewMediated: z.boolean(),
    bundleSize: z.number().int().positive(),
  })
  .strict();

const prepareDeterministicClassificationExecutionSchema = z
  .object({
    kind: z.literal("deterministic"),
    implementation: z.string().min(1),
  })
  .strict();

const prepareExternalClassificationExecutionSchema = z
  .object({
    kind: z.literal("external"),
    provider: z.string().min(1),
    requestHash: sha256DigestSchema,
    requestArtifact: artifactReferenceSchema,
    responseArtifact: artifactReferenceSchema,
  })
  .strict();

export const prepareModelClassificationExecutionSchema = z
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

export const prepareClassificationFailureExecutionSchema = z.union([
  prepareExternalClassificationExecutionSchema,
  prepareModelClassificationExecutionSchema,
]);
export type PrepareClassificationFailureExecution = z.infer<
  typeof prepareClassificationFailureExecutionSchema
>;

export const prepareClassificationExecutionSchema = z.union([
  prepareDeterministicClassificationExecutionSchema,
  prepareClassificationFailureExecutionSchema,
]);
export type PrepareClassificationExecution = z.infer<
  typeof prepareClassificationExecutionSchema
>;

const prepareClassificationContentShape = {
  modifiers: prepareClassificationModifiersSchema,
  signals: z.array(z.string().min(1)),
  rationale: z.string().min(1),
  confidence: confidenceSchema,
  execution: prepareClassificationExecutionSchema,
};

export const prepareClassificationSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("classified"),
        citationRole: z.enum([
          "substantive_attribution",
          "background_context",
          "methods_materials",
          "acknowledgment_or_low_information",
        ]),
        evaluationMode: evaluationModeSchema,
        ...prepareClassificationContentShape,
      })
      .strict(),
    z
      .object({
        status: z.literal("ambiguous"),
        citationRole: z.literal("unclear"),
        evaluationMode: z.enum([
          "review_transmission",
          "manual_review_role_ambiguous",
          "manual_review_extraction_limited",
        ]),
        ...prepareClassificationContentShape,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: prepareNonfatalFailureCodeSchema,
        reason: z.string().min(1),
        execution: prepareClassificationFailureExecutionSchema,
      })
      .strict(),
  ])
  .superRefine((classification, context) => {
    if (classification.status === "failed") return;
    const expectedMode = expectedPrepareEvaluationMode(
      classification.citationRole,
      classification.modifiers,
      classification.evaluationMode,
    );
    if (classification.evaluationMode !== expectedMode) {
      context.addIssue({
        code: "custom",
        path: ["evaluationMode"],
        message: `Evaluation mode must be ${expectedMode} for this role and modifiers`,
      });
    }
  });
export type PrepareClassification = z.infer<typeof prepareClassificationSchema>;

const prepareScopeArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-scope-input"),
    canonicalStage: z.literal("scope"),
  })
  .strict();

const prepareDiscoverArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-discover-input"),
    canonicalStage: z.literal("discover"),
  })
  .strict();

const prepareLineageSchema = z
  .object({
    runId: z.string().min(1),
    scopeArtifact: prepareScopeArtifactReferenceSchema,
    discoverArtifact: prepareDiscoverArtifactReferenceSchema,
  })
  .strict();

export const preparedContextSchema = z
  .object({
    verbatim: z
      .object({
        text: z.string(),
        sourceOccurrenceId: stableIdentifierSchema,
        sourceArtifacts: z.array(artifactReferenceSchema).min(1),
      })
      .strict(),
    derived: z.array(
      z
        .object({
          kind: z.enum(["expanded", "annotated"]),
          text: z.string(),
          implementation: z.string().min(1),
          provenanceArtifacts: z.array(artifactReferenceSchema),
        })
        .strict(),
    ),
  })
  .strict();

export const preparedCitationInstanceSchema = z
  .object({
    recordId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    family: scopedFamilySchema,
    sourceCandidates: z.array(discoverClaimCandidateSchema).min(1),
    sourceClaimRecords: z.array(discoverAttributedClaimRecordSchema).min(1),
    occurrenceSourceCandidates: z.array(discoverClaimCandidateSchema).min(1),
    occurrenceSourceClaimRecords: z
      .array(discoverAttributedClaimRecordSchema)
      .min(1),
    seed: discoverSeedSchema,
    citingPaper: discoverCitingPaperRecordSchema,
    citationOccurrence: discoverCitationOccurrenceSchema,
    context: preparedContextSchema,
    classification: prepareClassificationSchema,
    lineage: prepareLineageSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.familyId !== record.family.familyId) {
      context.addIssue({
        code: "custom",
        path: ["familyId"],
        message: "familyId does not match the preserved Scope family",
      });
    }
    if (record.citationOccurrenceId !== record.citationOccurrence.mentionId) {
      context.addIssue({
        code: "custom",
        path: ["citationOccurrenceId"],
        message: "citationOccurrenceId does not match the Discover occurrence",
      });
    }
    const expectedId = buildCitationInstanceRecordId(record);
    if (record.recordId !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["recordId"],
        message: "recordId does not match family × citation occurrence",
      });
    }
    validatePreparedRecordReferences(record, context);
  });
export type PreparedCitationInstance = z.infer<
  typeof preparedCitationInstanceSchema
>;

export const prepareArtifactPayloadSchema = z
  .object({
    lineage: prepareLineageSchema,
    scopedFamilies: z.array(scopedFamilySchema),
    records: z.array(preparedCitationInstanceSchema),
  })
  .strict()
  .superRefine(validatePreparePayload);
export type PrepareArtifactPayload = z.infer<
  typeof prepareArtifactPayloadSchema
>;

const evidencePrepareArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-prepare-input"),
    canonicalStage: z.literal("prepare"),
  })
  .strict();

const evidenceScopeArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-scope-input"),
    canonicalStage: z.literal("scope"),
  })
  .strict();

export const evidenceLineageSchema = z
  .object({
    runId: z.string().min(1),
    prepareArtifact: evidencePrepareArtifactReferenceSchema,
    scopeArtifact: evidenceScopeArtifactReferenceSchema,
  })
  .strict();
export type EvidenceLineage = z.infer<typeof evidenceLineageSchema>;

export const evidenceChunkConfigurationSchema = z
  .object({
    version: z.literal("canonical-evidence-chunking-v1"),
    strategy: z.literal("scope-block-character-windows"),
    boundaryRule: z.literal("fixed-character"),
    maxCharacters: z.number().int().positive(),
    overlapCharacters: z.number().int().nonnegative(),
    sourceOrdering: z.literal("scope-block-offset-then-chunk-offset"),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.overlapCharacters >= configuration.maxCharacters) {
      context.addIssue({
        code: "custom",
        path: ["overlapCharacters"],
        message: "Chunk overlap must be smaller than the chunk size",
      });
    }
  });
export type EvidenceChunkConfiguration = z.infer<
  typeof evidenceChunkConfigurationSchema
>;

export type EvidenceChunkIdentityInputs = {
  seedId: string;
  sourceBlockKind: z.infer<typeof parsedBlockKindSchema>;
  sourceSectionTitle?: string | undefined;
  sourceBlockCharOffsetStart: number;
  sourceBlockCharOffsetEnd: number;
  charOffsetStart: number;
  charOffsetEnd: number;
  textContentHash: string;
  configuration: EvidenceChunkConfiguration;
};

export function buildEvidenceChunkId(
  input: EvidenceChunkIdentityInputs,
): string {
  return buildStableId("evidence-chunk", {
    identityKind: "scope-seed-text-chunk-v1",
    seedId: input.seedId,
    sourceBlockKind: input.sourceBlockKind,
    sourceSectionTitle: input.sourceSectionTitle,
    sourceBlockCharOffsetStart: input.sourceBlockCharOffsetStart,
    sourceBlockCharOffsetEnd: input.sourceBlockCharOffsetEnd,
    charOffsetStart: input.charOffsetStart,
    charOffsetEnd: input.charOffsetEnd,
    textContentHash: input.textContentHash,
    configuration: input.configuration,
  });
}

export const evidenceChunkSchema = z
  .object({
    chunkId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    chunkIndex: z.number().int().nonnegative(),
    text: z.string().min(1),
    contentHash: sha256DigestSchema,
    sourceBlockId: z.string().min(1),
    sourceBlockKind: parsedBlockKindSchema,
    sourceSectionTitle: z.string().min(1).optional(),
    sourceBlockCharOffsetStart: z.number().int().nonnegative(),
    sourceBlockCharOffsetEnd: z.number().int().positive(),
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().positive(),
    overlapWithPrevious: z.number().int().nonnegative(),
    sourceArtifact: artifactReferenceSchema,
    sourceArtifacts: z.array(artifactReferenceSchema).min(1),
    configuration: evidenceChunkConfigurationSchema,
  })
  .strict()
  .superRefine((chunk, context) => {
    if (
      chunk.sourceBlockCharOffsetEnd <= chunk.sourceBlockCharOffsetStart ||
      chunk.charOffsetStart < chunk.sourceBlockCharOffsetStart ||
      chunk.charOffsetEnd > chunk.sourceBlockCharOffsetEnd ||
      chunk.charOffsetEnd <= chunk.charOffsetStart
    ) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Chunk offsets must lie within the exact source block",
      });
    }
    if (chunk.charOffsetEnd - chunk.charOffsetStart !== chunk.text.length) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Chunk offsets must exactly bound the untruncated text",
      });
    }
    if (chunk.contentHash !== canonicalSha256(chunk.text)) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "Chunk content hash does not match its exact text",
      });
    }
    if (
      chunk.chunkId !==
      buildEvidenceChunkId({
        ...chunk,
        textContentHash: chunk.contentHash,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["chunkId"],
        message: "chunkId does not match semantic source location and text",
      });
    }
  });
export type EvidenceChunk = z.infer<typeof evidenceChunkSchema>;

export type EvidenceChunkCorpusIdentityInputs = {
  seedId: string;
  configuration: EvidenceChunkConfiguration;
  chunkIds: readonly string[];
};

export function buildEvidenceChunkCorpusId(
  input: EvidenceChunkCorpusIdentityInputs,
): string {
  return buildStableId("evidence-corpus", {
    identityKind: "scope-seed-text-corpus-v1",
    seedId: input.seedId,
    configuration: input.configuration,
    chunkIds: input.chunkIds,
  });
}

export const evidenceChunkCorpusSchema = z
  .object({
    corpusId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    seedTextArtifact: artifactReferenceSchema,
    sourceArtifacts: z.array(artifactReferenceSchema).min(1),
    configuration: evidenceChunkConfigurationSchema,
    chunks: z.array(evidenceChunkSchema).min(1),
  })
  .strict()
  .superRefine((corpus, context) => {
    addDuplicateIdentifierIssue(
      corpus.chunks.map((chunk) => chunk.chunkId),
      ["chunks"],
      context,
    );
    if (
      corpus.chunks.some(
        (chunk, index) =>
          chunk.seedId !== corpus.seedId ||
          chunk.chunkIndex !== index ||
          canonicalSerialize(chunk.configuration) !==
            canonicalSerialize(corpus.configuration) ||
          !sameArtifactReference(
            chunk.sourceArtifact,
            corpus.seedTextArtifact,
          ) ||
          canonicalSerialize(chunk.sourceArtifacts) !==
            canonicalSerialize(corpus.sourceArtifacts),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["chunks"],
        message:
          "Corpus chunks must preserve seed, order, configuration, and source artifact",
      });
    }
    for (let index = 0; index < corpus.chunks.length; index++) {
      const chunk = corpus.chunks[index]!;
      const previous = corpus.chunks[index - 1];
      const next = corpus.chunks[index + 1];
      if (chunk.text.length > corpus.configuration.maxCharacters) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "text"],
          message: "Chunk text exceeds the declared deterministic window",
        });
      }
      if (!previous || previous.sourceBlockId !== chunk.sourceBlockId) {
        if (
          chunk.overlapWithPrevious !== 0 ||
          chunk.charOffsetStart !== chunk.sourceBlockCharOffsetStart ||
          (previous &&
            chunk.sourceBlockCharOffsetStart <
              previous.sourceBlockCharOffsetEnd)
        ) {
          context.addIssue({
            code: "custom",
            path: ["chunks", index],
            message:
              "Source-block chunks must begin at the block start in immutable source order",
          });
        }
      } else {
        const expectedOverlap = Math.max(
          0,
          previous.charOffsetEnd - chunk.charOffsetStart,
        );
        if (
          chunk.sourceBlockKind !== previous.sourceBlockKind ||
          chunk.sourceSectionTitle !== previous.sourceSectionTitle ||
          chunk.sourceBlockCharOffsetStart !==
            previous.sourceBlockCharOffsetStart ||
          chunk.sourceBlockCharOffsetEnd !==
            previous.sourceBlockCharOffsetEnd ||
          chunk.charOffsetStart <= previous.charOffsetStart ||
          chunk.overlapWithPrevious !== expectedOverlap ||
          expectedOverlap !== corpus.configuration.overlapCharacters
        ) {
          context.addIssue({
            code: "custom",
            path: ["chunks", index, "overlapWithPrevious"],
            message:
              "Adjacent source-block chunks must preserve one locator and the declared overlap",
          });
        }
      }
      if (next?.sourceBlockId === chunk.sourceBlockId) {
        if (chunk.text.length !== corpus.configuration.maxCharacters) {
          context.addIssue({
            code: "custom",
            path: ["chunks", index, "text"],
            message:
              "Every non-final source-block chunk must fill its deterministic window",
          });
        }
      } else if (chunk.charOffsetEnd !== chunk.sourceBlockCharOffsetEnd) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "charOffsetEnd"],
          message:
            "The final chunk of each source block must reach the exact block end",
        });
      }
    }
    if (
      corpus.corpusId !==
      buildEvidenceChunkCorpusId({
        seedId: corpus.seedId,
        configuration: corpus.configuration,
        chunkIds: corpus.chunks.map((chunk) => chunk.chunkId),
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["corpusId"],
        message: "corpusId does not match its ordered semantic chunk set",
      });
    }
  });
export type EvidenceChunkCorpus = z.infer<typeof evidenceChunkCorpusSchema>;

export type EvidenceQueryIdentityInputs =
  | {
      familyId: string;
      text: string;
      source: "scope-family-tracked-claim";
      citationOccurrenceId?: never;
    }
  | {
      familyId: string;
      citationOccurrenceId: string;
      text: string;
      source: "occurrence-local-claims";
    };

export function buildEvidenceQueryId(
  input: EvidenceQueryIdentityInputs,
): string {
  return buildStableId("evidence-query", {
    identityKind: "evidence-query-v2",
    familyId: input.familyId,
    ...(input.source === "occurrence-local-claims"
      ? { citationOccurrenceId: input.citationOccurrenceId }
      : {}),
    text: normalizeWhitespace(input.text),
    source: input.source,
  });
}

export const evidenceQuerySchema = z
  .object({
    queryId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema.optional(),
    text: z.string().min(1),
    contentHash: sha256DigestSchema,
    source: z.enum(["scope-family-tracked-claim", "occurrence-local-claims"]),
    groundingStatus: scopeGroundingStatusSchema,
    verificationStatus: z.enum([
      "scope_grounded",
      "scope_ambiguous",
      "unverified_attributed_claim",
    ]),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      (query.source === "occurrence-local-claims" &&
        query.citationOccurrenceId == null) ||
      (query.source === "scope-family-tracked-claim" &&
        query.citationOccurrenceId != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["citationOccurrenceId"],
        message:
          "Only occurrence-local Evidence queries must identify their citation occurrence",
      });
    }
    if (query.text !== normalizeWhitespace(query.text)) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "Evidence query text must use normalized whitespace",
      });
    }
    if (query.contentHash !== canonicalSha256(query.text)) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "Evidence query content hash does not match its exact text",
      });
    }
    if (
      query.queryId !==
      buildEvidenceQueryId(
        query.source === "occurrence-local-claims"
          ? {
              familyId: query.familyId,
              citationOccurrenceId: query.citationOccurrenceId ?? "",
              text: query.text,
              source: query.source,
            }
          : {
              familyId: query.familyId,
              text: query.text,
              source: query.source,
            },
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["queryId"],
        message: "queryId does not match the Evidence query identity",
      });
    }
    const expectedVerification =
      query.groundingStatus === "grounded"
        ? "scope_grounded"
        : query.groundingStatus === "ambiguous"
          ? "scope_ambiguous"
          : "unverified_attributed_claim";
    if (query.verificationStatus !== expectedVerification) {
      context.addIssue({
        code: "custom",
        path: ["verificationStatus"],
        message:
          "Query verification must honestly reflect the Scope grounding annotation",
      });
    }
  });
export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;

export const evidenceBm25ConfigurationSchema = z
  .object({
    version: z.literal("canonical-bm25-v1"),
    k1: z.number().positive(),
    b: z.number().min(0).max(1),
    tokenizer: z
      .object({
        version: z.literal("unicode-alphanumeric-hyphen-stopwords-v1"),
        tokenPattern: z.string().min(1),
        lowercase: z.literal(true),
        stopWords: z.array(z.string().min(1)),
      })
      .strict(),
    candidateLimit: z.number().int().positive(),
    tieBreaker: z.literal("chunk-id-code-unit-ascending"),
  })
  .strict();
export type EvidenceBm25Configuration = z.infer<
  typeof evidenceBm25ConfigurationSchema
>;

export type EvidenceBm25RunIdentityInputs = {
  queryText: string;
  corpusId: string;
  corpusChunkIds: readonly string[];
  configuration: EvidenceBm25Configuration;
  rankingContentHash: string;
  componentBm25RunIds?: readonly string[] | undefined;
};

export function buildEvidenceBm25RunId(
  input: EvidenceBm25RunIdentityInputs,
): string {
  return buildStableId("bm25-run", {
    identityKind: "canonical-evidence-bm25-run-v2",
    queryContentHash: canonicalSha256(normalizeWhitespace(input.queryText)),
    corpusId: input.corpusId,
    corpusChunkIds: input.corpusChunkIds,
    configuration: input.configuration,
    rankingContentHash: input.rankingContentHash,
    ...(input.componentBm25RunIds
      ? { componentBm25RunIds: input.componentBm25RunIds }
      : {}),
  });
}

export const evidenceBm25CandidateSchema = z
  .object({
    chunkId: stableIdentifierSchema,
    rawScore: z.number().positive(),
    rank: z.number().int().positive(),
  })
  .strict();
export type EvidenceBm25Candidate = z.infer<typeof evidenceBm25CandidateSchema>;

export const evidenceBm25RunSchema = z
  .object({
    bm25RunId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    queryId: stableIdentifierSchema,
    queryText: z.string().min(1),
    queryTerms: z.array(z.string().min(1)),
    corpusId: stableIdentifierSchema,
    corpusChunkIds: z.array(stableIdentifierSchema).min(1),
    configuration: evidenceBm25ConfigurationSchema,
    status: z.enum(["matched", "no_lexical_matches"]),
    candidates: z.array(evidenceBm25CandidateSchema),
    componentBm25RunIds: z.array(stableIdentifierSchema).min(2).optional(),
    rankingContentHash: sha256DigestSchema,
  })
  .strict()
  .superRefine((run, context) => {
    addDuplicateIdentifierIssue(
      run.corpusChunkIds,
      ["corpusChunkIds"],
      context,
    );
    addDuplicateIdentifierIssue(
      run.candidates.map((candidate) => candidate.chunkId),
      ["candidates"],
      context,
    );
    if (run.componentBm25RunIds) {
      addSortedUniqueIdentifierIssue(
        run.componentBm25RunIds,
        ["componentBm25RunIds"],
        context,
      );
    }
    if (
      run.candidates.some(
        (candidate, index) =>
          candidate.rank !== index + 1 ||
          !run.corpusChunkIds.includes(candidate.chunkId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message:
          "BM25 candidates must have contiguous ranks and belong to the exact corpus",
      });
    }
    if (run.candidates.length > run.configuration.candidateLimit) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "BM25 candidates exceed the declared candidate limit",
      });
    }
    validateScoreOrdering(
      run.candidates,
      (candidate) => candidate.rawScore,
      (candidate) => candidate.chunkId,
      ["candidates"],
      context,
    );
    const expectedStatus =
      run.candidates.length > 0 ? "matched" : "no_lexical_matches";
    if (run.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "BM25 status does not match its candidate results",
      });
    }
    if (
      run.rankingContentHash !==
      canonicalSha256({
        queryTerms: run.queryTerms,
        candidates: run.candidates,
        ...(run.componentBm25RunIds
          ? { componentBm25RunIds: run.componentBm25RunIds }
          : {}),
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["rankingContentHash"],
        message:
          "BM25 ranking content hash does not match raw scores and ranks",
      });
    }
    if (run.bm25RunId !== buildEvidenceBm25RunId(run)) {
      context.addIssue({
        code: "custom",
        path: ["bm25RunId"],
        message:
          "bm25RunId does not match query, corpus, and BM25 configuration",
      });
    }
  });
export type EvidenceBm25Run = z.infer<typeof evidenceBm25RunSchema>;

export const evidenceRerankFatalFailureCodeSchema = z.enum([
  "authentication",
  "authorization",
  "billing",
  "quota",
]);
export type EvidenceRerankFatalFailureCode = z.infer<
  typeof evidenceRerankFatalFailureCodeSchema
>;

export const evidenceRerankNonfatalFailureCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "transport",
  "invalid_response",
  "provider_failure",
]);
export type EvidenceRerankNonfatalFailureCode = z.infer<
  typeof evidenceRerankNonfatalFailureCodeSchema
>;

export const evidenceRerankFailureCodeSchema = z.union([
  evidenceRerankFatalFailureCodeSchema,
  evidenceRerankNonfatalFailureCodeSchema,
]);

export const evidenceRerankOutputSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            chunkId: stableIdentifierSchema,
            relevanceScore: z.number().min(0).max(100),
            rank: z.number().int().positive(),
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type EvidenceRerankOutput = z.infer<typeof evidenceRerankOutputSchema>;

export type EvidenceRerankRunIdentityInputs = {
  bm25RunId: string;
  candidateChunkIds: readonly string[];
  topN: number;
  execution: ModelExecution;
  outcomeContentHash: string;
};

export function buildEvidenceRerankRunId(
  input: EvidenceRerankRunIdentityInputs,
): string {
  return buildStableId("rerank-run", {
    identityKind: "canonical-evidence-relevance-rerank-v1",
    bm25RunId: input.bm25RunId,
    candidateChunkIds: input.candidateChunkIds,
    topN: input.topN,
    provider: input.execution.provider,
    model: input.execution.model,
    promptId: input.execution.promptId,
    promptVersion: input.execution.promptVersion,
    promptContentHash: input.execution.promptContentHash,
    requestHash: input.execution.requestHash,
    responseArtifact: {
      artifactId: input.execution.responseArtifact.artifactId,
      contentHash: input.execution.responseArtifact.contentHash,
    },
    outcomeContentHash: input.outcomeContentHash,
  });
}

const evidenceRerankRunBaseShape = {
  rerankRunId: stableIdentifierSchema,
  bm25RunId: stableIdentifierSchema,
  queryId: stableIdentifierSchema,
  queryText: z.string().min(1),
  candidateChunkIds: z.array(stableIdentifierSchema).min(1),
  topN: z.number().int().positive(),
  execution: modelExecutionSchema,
};

export const evidenceRerankRunSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        ...evidenceRerankRunBaseShape,
        status: z.literal("completed"),
        results: evidenceRerankOutputSchema.shape.results,
        rankingContentHash: sha256DigestSchema,
      })
      .strict(),
    z
      .object({
        ...evidenceRerankRunBaseShape,
        status: z.literal("failed"),
        results: z.array(z.never()).length(0),
        failure: z
          .object({
            code: evidenceRerankNonfatalFailureCodeSchema,
            reason: z.string().min(1),
          })
          .strict(),
        rankingContentHash: sha256DigestSchema,
      })
      .strict(),
  ])
  .superRefine((run, context) => {
    addDuplicateIdentifierIssue(
      run.candidateChunkIds,
      ["candidateChunkIds"],
      context,
    );
    if (
      run.rerankRunId !==
      buildEvidenceRerankRunId({
        ...run,
        outcomeContentHash: run.rankingContentHash,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["rerankRunId"],
        message:
          "rerankRunId does not match its BM25 run, model request, and immutable outcome",
      });
    }
    if (run.status === "completed") {
      addDuplicateIdentifierIssue(
        run.results.map((result) => result.chunkId),
        ["results"],
        context,
      );
      if (
        run.results.length > run.topN ||
        run.results.some(
          (result, index) =>
            result.rank !== index + 1 ||
            !run.candidateChunkIds.includes(result.chunkId),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["results"],
          message:
            "Reranked results must be a ranked subset of the supplied BM25 candidates",
        });
      }
      validateScoreOrdering(
        run.results,
        (result) => result.relevanceScore,
        (result) => result.chunkId,
        ["results"],
        context,
      );
    }
    const expectedHash =
      run.status === "completed"
        ? canonicalSha256({ status: run.status, results: run.results })
        : canonicalSha256({
            status: run.status,
            results: run.results,
            failure: run.failure,
          });
    if (run.rankingContentHash !== expectedHash) {
      context.addIssue({
        code: "custom",
        path: ["rankingContentHash"],
        message: "Rerank content hash does not match its immutable outcome",
      });
    }
  });
export type EvidenceRerankRun = z.infer<typeof evidenceRerankRunSchema>;

export const evidenceRerankingPolicySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      topN: z.number().int().positive(),
    })
    .strict(),
]);
export type EvidenceRerankingPolicy = z.infer<
  typeof evidenceRerankingPolicySchema
>;

export type EvidenceSelectionIdentityInputs = {
  bm25RunId: string;
  rerankRunId?: string | undefined;
  rankingSource: "bm25" | "reranked" | "bm25_with_scope_pins";
  rankingId: string;
  selectionLimit: number;
  selectedChunkIds: readonly string[];
  pinnedChunkIds?: readonly string[] | undefined;
};

export function buildEvidenceSelectionId(
  input: EvidenceSelectionIdentityInputs,
): string {
  return buildStableId("evidence-selection", {
    identityKind: "canonical-evidence-final-selection-v1",
    bm25RunId: input.bm25RunId,
    rerankRunId: input.rerankRunId,
    rankingSource: input.rankingSource,
    rankingId: input.rankingId,
    selectionLimit: input.selectionLimit,
    selectedChunkIds: input.selectedChunkIds,
    ...(input.pinnedChunkIds != null && input.pinnedChunkIds.length > 0
      ? { pinnedChunkIds: input.pinnedChunkIds }
      : {}),
  });
}

export const evidenceSelectionSchema = z
  .object({
    selectionId: stableIdentifierSchema,
    bm25RunId: stableIdentifierSchema,
    rerankRunId: stableIdentifierSchema.optional(),
    rankingSource: z.enum(["bm25", "reranked", "bm25_with_scope_pins"]),
    rankingId: stableIdentifierSchema,
    selectionLimit: z.number().int().positive(),
    selectedChunkIds: z.array(stableIdentifierSchema).min(1),
    pinnedChunkIds: z.array(stableIdentifierSchema).optional(),
    selectionContentHash: sha256DigestSchema,
  })
  .strict()
  .superRefine((selection, context) => {
    addDuplicateIdentifierIssue(
      selection.selectedChunkIds,
      ["selectedChunkIds"],
      context,
    );
    if (selection.pinnedChunkIds) {
      addDuplicateIdentifierIssue(
        selection.pinnedChunkIds,
        ["pinnedChunkIds"],
        context,
      );
    }
    if (selection.selectedChunkIds.length > selection.selectionLimit) {
      context.addIssue({
        code: "custom",
        path: ["selectedChunkIds"],
        message: "Final evidence selection exceeds its declared limit",
      });
    }
    if (
      (selection.rankingSource === "bm25" ||
        selection.rankingSource === "bm25_with_scope_pins") &&
      (selection.rankingId !== selection.bm25RunId ||
        selection.rerankRunId != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rankingId"],
        message: "BM25 selection must point only to its immutable BM25 run",
      });
    }
    if (
      selection.rankingSource === "bm25_with_scope_pins" &&
      (selection.pinnedChunkIds == null ||
        selection.pinnedChunkIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pinnedChunkIds"],
        message: "Scope-pinned BM25 selection requires pinned chunk IDs",
      });
    }
    if (
      selection.rankingSource === "bm25" &&
      selection.pinnedChunkIds != null &&
      selection.pinnedChunkIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["pinnedChunkIds"],
        message: "Pure BM25 selection cannot declare scope pins",
      });
    }
    if (
      selection.rankingSource === "reranked" &&
      (selection.rerankRunId == null ||
        selection.rankingId !== selection.rerankRunId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rankingId"],
        message: "Reranked selection must name its separate rerank run",
      });
    }
    if (
      selection.selectionContentHash !==
      canonicalSha256(selection.selectedChunkIds)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectionContentHash"],
        message: "Selection content hash does not match selected chunk IDs",
      });
    }
    if (selection.selectionId !== buildEvidenceSelectionId(selection)) {
      context.addIssue({
        code: "custom",
        path: ["selectionId"],
        message: "selectionId does not match its source ranking and chunks",
      });
    }
  });
export type EvidenceSelection = z.infer<typeof evidenceSelectionSchema>;

export const evidencePreparedRecordLedgerEntrySchema = z
  .object({
    recordId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.recordId !== buildCitationInstanceRecordId(record)) {
      context.addIssue({
        code: "custom",
        path: ["recordId"],
        message:
          "Evidence ledger recordId does not match family × citation occurrence",
      });
    }
  });
export type EvidencePreparedRecordLedgerEntry = z.infer<
  typeof evidencePreparedRecordLedgerEntrySchema
>;

export const evidenceRecordOutcomeSchema = z
  .object({
    recordId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    queryId: stableIdentifierSchema,
    retrievalStatus: evidenceRetrievalStatusSchema,
    rerankStatus: evidenceRerankStatusSchema,
    fallbackQueryId: stableIdentifierSchema.optional(),
    componentBm25RunIds: z.array(stableIdentifierSchema).min(1).optional(),
    primaryQuerySource: z
      .enum(["scope-family-tracked-claim", "occurrence-local-claims"])
      .optional(),
    corpusId: stableIdentifierSchema.optional(),
    bm25RunId: stableIdentifierSchema.optional(),
    rerankRunId: stableIdentifierSchema.optional(),
    finalSelectionId: stableIdentifierSchema.optional(),
    failure: z
      .object({
        code: z.enum(["chunking_failed", "bm25_failed"]),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EvidenceRecordOutcome = z.infer<typeof evidenceRecordOutcomeSchema>;

export const evidenceArtifactPayloadSchema = z
  .object({
    lineage: evidenceLineageSchema,
    rerankingPolicy: evidenceRerankingPolicySchema,
    preparedRecords: z.array(evidencePreparedRecordLedgerEntrySchema),
    queries: z.array(evidenceQuerySchema),
    corpora: z.array(evidenceChunkCorpusSchema),
    bm25Runs: z.array(evidenceBm25RunSchema),
    rerankRuns: z.array(evidenceRerankRunSchema),
    selections: z.array(evidenceSelectionSchema),
    records: z.array(evidenceRecordOutcomeSchema),
  })
  .strict()
  .superRefine(validateEvidencePayload);
export type EvidenceArtifactPayload = z.infer<
  typeof evidenceArtifactPayloadSchema
>;

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
  .superRefine((artifact, context) => {
    validateLeanArtifactIdentity(artifact, context);
    validateScopeArtifactLineage(artifact, context);
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
    validatePrepareArtifactLineage(artifact, context);
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
    validateEvidenceArtifactLineage(artifact, context);
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
    } else if (record.supportSpan) {
      const slice = mention.rawContext.slice(
        record.supportSpan.charOffsetStart,
        record.supportSpan.charOffsetEnd,
      );
      if (slice !== record.supportSpan.text) {
        addDiscoverLedgerIssue(
          context,
          ["attributedClaimRecords", index, "supportSpan"],
          "supportSpan text must exactly equal the occurrence rawContext slice at the stored offsets",
        );
      }
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
      addScopeIssue(
        context,
        ["candidateDecisions"],
        `Scoped candidate references an unknown family: ${decision.familyId}`,
      );
      continue;
    }
    if (family.seedId !== decision.seedId) {
      addScopeIssue(
        context,
        ["candidateDecisions"],
        `Scoped candidate and family belong to different seeds: ${decision.candidateId}`,
      );
    }
    if (!family.candidateIds.includes(decision.candidateId)) {
      addScopeIssue(
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
      addScopeIssue(
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
      addScopeIssue(
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
      addScopeIssue(
        context,
        ["families"],
        `Family occurrence membership must exactly equal its Discover candidate membership: ${family.familyId}`,
      );
    }

    const materialization = materializationsBySeedId.get(family.seedId);
    if (!materialization) {
      addScopeIssue(
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
      addScopeIssue(
        context,
        ["families"],
        `Family does not reference the immutable Discover input: ${family.familyId}`,
      );
    }
    for (const reference of scopeMaterializationArtifactReferences(
      materialization,
    )) {
      if (!hasArtifactReference(family.provenanceArtifacts, reference)) {
        addScopeIssue(
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
          addScopeIssue(
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
      addScopeIssue(
        context,
        ["seedMaterializations"],
        `Seed materialization has no scoped family: ${materialization.seedId}`,
      );
    }
  }
}

function expectedPrepareEvaluationMode(
  role: CitationRole,
  modifiers: z.infer<typeof prepareClassificationModifiersSchema>,
  ambiguousMode: z.infer<typeof evaluationModeSchema>,
): z.infer<typeof evaluationModeSchema> {
  if (modifiers.isReviewMediated) return "review_transmission";
  if (
    modifiers.isBundled &&
    (role === "substantive_attribution" || role === "background_context")
  ) {
    return "fidelity_bundled_use";
  }
  switch (role) {
    case "substantive_attribution":
      return "fidelity_specific_claim";
    case "background_context":
      return "fidelity_background_framing";
    case "methods_materials":
      return "fidelity_methods_use";
    case "acknowledgment_or_low_information":
      return "skip_low_information";
    case "unclear":
      return ambiguousMode === "manual_review_extraction_limited"
        ? "manual_review_extraction_limited"
        : "manual_review_role_ambiguous";
  }
}

function validatePreparedRecordReferences(
  record: PreparedCitationInstance,
  context: z.RefinementCtx,
): void {
  const occurrence = record.citationOccurrence;
  const sourceCandidateIds = record.sourceCandidates.map(
    (candidate) => candidate.candidateId,
  );
  const sourceClaimRecordIds = record.sourceClaimRecords.map(
    (sourceClaim) => sourceClaim.claimRecordId,
  );
  if (
    !sameIdentifierSequence(sourceCandidateIds, record.family.candidateIds) ||
    record.sourceCandidates.some(
      (candidate) => candidate.seedId !== record.family.seedId,
    )
  ) {
    addPrepareIssue(
      context,
      ["sourceCandidates"],
      "Prepared source candidates must exactly preserve the Scope family candidate references",
    );
  }
  if (
    !sameIdentifierSequence(
      sourceClaimRecordIds,
      record.family.sourceClaimRecordIds,
    ) ||
    record.sourceClaimRecords.some(
      (sourceClaim) => sourceClaim.seedId !== record.family.seedId,
    )
  ) {
    addPrepareIssue(
      context,
      ["sourceClaimRecords"],
      "Prepared source claims must exactly preserve the Scope family claim provenance",
    );
  }
  const expectedOccurrenceSourceCandidates = record.sourceCandidates.filter(
    (candidate) => candidate.memberMentionIds.includes(occurrence.mentionId),
  );
  const expectedOccurrenceSourceClaimRecords = record.sourceClaimRecords.filter(
    (sourceClaim) => sourceClaim.mentionId === occurrence.mentionId,
  );
  if (
    canonicalSerialize(record.occurrenceSourceCandidates) !==
    canonicalSerialize(expectedOccurrenceSourceCandidates)
  ) {
    addPrepareIssue(
      context,
      ["occurrenceSourceCandidates"],
      "Occurrence-local candidates must be the exact ordered family subset containing this occurrence",
    );
  }
  if (
    canonicalSerialize(record.occurrenceSourceClaimRecords) !==
    canonicalSerialize(expectedOccurrenceSourceClaimRecords)
  ) {
    addPrepareIssue(
      context,
      ["occurrenceSourceClaimRecords"],
      "Occurrence-local claims must be the exact ordered family subset attributed at this occurrence",
    );
  }
  const localCandidateClaimIds = new Set(
    record.occurrenceSourceCandidates.flatMap(
      (candidate) => candidate.sourceClaimRecordIds,
    ),
  );
  if (
    record.occurrenceSourceClaimRecords.some(
      (sourceClaim) => !localCandidateClaimIds.has(sourceClaim.claimRecordId),
    ) ||
    record.occurrenceSourceCandidates.some(
      (candidate) =>
        !record.occurrenceSourceClaimRecords.some((sourceClaim) =>
          candidate.sourceClaimRecordIds.includes(sourceClaim.claimRecordId),
        ),
    )
  ) {
    addPrepareIssue(
      context,
      ["occurrenceSourceClaimRecords"],
      "Occurrence-local candidates and claims must reference each other within this family",
    );
  }
  if (
    !record.family.includedCitationOccurrenceIds.includes(occurrence.mentionId)
  ) {
    addPrepareIssue(
      context,
      ["family", "includedCitationOccurrenceIds"],
      "Prepared occurrence is not a member of its Scope family",
    );
  }
  if (
    record.family.seedId !== record.seed.seedId ||
    occurrence.seedId !== record.seed.seedId
  ) {
    addPrepareIssue(
      context,
      ["seed", "seedId"],
      "Prepared family, occurrence, and seed must share one seed identity",
    );
  }
  if (
    occurrence.citingPaperRecordId !== record.citingPaper.citingPaperRecordId ||
    occurrence.citingPaperId !== record.citingPaper.paper.paperId ||
    occurrence.seedId !== record.citingPaper.seedId
  ) {
    addPrepareIssue(
      context,
      ["citingPaper"],
      "Prepared occurrence does not match its Discover citing-paper record",
    );
  }
  if (record.seed.resolution.status !== "resolved") {
    addPrepareIssue(
      context,
      ["seed", "resolution"],
      "A prepared citation occurrence requires a resolved Discover seed paper",
    );
  } else if (occurrence.citedPaperId !== record.seed.resolution.paper.paperId) {
    addPrepareIssue(
      context,
      ["citationOccurrence", "citedPaperId"],
      "Prepared occurrence does not cite its resolved Discover seed paper",
    );
  }
  if (
    record.context.verbatim.sourceOccurrenceId !== occurrence.mentionId ||
    record.context.verbatim.text !== occurrence.rawContext ||
    canonicalSerialize(record.context.verbatim.sourceArtifacts) !==
      canonicalSerialize(occurrence.observationProvenance.artifacts)
  ) {
    addPrepareIssue(
      context,
      ["context", "verbatim"],
      "Verbatim context must exactly preserve the Discover occurrence",
    );
  }
  if (record.classification.status !== "failed") {
    if (
      record.classification.modifiers.isBundled !==
        occurrence.isBundledCitation ||
      record.classification.modifiers.bundleSize !== occurrence.bundleSize
    ) {
      addPrepareIssue(
        context,
        ["classification", "modifiers"],
        "Classification bundle modifiers must preserve the Discover occurrence",
      );
    }
  }
}

function validatePreparePayload(
  payload: PrepareArtifactPayload,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIdentifierIssue(
    payload.scopedFamilies.map((family) => family.familyId),
    ["scopedFamilies"],
    context,
  );
  addSortedUniqueIdentifierIssue(
    payload.records.map((record) => record.recordId),
    ["records"],
    context,
  );

  const pairKeys = payload.records.map((record) =>
    canonicalSerialize({
      familyId: record.familyId,
      citationOccurrenceId: record.citationOccurrenceId,
    }),
  );
  const duplicatePair = findDuplicate(pairKeys);
  if (duplicatePair) {
    addPrepareIssue(
      context,
      ["records"],
      `Duplicate prepared family × occurrence pair: ${duplicatePair}`,
    );
  }

  const familiesById = new Map(
    payload.scopedFamilies.map((family) => [family.familyId, family]),
  );
  const expectedPairKeys = new Set(
    payload.scopedFamilies.flatMap((family) =>
      family.includedCitationOccurrenceIds.map((citationOccurrenceId) =>
        canonicalSerialize({
          familyId: family.familyId,
          citationOccurrenceId,
        }),
      ),
    ),
  );
  const actualPairKeys = new Set(pairKeys);
  for (const pairKey of expectedPairKeys) {
    if (!actualPairKeys.has(pairKey)) {
      addPrepareIssue(
        context,
        ["records"],
        `Missing Prepare outcome for scoped pair: ${pairKey}`,
      );
    }
  }
  for (const pairKey of actualPairKeys) {
    if (!expectedPairKeys.has(pairKey)) {
      addPrepareIssue(
        context,
        ["records"],
        `Prepare record is outside frozen Scope membership: ${pairKey}`,
      );
    }
  }

  for (const [index, record] of payload.records.entries()) {
    const family = familiesById.get(record.familyId);
    if (!family) {
      addPrepareIssue(
        context,
        ["records", index, "familyId"],
        "Prepare record references an unknown Scope family",
      );
    } else if (
      canonicalSerialize(record.family) !== canonicalSerialize(family)
    ) {
      addPrepareIssue(
        context,
        ["records", index, "family"],
        "Prepare record does not preserve its exact Scope family",
      );
    }
    if (
      !sameArtifactReference(
        record.lineage.scopeArtifact,
        payload.lineage.scopeArtifact,
      ) ||
      !sameArtifactReference(
        record.lineage.discoverArtifact,
        payload.lineage.discoverArtifact,
      ) ||
      record.lineage.runId !== payload.lineage.runId
    ) {
      addPrepareIssue(
        context,
        ["records", index, "lineage"],
        "Prepare record lineage differs from the payload lineage",
      );
    }
  }
}

function validatePrepareArtifactLineage(
  artifact: z.infer<typeof commonLeanArtifactEnvelopeSchema> & {
    canonicalStage: "prepare";
    payload: PrepareArtifactPayload;
  },
  context: z.RefinementCtx,
): void {
  const { lineage } = artifact.payload;
  if (artifact.runId !== lineage.runId) {
    addPrepareIssue(
      context,
      ["payload", "lineage", "runId"],
      "Prepare run ID must match its verified Scope and Discover lineage",
    );
  }
  if (
    artifact.inputArtifacts.length !== 2 ||
    !sameArtifactReference(artifact.inputArtifacts[0], lineage.scopeArtifact) ||
    !sameArtifactReference(artifact.inputArtifacts[1], lineage.discoverArtifact)
  ) {
    addPrepareIssue(
      context,
      ["inputArtifacts"],
      "Prepare must reference exact canonical Scope and Discover inputs",
    );
  }

  if (artifact.decisions.length !== artifact.payload.records.length) {
    addPrepareIssue(
      context,
      ["decisions"],
      "Prepare must account for every record with exactly one classification outcome decision",
    );
  }
  for (const record of artifact.payload.records) {
    const expectedReason = prepareClassificationReason(record.classification);
    const matching = artifact.decisions.filter(
      (decision) =>
        decision.recordId === record.recordId &&
        decision.decisionType === "prepare_classification_outcome" &&
        decision.outcome === record.classification.status &&
        decision.reason === expectedReason,
    );
    if (matching.length !== 1) {
      addPrepareIssue(
        context,
        ["decisions"],
        `Prepare classification is not accounted for exactly once: ${record.recordId}`,
      );
    }
    for (const decision of matching) {
      if (
        !hasArtifactReference(
          decision.evidenceArtifacts,
          lineage.scopeArtifact,
        ) ||
        !hasArtifactReference(
          decision.evidenceArtifacts,
          lineage.discoverArtifact,
        )
      ) {
        addPrepareIssue(
          context,
          ["decisions"],
          `Prepare decision is missing exact input lineage: ${record.recordId}`,
        );
      }
    }
  }

  const classifications = artifact.payload.records.map(
    (record) => record.classification,
  );
  const modelExecutions = classifications
    .map((classification) => classification.execution)
    .filter(
      (
        execution,
      ): execution is z.infer<
        typeof prepareModelClassificationExecutionSchema
      > => execution.kind === "model",
    );
  const externalExecutions = classifications
    .map((classification) => classification.execution)
    .filter((execution) => execution.kind === "external");
  const expectedPrompts = uniqueCanonicalValues(
    modelExecutions.map((execution) => ({
      promptId: execution.promptId,
      version: execution.promptVersion,
      contentHash: execution.promptContentHash,
    })),
  );
  const expectedModels = uniqueCanonicalValues(
    modelExecutions.map((execution) => ({
      provider: execution.provider,
      model: execution.model,
      requestHash: execution.requestHash,
      requestArtifact: execution.requestArtifact,
      responseArtifact: execution.responseArtifact,
    })),
  );
  if (
    canonicalSerialize(uniqueCanonicalValues(artifact.provenance.prompts)) !==
    canonicalSerialize(expectedPrompts)
  ) {
    addPrepareIssue(
      context,
      ["provenance", "prompts"],
      "Prepare prompt provenance does not exactly cover model classification",
    );
  }
  if (
    canonicalSerialize(uniqueCanonicalValues(artifact.provenance.models)) !==
    canonicalSerialize(expectedModels)
  ) {
    addPrepareIssue(
      context,
      ["provenance", "models"],
      "Prepare model provenance does not exactly cover model classification",
    );
  }

  const expectedResponses = uniqueCanonicalValues([
    ...modelExecutions.map((execution) => execution.responseArtifact),
    ...externalExecutions.map((execution) => execution.responseArtifact),
  ]);
  const expectedExecutionKind =
    modelExecutions.length > 0 && externalExecutions.length > 0
      ? "hybrid"
      : modelExecutions.length > 0
        ? "model"
        : externalExecutions.length > 0
          ? "external"
          : "deterministic";
  if (artifact.execution.kind !== expectedExecutionKind) {
    addPrepareIssue(
      context,
      ["execution", "kind"],
      `Prepare execution kind must be ${expectedExecutionKind}`,
    );
  } else if (
    artifact.execution.kind !== "deterministic" &&
    canonicalSerialize(
      uniqueCanonicalValues(artifact.execution.responseArtifacts),
    ) !== canonicalSerialize(expectedResponses)
  ) {
    addPrepareIssue(
      context,
      ["execution", "responseArtifacts"],
      "Prepare execution must reference every exact classifier response",
    );
  }
}

function validateEvidencePayload(
  payload: EvidenceArtifactPayload,
  context: z.RefinementCtx,
): void {
  const sortedCollections: Array<{
    values: string[];
    path: string;
  }> = [
    {
      values: payload.preparedRecords.map((record) => record.recordId),
      path: "preparedRecords",
    },
    {
      values: payload.queries.map((query) => query.queryId),
      path: "queries",
    },
    {
      values: payload.corpora.map((corpus) => corpus.corpusId),
      path: "corpora",
    },
    {
      values: payload.bm25Runs.map((run) => run.bm25RunId),
      path: "bm25Runs",
    },
    {
      values: payload.rerankRuns.map((run) => run.rerankRunId),
      path: "rerankRuns",
    },
    {
      values: payload.selections.map((selection) => selection.selectionId),
      path: "selections",
    },
    {
      values: payload.records.map((record) => record.recordId),
      path: "records",
    },
  ];
  for (const collection of sortedCollections) {
    addSortedUniqueIdentifierIssue(
      collection.values,
      [collection.path],
      context,
    );
  }

  const duplicatePreparedPair = findDuplicate(
    payload.preparedRecords.map((record) =>
      canonicalSerialize({
        familyId: record.familyId,
        citationOccurrenceId: record.citationOccurrenceId,
      }),
    ),
  );
  if (duplicatePreparedPair) {
    addEvidenceIssue(
      context,
      ["preparedRecords"],
      `Duplicate prepared family × occurrence ledger entry: ${duplicatePreparedPair}`,
    );
  }

  const ledgerByRecordId = new Map(
    payload.preparedRecords.map((record) => [record.recordId, record]),
  );
  const outcomesByRecordId = new Map(
    payload.records.map((record) => [record.recordId, record]),
  );
  for (const preparedRecord of payload.preparedRecords) {
    const outcome = outcomesByRecordId.get(preparedRecord.recordId);
    if (!outcome) {
      addEvidenceIssue(
        context,
        ["records"],
        `Missing Evidence outcome for Prepare record: ${preparedRecord.recordId}`,
      );
    } else if (
      outcome.familyId !== preparedRecord.familyId ||
      outcome.citationOccurrenceId !== preparedRecord.citationOccurrenceId ||
      outcome.seedId !== preparedRecord.seedId
    ) {
      addEvidenceIssue(
        context,
        ["records"],
        `Evidence outcome changed Prepare record identity: ${preparedRecord.recordId}`,
      );
    }
  }
  for (const outcome of payload.records) {
    if (!ledgerByRecordId.has(outcome.recordId)) {
      addEvidenceIssue(
        context,
        ["records"],
        `Evidence outcome is outside the Prepare ledger: ${outcome.recordId}`,
      );
    }
  }

  const queriesById = new Map(
    payload.queries.map((query) => [query.queryId, query]),
  );
  const corporaById = new Map(
    payload.corpora.map((corpus) => [corpus.corpusId, corpus]),
  );
  const bm25RunsById = new Map(
    payload.bm25Runs.map((run) => [run.bm25RunId, run]),
  );
  const rerankRunsById = new Map(
    payload.rerankRuns.map((run) => [run.rerankRunId, run]),
  );
  const selectionsById = new Map(
    payload.selections.map((selection) => [selection.selectionId, selection]),
  );

  for (const run of payload.bm25Runs) {
    const query = queriesById.get(run.queryId);
    const corpus = corporaById.get(run.corpusId);
    if (
      !query ||
      query.familyId !== run.familyId ||
      query.text !== run.queryText
    ) {
      addEvidenceIssue(
        context,
        ["bm25Runs"],
        `BM25 run does not preserve its exact family query: ${run.bm25RunId}`,
      );
    }
    if (
      !corpus ||
      !sameIdentifierSequence(
        run.corpusChunkIds,
        corpus.chunks.map((chunk) => chunk.chunkId),
      )
    ) {
      addEvidenceIssue(
        context,
        ["bm25Runs"],
        `BM25 run does not name its exact ordered chunk corpus: ${run.bm25RunId}`,
      );
    }
    for (const componentBm25RunId of run.componentBm25RunIds ?? []) {
      const component = bm25RunsById.get(componentBm25RunId);
      if (
        !component ||
        component.bm25RunId === run.bm25RunId ||
        component.corpusId !== run.corpusId
      ) {
        addEvidenceIssue(
          context,
          ["bm25Runs"],
          `Union BM25 run references an invalid component run: ${run.bm25RunId}`,
        );
      }
    }
  }

  for (const run of payload.rerankRuns) {
    const bm25Run = bm25RunsById.get(run.bm25RunId);
    const query = queriesById.get(run.queryId);
    if (
      !bm25Run ||
      !query ||
      bm25Run.queryText !== run.queryText ||
      query.text !== run.queryText ||
      !sameIdentifierSequence(
        run.candidateChunkIds,
        bm25Run.candidates.map((candidate) => candidate.chunkId),
      )
    ) {
      addEvidenceIssue(
        context,
        ["rerankRuns"],
        `Rerank run does not reference one immutable BM25 candidate set: ${run.rerankRunId}`,
      );
    }
  }

  for (const selection of payload.selections) {
    const bm25Run = bm25RunsById.get(selection.bm25RunId);
    if (!bm25Run) {
      addEvidenceIssue(
        context,
        ["selections"],
        `Selection references an unknown BM25 run: ${selection.selectionId}`,
      );
      continue;
    }
    const expectedChunkIds =
      selection.rankingSource === "bm25"
        ? bm25Run.candidates
            .slice(0, selection.selectionLimit)
            .map((candidate) => candidate.chunkId)
        : selection.rankingSource === "bm25_with_scope_pins"
          ? (() => {
              const pins = selection.pinnedChunkIds ?? [];
              if (pins.length === 0) return undefined;
              const selected: string[] = [...pins];
              const seen = new Set(selected);
              for (const candidate of bm25Run.candidates) {
                if (selected.length >= selection.selectionLimit) break;
                if (seen.has(candidate.chunkId)) continue;
                selected.push(candidate.chunkId);
                seen.add(candidate.chunkId);
              }
              return selected;
            })()
          : (() => {
              const rerankRun = selection.rerankRunId
                ? rerankRunsById.get(selection.rerankRunId)
                : undefined;
              if (
                !rerankRun ||
                rerankRun.status !== "completed" ||
                rerankRun.bm25RunId !== bm25Run.bm25RunId
              ) {
                return undefined;
              }
              return rerankRun.results
                .slice(0, selection.selectionLimit)
                .map((result) => result.chunkId);
            })();
    if (
      !expectedChunkIds ||
      !sameIdentifierSequence(selection.selectedChunkIds, expectedChunkIds)
    ) {
      addEvidenceIssue(
        context,
        ["selections"],
        `Selection does not preserve the top entries of its declared ranking: ${selection.selectionId}`,
      );
    }
    if (selection.rankingSource === "bm25_with_scope_pins") {
      const corpus = corporaById.get(bm25Run.corpusId);
      const pinSet = new Set(selection.pinnedChunkIds ?? []);
      if (
        !corpus ||
        [...pinSet].some(
          (chunkId) =>
            !corpus.chunks.some((chunk) => chunk.chunkId === chunkId),
        )
      ) {
        addEvidenceIssue(
          context,
          ["selections"],
          `Scope-pinned selection references chunks outside its corpus: ${selection.selectionId}`,
        );
      }
    }
  }

  const usedQueryIds = new Set<string>();
  const usedCorpusIds = new Set<string>();
  const usedBm25RunIds = new Set<string>();
  const usedRerankRunIds = new Set<string>();
  const usedSelectionIds = new Set<string>();
  for (const outcome of payload.records) {
    const query = queriesById.get(outcome.queryId);
    if (
      !query ||
      query.familyId !== outcome.familyId ||
      (query.source === "occurrence-local-claims" &&
        query.citationOccurrenceId !== outcome.citationOccurrenceId) ||
      (outcome.primaryQuerySource != null &&
        outcome.primaryQuerySource !== query.source)
    ) {
      addEvidenceIssue(
        context,
        ["records"],
        `Evidence outcome references a dangling or cross-family query: ${outcome.recordId}`,
      );
    } else {
      usedQueryIds.add(query.queryId);
    }
    if (outcome.fallbackQueryId) {
      const fallbackQuery = queriesById.get(outcome.fallbackQueryId);
      if (
        !fallbackQuery ||
        fallbackQuery.familyId !== outcome.familyId ||
        fallbackQuery.source !== "scope-family-tracked-claim"
      ) {
        addEvidenceIssue(
          context,
          ["records"],
          `Evidence outcome references a dangling or cross-family fallback query: ${outcome.recordId}`,
        );
      } else {
        usedQueryIds.add(fallbackQuery.queryId);
      }
    }
    validateEvidenceOutcomeReferences(
      outcome,
      query,
      payload.rerankingPolicy,
      corporaById,
      bm25RunsById,
      rerankRunsById,
      selectionsById,
      context,
    );
    if (outcome.corpusId) usedCorpusIds.add(outcome.corpusId);
    if (outcome.bm25RunId) usedBm25RunIds.add(outcome.bm25RunId);
    for (const componentBm25RunId of outcome.componentBm25RunIds ?? []) {
      if (!bm25RunsById.has(componentBm25RunId)) {
        addEvidenceIssue(
          context,
          ["records"],
          `Evidence outcome references an unknown component BM25 run: ${outcome.recordId}`,
        );
      }
      usedBm25RunIds.add(componentBm25RunId);
    }
    if (outcome.rerankRunId) usedRerankRunIds.add(outcome.rerankRunId);
    if (outcome.finalSelectionId) {
      usedSelectionIds.add(outcome.finalSelectionId);
    }
  }

  for (const query of payload.queries) {
    if (!usedQueryIds.has(query.queryId)) {
      addEvidenceIssue(
        context,
        ["queries"],
        `Evidence query has no prepared record outcome: ${query.queryId}`,
      );
    }
  }
  for (const corpus of payload.corpora) {
    if (!usedCorpusIds.has(corpus.corpusId)) {
      addEvidenceIssue(
        context,
        ["corpora"],
        `Evidence corpus has no record outcome: ${corpus.corpusId}`,
      );
    }
  }
  for (const run of payload.bm25Runs) {
    if (!usedBm25RunIds.has(run.bm25RunId)) {
      addEvidenceIssue(
        context,
        ["bm25Runs"],
        `BM25 run has no record outcome: ${run.bm25RunId}`,
      );
    }
  }
  for (const run of payload.rerankRuns) {
    if (!usedRerankRunIds.has(run.rerankRunId)) {
      addEvidenceIssue(
        context,
        ["rerankRuns"],
        `Rerank run has no record outcome: ${run.rerankRunId}`,
      );
    }
  }
  for (const selection of payload.selections) {
    if (!usedSelectionIds.has(selection.selectionId)) {
      addEvidenceIssue(
        context,
        ["selections"],
        `Final selection has no record outcome: ${selection.selectionId}`,
      );
    }
  }
}

function validateEvidenceOutcomeReferences(
  outcome: EvidenceRecordOutcome,
  query: EvidenceQuery | undefined,
  rerankingPolicy: EvidenceRerankingPolicy,
  corporaById: ReadonlyMap<string, EvidenceChunkCorpus>,
  bm25RunsById: ReadonlyMap<string, EvidenceBm25Run>,
  rerankRunsById: ReadonlyMap<string, EvidenceRerankRun>,
  selectionsById: ReadonlyMap<string, EvidenceSelection>,
  context: z.RefinementCtx,
): void {
  const corpus = outcome.corpusId
    ? corporaById.get(outcome.corpusId)
    : undefined;
  const bm25Run = outcome.bm25RunId
    ? bm25RunsById.get(outcome.bm25RunId)
    : undefined;
  const rerankRun = outcome.rerankRunId
    ? rerankRunsById.get(outcome.rerankRunId)
    : undefined;
  const selection = outcome.finalSelectionId
    ? selectionsById.get(outcome.finalSelectionId)
    : undefined;

  if (
    corpus &&
    (corpus.seedId !== outcome.seedId ||
      (bm25Run != null &&
        (bm25Run.corpusId !== corpus.corpusId ||
          query == null ||
          canonicalSha256(bm25Run.queryText) !== query.contentHash)) ||
      (selection != null && selection.bm25RunId !== bm25Run?.bm25RunId))
  ) {
    addEvidenceIssue(
      context,
      ["records"],
      `Evidence outcome products do not share one query and corpus: ${outcome.recordId}`,
    );
  }

  for (const componentBm25RunId of outcome.componentBm25RunIds ?? []) {
    const component = bm25RunsById.get(componentBm25RunId);
    if (component && component.corpusId !== outcome.corpusId) {
      addEvidenceIssue(
        context,
        ["records"],
        `Evidence outcome component BM25 runs must share its corpus: ${outcome.recordId}`,
      );
    }
  }

  if (outcome.retrievalStatus === "retrieved") {
    if (
      !corpus ||
      !bm25Run ||
      bm25Run.status !== "matched" ||
      !selection ||
      selection.selectedChunkIds.length === 0 ||
      outcome.failure != null ||
      outcome.finalSelectionId == null
    ) {
      addEvidenceIssue(
        context,
        ["records"],
        `Retrieved Evidence requires matched BM25 and a nonempty exact final selection: ${outcome.recordId}`,
      );
    }
  } else if (outcome.retrievalStatus === "no_lexical_matches") {
    if (
      !corpus ||
      !bm25Run ||
      bm25Run.status !== "no_lexical_matches" ||
      selection != null ||
      outcome.finalSelectionId != null ||
      outcome.rerankRunId != null ||
      outcome.failure != null
    ) {
      addEvidenceIssue(
        context,
        ["records"],
        `No lexical matches must retain BM25 without claiming a final selection: ${outcome.recordId}`,
      );
    }
  } else if (outcome.retrievalStatus === "retrieval_failed") {
    if (
      outcome.failure == null ||
      outcome.bm25RunId != null ||
      outcome.componentBm25RunIds != null ||
      outcome.rerankRunId != null ||
      outcome.finalSelectionId != null
    ) {
      addEvidenceIssue(
        context,
        ["records"],
        `Retrieval failure must remain typed and cannot claim a ranking: ${outcome.recordId}`,
      );
    }
  } else if (
    outcome.corpusId != null ||
    outcome.bm25RunId != null ||
    outcome.componentBm25RunIds != null ||
    outcome.rerankRunId != null ||
    outcome.finalSelectionId != null ||
    outcome.failure != null
  ) {
    addEvidenceIssue(
      context,
      ["records"],
      `Unavailable seed text cannot claim retrieval products: ${outcome.recordId}`,
    );
  }

  if (!rerankingPolicy.enabled) {
    if (outcome.rerankStatus !== "disabled" || outcome.rerankRunId != null) {
      addEvidenceIssue(
        context,
        ["records"],
        `Disabled reranking cannot carry execution provenance: ${outcome.recordId}`,
      );
    }
    if (
      selection &&
      selection.rankingSource !== "bm25" &&
      selection.rankingSource !== "bm25_with_scope_pins"
    ) {
      addEvidenceIssue(
        context,
        ["records"],
        `Disabled reranking requires deterministic BM25 selection: ${outcome.recordId}`,
      );
    }
    return;
  }

  switch (outcome.rerankStatus) {
    case "completed":
      if (
        !rerankRun ||
        rerankRun.status !== "completed" ||
        selection?.rankingSource !== "reranked" ||
        selection.rerankRunId !== rerankRun.rerankRunId
      ) {
        addEvidenceIssue(
          context,
          ["records"],
          `Completed reranking must use its separate immutable ranking: ${outcome.recordId}`,
        );
      }
      break;
    case "failed":
      if (
        !rerankRun ||
        rerankRun.status !== "failed" ||
        (selection?.rankingSource !== "bm25" &&
          selection?.rankingSource !== "bm25_with_scope_pins")
      ) {
        addEvidenceIssue(
          context,
          ["records"],
          `Nonfatal rerank failure must remain explicit while selecting from BM25: ${outcome.recordId}`,
        );
      }
      break;
    case "not_attempted_no_candidates":
      if (
        outcome.rerankRunId != null ||
        bm25Run?.status !== "no_lexical_matches" ||
        outcome.finalSelectionId != null ||
        selection != null
      ) {
        addEvidenceIssue(
          context,
          ["records"],
          `No-candidate rerank status requires an empty BM25 result: ${outcome.recordId}`,
        );
      }
      break;
    case "not_attempted_unavailable":
      if (
        outcome.retrievalStatus !== "seed_text_unavailable" &&
        outcome.retrievalStatus !== "seed_acquisition_failed"
      ) {
        addEvidenceIssue(
          context,
          ["records"],
          `Unavailable rerank status requires unavailable seed text: ${outcome.recordId}`,
        );
      }
      break;
    case "not_attempted_retrieval_failure":
      if (outcome.retrievalStatus !== "retrieval_failed") {
        addEvidenceIssue(
          context,
          ["records"],
          `Rerank retrieval-failure status requires typed retrieval failure: ${outcome.recordId}`,
        );
      }
      break;
    case "disabled":
      addEvidenceIssue(
        context,
        ["records"],
        `Enabled reranking cannot emit disabled status: ${outcome.recordId}`,
      );
      break;
  }
}

function validateEvidenceArtifactLineage(
  artifact: z.infer<typeof commonLeanArtifactEnvelopeSchema> & {
    canonicalStage: "evidence";
    payload: EvidenceArtifactPayload;
  },
  context: z.RefinementCtx,
): void {
  const { lineage } = artifact.payload;
  if (artifact.runId !== lineage.runId) {
    addEvidenceIssue(
      context,
      ["payload", "lineage", "runId"],
      "Evidence run ID must match its verified Prepare and Scope lineage",
    );
  }
  if (
    artifact.inputArtifacts.length !== 2 ||
    !sameArtifactReference(
      artifact.inputArtifacts[0],
      lineage.prepareArtifact,
    ) ||
    !sameArtifactReference(artifact.inputArtifacts[1], lineage.scopeArtifact)
  ) {
    addEvidenceIssue(
      context,
      ["inputArtifacts"],
      "Evidence must reference exact canonical Prepare and Scope inputs",
    );
  }
  if (artifact.exclusions.length !== 0) {
    addEvidenceIssue(
      context,
      ["exclusions"],
      "Evidence performs complete accounting and cannot exclude Prepare records",
    );
  }
  if (artifact.decisions.length !== artifact.payload.records.length * 3) {
    addEvidenceIssue(
      context,
      ["decisions"],
      "Evidence must record retrieval, rerank, and final-selection decisions for every Prepare record",
    );
  }
  for (const record of artifact.payload.records) {
    for (const decisionType of [
      "evidence_retrieval_outcome",
      "evidence_rerank_outcome",
      "evidence_final_selection",
    ]) {
      const matching = artifact.decisions.filter(
        (decision) =>
          decision.recordId === record.recordId &&
          decision.decisionType === decisionType,
      );
      if (
        matching.length !== 1 ||
        matching.some(
          (decision) =>
            !hasArtifactReference(
              decision.evidenceArtifacts,
              lineage.prepareArtifact,
            ) ||
            !hasArtifactReference(
              decision.evidenceArtifacts,
              lineage.scopeArtifact,
            ),
        )
      ) {
        addEvidenceIssue(
          context,
          ["decisions"],
          `Evidence decision is missing or lacks exact input lineage: ${record.recordId} ${decisionType}`,
        );
      }
    }
  }

  const executions = artifact.payload.rerankRuns.map((run) => run.execution);
  const expectedPrompts = uniqueCanonicalValues(
    executions.map((execution) => ({
      promptId: execution.promptId,
      version: execution.promptVersion,
      contentHash: execution.promptContentHash,
    })),
  );
  const expectedModels = uniqueCanonicalValues(
    executions.map((execution) => ({
      provider: execution.provider,
      model: execution.model,
      requestHash: execution.requestHash,
      requestArtifact: execution.requestArtifact,
      responseArtifact: execution.responseArtifact,
    })),
  );
  if (
    canonicalSerialize(uniqueCanonicalValues(artifact.provenance.prompts)) !==
    canonicalSerialize(expectedPrompts)
  ) {
    addEvidenceIssue(
      context,
      ["provenance", "prompts"],
      "Evidence prompt provenance must exactly cover reranking",
    );
  }
  if (
    canonicalSerialize(uniqueCanonicalValues(artifact.provenance.models)) !==
    canonicalSerialize(expectedModels)
  ) {
    addEvidenceIssue(
      context,
      ["provenance", "models"],
      "Evidence model provenance must exactly cover reranking",
    );
  }
  if (executions.length === 0) {
    if (artifact.execution.kind !== "deterministic") {
      addEvidenceIssue(
        context,
        ["execution"],
        "Evidence without reranker execution must be replayable and deterministic",
      );
    }
  } else if (
    artifact.execution.kind !== "model" ||
    canonicalSerialize(
      uniqueCanonicalValues(artifact.execution.responseArtifacts),
    ) !==
      canonicalSerialize(
        uniqueCanonicalValues(
          executions.map((execution) => execution.responseArtifact),
        ),
      )
  ) {
    addEvidenceIssue(
      context,
      ["execution"],
      "Evidence reranking must be non-replayable and reference every response",
    );
  }
}

function validateScoreOrdering<T>(
  values: readonly T[],
  getScore: (value: T) => number,
  getTieBreaker: (value: T) => string,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < values.length; index++) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    const previousScore = getScore(previous);
    const currentScore = getScore(current);
    if (
      currentScore > previousScore ||
      (currentScore === previousScore &&
        compareCodeUnits(getTieBreaker(previous), getTieBreaker(current)) > 0)
    ) {
      context.addIssue({
        code: "custom",
        path,
        message:
          "Ranking scores must descend with deterministic identifier tie-breaking",
      });
      return;
    }
  }
}

function addEvidenceIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function prepareClassificationReason(
  classification: PrepareClassification,
): string {
  return classification.status === "failed"
    ? classification.reason
    : classification.rationale;
}

function uniqueCanonicalValues<T>(values: readonly T[]): T[] {
  const byCanonicalValue = new Map<string, T>();
  for (const value of values) {
    byCanonicalValue.set(canonicalSerialize(value), value);
  }
  return [...byCanonicalValue.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, value]) => value);
}

function addPrepareIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateFamilyGroundingAgainstSeedText(
  family: ScopedFamily,
  materialization: ScopeSeedMaterialization,
  context: z.RefinementCtx,
): void {
  if (materialization.status === "seed_text_unavailable") {
    if (family.grounding.status !== "seed_text_unavailable") {
      addScopeIssue(
        context,
        ["families"],
        `Grounding must preserve seed-text unavailability: ${family.familyId}`,
      );
    }
    return;
  }
  if (materialization.status === "acquisition_failed") {
    if (family.grounding.status !== "acquisition_failed") {
      addScopeIssue(
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
    addScopeIssue(
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
      addScopeIssue(
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
      addScopeIssue(
        context,
        ["families"],
        `Grounding evidence is not an exact span of seed-text block ${span.blockId}`,
      );
    }
    if (
      span.blockKind !== block.blockKind ||
      span.sectionTitle !== block.sectionTitle
    ) {
      addScopeIssue(
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
      addScopeIssue(
        context,
        ["families"],
        `Grounding evidence does not reference its immutable seed-text artifact: ${span.blockId}`,
      );
    }
  }
}

function validateScopeArtifactLineage(
  artifact: z.infer<typeof commonLeanArtifactEnvelopeSchema> & {
    canonicalStage: "scope";
    payload: ScopeArtifactPayload;
  },
  context: z.RefinementCtx,
): void {
  if (
    artifact.inputArtifacts.length !== 1 ||
    !sameArtifactReference(
      artifact.inputArtifacts[0],
      artifact.payload.discoverArtifact,
    )
  ) {
    addScopeIssue(
      context,
      ["inputArtifacts"],
      "Scope must have exactly one immutable canonical Discover input",
    );
  }

  for (const candidate of artifact.payload.candidateDecisions) {
    const expectedOutcome =
      candidate.disposition === "scoped" ? "scoped" : "deferred_upstream";
    const matchingDecisions = artifact.decisions.filter(
      (decision) =>
        decision.recordId === candidate.candidateId &&
        decision.decisionType === "scope_candidate_disposition" &&
        decision.outcome === expectedOutcome &&
        decision.reason === candidate.discoverReason,
    );
    if (matchingDecisions.length !== 1) {
      addScopeIssue(
        context,
        ["decisions"],
        `Scope candidate disposition is not accounted for exactly once: ${candidate.candidateId}`,
      );
    }
  }

  const expectedResponseArtifacts: ArtifactReference[] = [];
  for (const materialization of artifact.payload.seedMaterializations) {
    if (materialization.execution.kind === "external") {
      expectedResponseArtifacts.push(
        materialization.execution.responseArtifact,
      );
    }
  }
  for (const family of artifact.payload.families) {
    const modelExecution = family.grounding.modelExecution;
    if (!modelExecution) continue;
    expectedResponseArtifacts.push(modelExecution.responseArtifact);
    const hasPrompt = artifact.provenance.prompts.some(
      (prompt) =>
        prompt.promptId === modelExecution.promptId &&
        prompt.version === modelExecution.promptVersion &&
        prompt.contentHash === modelExecution.promptContentHash,
    );
    if (!hasPrompt) {
      addScopeIssue(
        context,
        ["provenance", "prompts"],
        `Scope grounding prompt provenance is incomplete: ${family.familyId}`,
      );
    }
    const hasModel = artifact.provenance.models.some(
      (model) =>
        model.provider === modelExecution.provider &&
        model.model === modelExecution.model &&
        model.requestHash === modelExecution.requestHash &&
        sameArtifactReference(
          model.requestArtifact,
          modelExecution.requestArtifact,
        ) &&
        sameArtifactReference(
          model.responseArtifact,
          modelExecution.responseArtifact,
        ),
    );
    if (!hasModel) {
      addScopeIssue(
        context,
        ["provenance", "models"],
        `Scope grounding model provenance is incomplete: ${family.familyId}`,
      );
    }
  }
  if (expectedResponseArtifacts.length > 0) {
    if (artifact.execution.kind === "deterministic") {
      addScopeIssue(
        context,
        ["execution"],
        "Scope with external/model responses cannot claim deterministic replay",
      );
    } else {
      for (const responseArtifact of expectedResponseArtifacts) {
        if (
          !hasArtifactReference(
            artifact.execution.responseArtifacts,
            responseArtifact,
          )
        ) {
          addScopeIssue(
            context,
            ["execution", "responseArtifacts"],
            `Scope execution is missing response provenance: ${responseArtifact.artifactId}`,
          );
        }
      }
    }
  }
}

function addScopeIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
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

function addSortedUniqueIdentifierIssue(
  values: readonly string[],
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  addDuplicateIdentifierIssue(values, path, context);
  if (!sameIdentifierSequence(values, [...values].sort(compareCodeUnits))) {
    context.addIssue({
      code: "custom",
      path,
      message: "Stable identifier references must be sorted deterministically",
    });
  }
}

function sameIdentifierSequence(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasArtifactReference(
  references: readonly ArtifactReference[],
  expected: ArtifactReference,
): boolean {
  return references.some((reference) =>
    sameArtifactReference(reference, expected),
  );
}

function sameArtifactReference(
  left: ArtifactReference | undefined,
  right: ArtifactReference,
): boolean {
  return left != null && canonicalSerialize(left) === canonicalSerialize(right);
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

function buildCitationSourceLocation(input: {
  mentionIndex: number;
  charOffsetStart?: number | undefined;
  charOffsetEnd?: number | undefined;
  sourceLocator?: CitationSourceLocator | undefined;
  citationMarker: string;
  rawContext: string;
}) {
  if (input.sourceLocator) {
    return {
      kind: "source_locator",
      locator: input.sourceLocator,
    };
  }
  if (input.charOffsetStart != null && input.charOffsetEnd != null) {
    return {
      kind: "char_offsets",
      start: input.charOffsetStart,
      end: input.charOffsetEnd,
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
  if (input.sourceLocator) {
    return "strong_source_locator";
  }
  if (input.charOffsetStart != null && input.charOffsetEnd != null) {
    return "strong_source_offsets";
  }
  return "weak_context_fallback";
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
