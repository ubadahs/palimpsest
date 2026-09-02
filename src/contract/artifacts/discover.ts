/**
 * Canonical Discover artifact payload: the lossless ledger of seeds, the
 * citing neighborhood, citation occurrences, attributed claims, and candidates.
 */
import { z } from "zod";

import { paperTypeSchema } from "../../domain/common.js";
import { buildStableId } from "../../shared/stable-identity.js";
import { normalizeDiscoverClaimText } from "../claim-unit.js";
import {
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
} from "../lean-artifact-primitives.js";
import { modelExecutionSchema } from "../model-execution.js";
import {
  addDuplicateIdentifierIssue,
  findDuplicate,
  normalizeDoi,
  normalizeWhitespace,
  sortedUniqueIdentifiers,
} from "./checks.js";

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
      /** Sampling stratum used by the deterministic probe budget. */
      stratum: z
        .object({
          yearBand: z.string().min(1),
          paperType: z.string().min(1),
        })
        .strict()
        .optional(),
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

/**
 * How a candidate's member claims were judged equivalent. Exact text grouping
 * is the deterministic fallback; the model method clusters paraphrases across
 * citers so that a family is one seed finding, not one wording of it.
 */
export const discoverClaimEquivalenceSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("exact_normalized_text"),
      fallbackReason: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("model"),
      execution: modelExecutionSchema,
      /** Set when unknown, duplicate, or omitted claims were repaired deterministically. */
      repairNote: z.string().min(1).optional(),
    })
    .strict(),
]);
export type DiscoverClaimEquivalence = z.infer<
  typeof discoverClaimEquivalenceSchema
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
    equivalence: discoverClaimEquivalenceSchema.optional(),
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

function addDiscoverLedgerIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
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
