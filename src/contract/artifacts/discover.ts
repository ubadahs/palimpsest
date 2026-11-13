/**
 * Discover artifact payload: the lossless ledger of seeds, the
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
} from "./primitives.js";
import { modelExecutionSchema } from "../model-execution.js";
import { sortedUnique } from "../../shared/order.js";
import {
  addDuplicateIdentifierIssue,
  addIssue,
  normalizeDoi,
  normalizeWhitespace,
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
    sourceClaimRecordIds: sortedUnique(input.sourceClaimRecordIds),
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
  .strict();
export type DiscoverSeed = z.infer<typeof discoverSeedSchema>;

/**
 * Paper types grouped for sampling. Provider types run to a long tail
 * (errata, editorials, paratext) that would each become a stratum of a
 * handful of works; three groups keep strata large enough to estimate.
 */
export const probeTypeGroupValues = ["article", "review", "other"] as const;
export type ProbeTypeGroup = (typeof probeTypeGroupValues)[number];

export function probeTypeGroupOf(
  paperType: string | undefined,
): ProbeTypeGroup {
  if (paperType === "article" || paperType === "preprint") return "article";
  if (paperType === "review") return "review";
  return "other";
}

/**
 * The sampling frame: citing works not known to lack readable full text.
 * The sampler draws from the frame first and weighted rates describe the
 * frame only, because works the provider marks closed or abstract-only are
 * mostly never read, so they could not be represented by a random draw.
 */
export function isInSamplingFrame(
  fullTextAvailability:
    | "available"
    | "abstract_only"
    | "unavailable"
    | "unknown",
): boolean {
  return (
    fullTextAvailability === "available" || fullTextAvailability === "unknown"
  );
}

/**
 * One probe-sampling stratum of a neighborhood: how many citing works the
 * enumeration found in it, how many of those are in the sampling frame, how
 * many were probed in all and from the frame, and the inclusion probability
 * probedFrameCount / frameCount that Report weights records by (null when
 * the stratum has no frame works).
 */
