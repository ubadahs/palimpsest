/**
 * Canonical Prepare artifact payload: one stable record per scoped family and
 * citation occurrence, with its typed classification.
 */
import { z } from "zod";

import {
  confidenceSchema,
  evaluationModeSchema,
  type CitationRole,
} from "../../domain/classification.js";
import {
  buildStableId,
  canonicalSerialize,
} from "../../shared/stable-identity.js";
import {
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
} from "../lean-artifact-primitives.js";
import { modelExecutionSchema } from "../model-execution.js";
import {
  addSortedUniqueIdentifierIssue,
  findDuplicate,
  sameArtifactReference,
  sameIdentifierSequence,
} from "./checks.js";
import {
  discoverCitationOccurrenceSchema,
  discoverCitingPaperRecordSchema,
  discoverSeedSchema,
  discoverAttributedClaimRecordSchema,
  discoverClaimCandidateSchema,
} from "./discover.js";
import { scopedFamilySchema } from "./scope.js";

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

function addPrepareIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function expectedPrepareEvaluationMode(
  role: CitationRole,
  modifiers: z.infer<typeof prepareClassificationModifiersSchema>,
  ambiguousMode: z.infer<typeof evaluationModeSchema>,
): z.infer<typeof evaluationModeSchema> {
  // An unclear role is unadjudicable whatever the transmission path, so the
  // manual-review queue wins over review mediation.
  if (role === "unclear") {
    return ambiguousMode === "manual_review_extraction_limited"
      ? "manual_review_extraction_limited"
      : "manual_review_role_ambiguous";
  }
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
  }
}
