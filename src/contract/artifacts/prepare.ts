/**
 * Prepare artifact payload: one stable record per scoped family and
 * citation occurrence, with its typed classification.
 */
import { z } from "zod";

import type { Result } from "../../domain/common.js";

import {
  confidenceSchema,
  evaluationModeSchema,
} from "../../domain/classification.js";
import {
  buildStableId,
  canonicalSerialize,
} from "../../shared/stable-identity.js";
import {
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
} from "./primitives.js";
import { modelExecutionSchema } from "../model-execution.js";
import { addIssue, findDuplicate } from "./checks.js";
import {
  discoverCitationOccurrenceSchema,
  discoverCitingPaperRecordSchema,
  discoverSeedSchema,
  discoverAttributedClaimRecordSchema,
  discoverClaimCandidateSchema,
  type DiscoverAttributedClaimRecord,
  type DiscoverCitingPaperRecord,
  type DiscoverClaimCandidate,
  type DiscoverSeed,
} from "./discover.js";
import { scopedFamilySchema, type ScopedFamily } from "./scope.js";

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

export const prepareClassificationFailureExecutionSchema = z.union([
  prepareExternalClassificationExecutionSchema,
  modelExecutionSchema,
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

export const prepareClassificationSchema = z.discriminatedUnion("status", [
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
]);
export type PrepareClassification = z.infer<typeof prepareClassificationSchema>;

const prepareScopeArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("scope-input"),
    stage: z.literal("scope"),
  })
  .strict();

const prepareDiscoverArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("discover-input"),
    stage: z.literal("discover"),
  })
  .strict();

const prepareLineageSchema = z
  .object({
    runId: z.string().min(1),
    scopeArtifact: prepareScopeArtifactReferenceSchema,
    discoverArtifact: prepareDiscoverArtifactReferenceSchema,
  })
  .strict();

/**
 * One scoped family × citation occurrence. The record carries only what is
 * local to the occurrence: the occurrence itself, which of its family's
 * candidates and claims belong to it (by id), and its classification. Family,
 * seed, citing-paper, candidate, and claim data live once on the payload and
 * are joined back with `resolvePreparedRecords`, so a record's size does not
 * grow with its family's.
 */
export const preparedCitationInstanceSchema = z
  .object({
    recordId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    /** Family candidates whose membership includes this occurrence, in family order. */
    occurrenceSourceCandidateIds: z.array(stableIdentifierSchema).min(1),
    /** Family claims attributed at this occurrence, in family order. */
    occurrenceSourceClaimRecordIds: z.array(stableIdentifierSchema).min(1),
    citationOccurrence: discoverCitationOccurrenceSchema,
    classification: prepareClassificationSchema,
  })
  .strict();
export type PreparedCitationInstance = z.infer<
  typeof preparedCitationInstanceSchema
>;

export const prepareArtifactPayloadSchema = z
  .object({
    lineage: prepareLineageSchema,
    /** Discover seeds of the scoped families, ordered by seedId. */
    seeds: z.array(discoverSeedSchema),
    scopedFamilies: z.array(scopedFamilySchema),
    /** Every scoped family's Discover candidates, once, ordered by candidateId. */
    sourceCandidates: z.array(discoverClaimCandidateSchema),
    /** Every scoped family's Discover claims, once, ordered by claimRecordId. */
    sourceClaimRecords: z.array(discoverAttributedClaimRecordSchema),
    /** Discover citing papers of the prepared occurrences, ordered by record ID. */
    citingPapers: z.array(discoverCitingPaperRecordSchema),
    records: z.array(preparedCitationInstanceSchema),
  })
  .strict()
  .superRefine(validatePreparePayload);
export type PrepareArtifactPayload = z.infer<
  typeof prepareArtifactPayloadSchema
>;

/**
 * A Prepare record joined to the family-level data it refers to. Every field
 * is a reference into the payload, not a copy.
 */
export type ResolvedPreparedCitationInstance = PreparedCitationInstance & {
  family: ScopedFamily;
  seed: DiscoverSeed;
  citingPaper: DiscoverCitingPaperRecord;
  sourceCandidates: DiscoverClaimCandidate[];
  sourceClaimRecords: DiscoverAttributedClaimRecord[];
  occurrenceSourceCandidates: DiscoverClaimCandidate[];
  occurrenceSourceClaimRecords: DiscoverAttributedClaimRecord[];
};

/**
 * Join each record to its family, seed, citing paper, candidates, and claims.
 * The payload schema guarantees every reference resolves, so a miss here is a
 * programmer error (an unvalidated payload) and throws.
 */
export function resolvePreparedRecords(
  payload: PrepareArtifactPayload,
): ResolvedPreparedCitationInstance[] {
  const index = indexPreparePayload(payload);
  return payload.records.map((record) => {
    const resolved = resolveRecord(record, index);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.data;
  });
}