export const discoverProbeStratumSchema = z
  .object({
    yearBand: z.string().min(1),
    typeGroup: z.enum(probeTypeGroupValues),
    enumeratedCount: z.number().int().positive(),
    frameCount: z.number().int().nonnegative(),
    probedCount: z.number().int().nonnegative(),
    probedFrameCount: z.number().int().nonnegative(),
    inclusionProbability: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .superRefine((stratum, context) => {
    const expected =
      stratum.frameCount === 0
        ? null
        : stratum.probedFrameCount / stratum.frameCount;
    if (stratum.inclusionProbability !== expected) {
      addIssue(
        context,
        ["inclusionProbability"],
        "Inclusion probability must equal probedFrameCount / frameCount, or null for a stratum with no frame works",
      );
    }
  });
export type DiscoverProbeStratum = z.infer<typeof discoverProbeStratumSchema>;

export function probeStratumKeyOf(stratum: {
  yearBand: string;
  typeGroup: ProbeTypeGroup;
}): string {
  return `${stratum.yearBand}::${stratum.typeGroup}`;
}

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
    /** Probe strata over every enumerated citing work, ordered by stratum key. */
    probeStrata: z.array(discoverProbeStratumSchema),
    requestHash: sha256DigestSchema.optional(),
    requestArtifact: artifactReferenceSchema.optional(),
    responseArtifact: artifactReferenceSchema.optional(),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict();
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
    /**
     * How the citing paper's text was obtained and how its bibliography entry
     * for the seed was found. Both bear on whether an occurrence is real: a
     * proxy-acquired PDF parses differently from publisher JATS, and a fuzzy
     * title match can name the wrong reference.
     */
    acquisition: z
      .object({
        accessChannel: z.enum(["open_access", "institutional_proxy"]),
        fullTextFormat: z.string().min(1).optional(),
        selectedUrl: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    bibliographyMatch: z
      .object({
        method: z.enum([
          "doi",
          "author_year_exact_title",
          "author_year_title_overlap",
        ]),
        refId: z.string().min(1),
      })
      .strict()
      .optional(),
    probe: paperDispositionSchema.extend({
      status: z.enum(["selected", "not_selected"]),
      /** Sampling stratum used by the deterministic probe budget. */
      stratum: z
        .object({
          yearBand: z.string().min(1),
          typeGroup: z.enum(probeTypeGroupValues),
        })
        .strict(),
    }),
    materialization: paperDispositionSchema.extend({
      status: z.enum(["not_attempted", "succeeded", "unavailable", "failed"]),
    }),
    harvest: paperDispositionSchema.extend({
      status: z.enum(["not_attempted", "succeeded", "no_mentions", "failed"]),
      observedMentionCount: z.number().int().nonnegative(),
    }),
  })
  .strict();
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
    /**
     * How well the parser could place the marker in the source document:
     * `exact_dom` when it found the marker element itself, `approximate` when
     * it fell back to a text search, `missing` when it could not. This is the
     * parser's own judgement, not a restatement of which locator fields are
     * present, and it is the honest floor on how much to trust `rawContext`.
     */
    locationQuality: z.enum(["exact_dom", "approximate", "missing"]),
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
  .strict();
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
  .strict();
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
  .strict();
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
  .strict();
export type DiscoverAttributedClaimRecord = z.infer<
  typeof discoverAttributedClaimRecordSchema
>;

/**
 * One clustering request of the blocked equivalence pass. A request that
 * failed falls back without merging (exact text in a block, no joins in a
 * merge) and says why; a block of a single claim needs no request.
 */
function blockedClusteringCallSchemaWith<Shape extends z.ZodRawShape>(
  extra: Shape,
) {
  return z.discriminatedUnion("outcome", [
    z
      .object({
        ...extra,
        blockIndex: z.number().int().nonnegative(),
        outcome: z.literal("model"),
        execution: modelExecutionSchema,
        /** Set when unknown, duplicate, or omitted claims were repaired deterministically. */
        repairNote: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        ...extra,
        blockIndex: z.number().int().nonnegative(),
        outcome: z.literal("fallback"),
        execution: modelExecutionSchema,
        fallbackReason: z.string().min(1),
      })
      .strict(),
    z
      .object({
        ...extra,
        blockIndex: z.number().int().nonnegative(),
        outcome: z.literal("single_claim"),
      })
      .strict(),
  ]);
}
const blockedClusteringCallSchema = blockedClusteringCallSchemaWith({});
const blockedMergeCallSchema = blockedClusteringCallSchemaWith({
  /** Merge rounds count from 1; each round runs over the clusters the last left. */
  round: z.number().int().positive(),
});
export type BlockedClusteringCall = z.infer<typeof blockedClusteringCallSchema>;
export type BlockedMergeCall = z.infer<typeof blockedMergeCallSchema>;

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
  /**
   * Too many claims for one request: exact-text groups were split into
   * BM25-similar blocks, each block clustered by the model, and the block
   * clusters merged by further model calls over one representative claim per
   * cluster. The candidate names every call that judged its members.
   */
  z
    .object({
      method: z.literal("blocked_model"),
      /** Blocks the seed's claims were split into. */
      blockCount: z.number().int().positive(),
      /** The block calls that clustered this candidate's claims. */
      blocks: z.array(blockedClusteringCallSchema).min(1),
      /** Merge calls that saw a representative of this candidate's clusters. */
      merges: z.array(blockedMergeCallSchema),
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
    claim: z.string().min(1),
    normalizedClaim: z.string().min(1),
    memberMentionIds: z.array(stableIdentifierSchema).min(1),
    sourceClaimRecordIds: z.array(stableIdentifierSchema).min(1),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
    equivalence: discoverClaimEquivalenceSchema.optional(),
  })
  .strict();
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
  addDuplicateIdentifierIssue(
    payload.citingPapers.map((paper) => paper.citingPaperRecordId),
    ["citingPapers"],
    context,
  );
  addDuplicateIdentifierIssue(
    payload.citationMentions.map((mention) => mention.mentionId),
    ["citationMentions"],
    context,
  );

  const mentionsById = new Map(
    payload.citationMentions.map((mention) => [mention.mentionId, mention]),
  );
  const dispositionIds = new Set(
    payload.candidateDispositions.map((disposition) => disposition.candidateId),
  );

  const queryCountBySeed = new Map<string, number>();
  for (const query of payload.neighborhoodQueries) {
    queryCountBySeed.set(
      query.seedId,
      (queryCountBySeed.get(query.seedId) ?? 0) + 1,
    );
  }
  for (const seed of payload.seeds) {
    if (queryCountBySeed.get(seed.seedId) !== 1) {
      addIssue(
        context,
        ["neighborhoodQueries"],
        `Seed must have exactly one declared neighborhood boundary: ${seed.seedId}`,
      );
    }
  }

  const papersByNeighborhood = new Map<string, DiscoverCitingPaperRecord[]>();
  for (const paper of payload.citingPapers) {
    const papers = papersByNeighborhood.get(paper.neighborhoodId);
    if (papers) papers.push(paper);
    else papersByNeighborhood.set(paper.neighborhoodId, [paper]);
  }
  payload.neighborhoodQueries.forEach((query, index) => {
    const observedStrata = new Map<
      string,
      { enumerated: number; frame: number; probed: number; probedFrame: number }
    >();
    for (const paper of papersByNeighborhood.get(query.neighborhoodId) ?? []) {
      const key = probeStratumKeyOf(paper.probe.stratum);
      const bucket = observedStrata.get(key) ?? {
        enumerated: 0,
        frame: 0,
        probed: 0,
        probedFrame: 0,
      };
      const inFrame = isInSamplingFrame(paper.paper.fullTextAvailability);
      const probed = paper.probe.status === "selected";
      bucket.enumerated += 1;
      if (inFrame) bucket.frame += 1;
      if (probed) bucket.probed += 1;
      if (inFrame && probed) bucket.probedFrame += 1;
      observedStrata.set(key, bucket);
    }
    if (
      observedStrata.size !== query.probeStrata.length ||
      query.probeStrata.some((stratum) => {
        const observed = observedStrata.get(probeStratumKeyOf(stratum));
        return (
          observed == null ||
          observed.enumerated !== stratum.enumeratedCount ||
          observed.frame !== stratum.frameCount ||
          observed.probed !== stratum.probedCount ||
          observed.probedFrame !== stratum.probedFrameCount
        );
      })
    ) {
      addIssue(
        context,
        ["neighborhoodQueries", index, "probeStrata"],
        "Probe strata do not match the neighborhood's citing-paper probe ledger",
      );
    }
  });

  const extractionCountByMention = new Map<string, number>();
  for (const observation of payload.claimExtractionObservations) {
    extractionCountByMention.set(
      observation.mentionId,
      (extractionCountByMention.get(observation.mentionId) ?? 0) + 1,
    );
  }
  for (const mention of payload.citationMentions) {
    if (extractionCountByMention.get(mention.mentionId) !== 1) {
      addIssue(
        context,
        ["claimExtractionObservations"],
        `Citation occurrence must have exactly one extraction outcome: ${mention.mentionId}`,
      );
    }
  }

  payload.attributedClaimRecords.forEach((record, index) => {
    const mention = mentionsById.get(record.mentionId);
    if (!mention || !record.supportSpan) return;
    const slice = mention.rawContext.slice(
      record.supportSpan.charOffsetStart,
      record.supportSpan.charOffsetEnd,
    );
    if (slice !== record.supportSpan.text) {
      addIssue(
        context,
        ["attributedClaimRecords", index, "supportSpan"],
        "supportSpan text must exactly equal the occurrence rawContext slice at the stored offsets",
      );
    }
  });

  const claimCandidateMembershipCount = new Map<string, number>();
  for (const candidate of payload.claimCandidates) {
    for (const claimRecordId of candidate.sourceClaimRecordIds) {
      claimCandidateMembershipCount.set(
        claimRecordId,
        (claimCandidateMembershipCount.get(claimRecordId) ?? 0) + 1,
      );
    }
    if (!dispositionIds.has(candidate.candidateId)) {
      addIssue(
        context,
        ["candidateDispositions"],
        `Missing disposition for candidate: ${candidate.candidateId}`,
      );
    }
  }

  for (const record of payload.attributedClaimRecords) {
    if (claimCandidateMembershipCount.get(record.claimRecordId) !== 1) {
      addIssue(
        context,
        ["claimCandidates"],
        `Attributed claim record must belong to exactly one candidate: ${record.claimRecordId}`,
      );
    }
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