type PreparePayloadIndex = {
  familiesById: Map<string, ScopedFamily>;
  seedsById: Map<string, DiscoverSeed>;
  candidatesById: Map<string, DiscoverClaimCandidate>;
  claimsById: Map<string, DiscoverAttributedClaimRecord>;
  citingPapersById: Map<string, DiscoverCitingPaperRecord>;
};

function indexPreparePayload(
  payload: PrepareArtifactPayload,
): PreparePayloadIndex {
  return {
    familiesById: new Map(
      payload.scopedFamilies.map((family) => [family.familyId, family]),
    ),
    seedsById: new Map(payload.seeds.map((seed) => [seed.seedId, seed])),
    candidatesById: new Map(
      payload.sourceCandidates.map((candidate) => [
        candidate.candidateId,
        candidate,
      ]),
    ),
    claimsById: new Map(
      payload.sourceClaimRecords.map((claim) => [claim.claimRecordId, claim]),
    ),
    citingPapersById: new Map(
      payload.citingPapers.map((paper) => [paper.citingPaperRecordId, paper]),
    ),
  };
}

function resolveAll<T>(
  ids: readonly string[],
  byId: ReadonlyMap<string, T>,
  label: string,
): Result<T[]> {
  const resolved: T[] = [];
  for (const id of ids) {
    const value = byId.get(id);
    if (value === undefined) {
      return { ok: false, error: `Unknown ${label}: ${id}` };
    }
    resolved.push(value);
  }
  return { ok: true, data: resolved };
}

function resolveRecord(
  record: PreparedCitationInstance,
  index: PreparePayloadIndex,
): Result<ResolvedPreparedCitationInstance> {
  const family = index.familiesById.get(record.familyId);
  if (!family) {
    return {
      ok: false,
      error: `Prepare record references an unknown Scope family: ${record.familyId}`,
    };
  }
  const seed = index.seedsById.get(family.seedId);
  if (!seed) {
    return {
      ok: false,
      error: `Prepare family references an unknown seed: ${family.seedId}`,
    };
  }
  const citingPaper = index.citingPapersById.get(
    record.citationOccurrence.citingPaperRecordId,
  );
  if (!citingPaper) {
    return {
      ok: false,
      error: `Prepare record references an unknown citing paper: ${record.citationOccurrence.citingPaperRecordId}`,
    };
  }
  const sourceCandidates = resolveAll(
    family.candidateIds,
    index.candidatesById,
    "Prepare source candidate",
  );
  if (!sourceCandidates.ok) return sourceCandidates;
  const sourceClaimRecords = resolveAll(
    family.sourceClaimRecordIds,
    index.claimsById,
    "Prepare source claim",
  );
  if (!sourceClaimRecords.ok) return sourceClaimRecords;
  const occurrenceSourceCandidates = resolveAll(
    record.occurrenceSourceCandidateIds,
    index.candidatesById,
    "Prepare occurrence candidate",
  );
  if (!occurrenceSourceCandidates.ok) return occurrenceSourceCandidates;
  const occurrenceSourceClaimRecords = resolveAll(
    record.occurrenceSourceClaimRecordIds,
    index.claimsById,
    "Prepare occurrence claim",
  );
  if (!occurrenceSourceClaimRecords.ok) return occurrenceSourceClaimRecords;
  return {
    ok: true,
    data: {
      ...record,
      family,
      seed,
      citingPaper,
      sourceCandidates: sourceCandidates.data,
      sourceClaimRecords: sourceClaimRecords.data,
      occurrenceSourceCandidates: occurrenceSourceCandidates.data,
      occurrenceSourceClaimRecords: occurrenceSourceClaimRecords.data,
    },
  };
}

function validatePreparePayload(
  payload: PrepareArtifactPayload,
  context: z.RefinementCtx,
): void {
  const pairKeys = payload.records.map((record) =>
    canonicalSerialize({
      familyId: record.familyId,
      citationOccurrenceId: record.citationOccurrenceId,
    }),
  );
  const duplicatePair = findDuplicate(pairKeys);
  if (duplicatePair) {
    addIssue(
      context,
      ["records"],
      `Duplicate prepared family × occurrence pair: ${duplicatePair}`,
    );
  }

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
      addIssue(
        context,
        ["records"],
        `Missing Prepare outcome for scoped pair: ${pairKey}`,
      );
    }
  }
  for (const pairKey of actualPairKeys) {
    if (!expectedPairKeys.has(pairKey)) {
      addIssue(
        context,
        ["records"],
        `Prepare record is outside frozen Scope membership: ${pairKey}`,
      );
    }
  }

  const index = indexPreparePayload(payload);
  for (const [recordIndex, record] of payload.records.entries()) {
    const resolved = resolveRecord(record, index);
    if (!resolved.ok) {
      addIssue(context, ["records", recordIndex], resolved.error);
      continue;
    }
    if (resolved.data.seed.resolution.status !== "resolved") {
      addIssue(
        context,
        ["records", recordIndex, "familyId"],
        "A prepared citation occurrence requires a resolved Discover seed paper",
      );
    }
  }
}
