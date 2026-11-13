import { z } from "zod";

import { compareCodeUnits } from "../../shared/order.js";
import { addDuplicateIdentifierIssue } from "./checks.js";

import { confidenceSchema } from "../../domain/classification.js";
import {
  fidelityVerdictSchema,
  mutationKindSchema,
  type FidelityVerdict,
  type MutationKind,
} from "../../domain/taxonomy.js";
import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../../shared/stable-identity.js";
import {
  artifactReferenceSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "./primitives.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "../model-execution.js";

/**
 * Adjudicate contract (isolated stage module). Shared envelope
 * primitives come from a cycle-free module; scientific stage contracts stay
 * outside that primitive boundary.
 */

export const adjudicateMethodId = "categorical-adjudicate-v2" as const;

export const adjudicateMethodSchema = z
  .object({
    methodId: z.literal(adjudicateMethodId),
    strategy: z.literal("single_categorical"),
    calibrationStatus: z.literal("uncalibrated"),
  })
  .strict();
export type AdjudicateMethod = z.infer<typeof adjudicateMethodSchema>;

export const adjudicateMethod: AdjudicateMethod = {
  methodId: adjudicateMethodId,
  strategy: "single_categorical",
  calibrationStatus: "uncalibrated",
};

const adjudicateEvidenceArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("evidence-input"),
    stage: z.literal("evidence"),
  })
  .strict();

const adjudicatePrepareArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("prepare-input"),
    stage: z.literal("prepare"),
  })
  .strict();

export const adjudicateLineageSchema = z
  .object({
    runId: z.string().min(1),
    evidenceArtifact: adjudicateEvidenceArtifactReferenceSchema,
    prepareArtifact: adjudicatePrepareArtifactReferenceSchema,
  })
  .strict();
export type AdjudicateLineage = z.infer<typeof adjudicateLineageSchema>;

export const adjudicateGateCodeSchema = z.enum([
  "seed_text_unavailable",
  "seed_acquisition_failed",
  "retrieval_failed",
  "no_lexical_matches",
  "classification_failed",
  "invalid_context",
  "skip_low_information",
  "manual_review_role_ambiguous",
  "manual_review_extraction_limited",
  "ambiguous_citation_role",
]);
export type AdjudicateGateCode = z.infer<typeof adjudicateGateCodeSchema>;

export const adjudicateFatalFailureCodeSchema = z.enum([
  "authentication",
  "authorization",
  "billing",
  "quota",
]);
export type AdjudicateFatalFailureCode = z.infer<
  typeof adjudicateFatalFailureCodeSchema
>;

export const adjudicateNonfatalFailureCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "transport",
  "invalid_response",
  "provider_failure",
]);
export type AdjudicateNonfatalFailureCode = z.infer<
  typeof adjudicateNonfatalFailureCodeSchema
>;

export const adjudicateFailureCodeSchema = z.union([
  adjudicateFatalFailureCodeSchema,
  adjudicateNonfatalFailureCodeSchema,
]);
export type AdjudicateFailureCode = z.infer<typeof adjudicateFailureCodeSchema>;

/** Which way the citing version moved relative to the source; `none` for F. */
export const mutationDirectionSchema = z.enum([
  "strengthened",
  "weakened",
  "shifted",
  "none",
]);
export type MutationDirection = z.infer<typeof mutationDirectionSchema>;

export function addMutationConsistencyIssues(
  output: {
    verdict: FidelityVerdict;
    mutationKinds: MutationKind[];
    direction: MutationDirection;
  },
  context: z.RefinementCtx,
): void {
  if (output.verdict === "D" && output.mutationKinds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["mutationKinds"],
      message: "A D verdict must name at least one mutation kind",
    });
  }
  if (output.verdict !== "D" && output.mutationKinds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["mutationKinds"],
      message: "Only D verdicts may name mutation kinds",
    });
  }
  if (output.verdict === "F" && output.direction !== "none") {
    context.addIssue({
      code: "custom",
      path: ["direction"],
      message: "A faithful attribution has no mutation direction",
    });
  }
  if (new Set(output.mutationKinds).size !== output.mutationKinds.length) {
    context.addIssue({
      code: "custom",
      path: ["mutationKinds"],
      message: "Mutation kinds must be unique",
    });
  }
}

/**
 * The judgment itself, independent of how the model points at its evidence.
 * Schemas built on these fields apply `addMutationConsistencyIssues`.
 */
export const adjudicateJudgmentFields = {
  citingAssertion: z.string().min(1),
  sourceStatement: z.string().min(1),
  verdict: fidelityVerdictSchema,
  mutationKinds: z.array(mutationKindSchema).max(3),
  direction: mutationDirectionSchema,
  rationale: z.string().min(1),
  confidence: confidenceSchema,
};

/**
 * Strict model JSON crossing the adapter boundary. Chunk IDs are checked
 * against the supplied packet after parse. The occurrence-local claim set is
 * fixed by the Prepare record and is not echoed by the model.
 */
export const adjudicateModelOutputSchema = z
  .object({
    ...adjudicateJudgmentFields,
    citedChunkIds: z.array(stableIdentifierSchema).min(1),
  })
  .strict()
  .superRefine(addMutationConsistencyIssues);
export type AdjudicateModelOutput = z.infer<typeof adjudicateModelOutputSchema>;

const evidenceLimitationSchema = z.enum(["figure_only_support"]);
const evidenceSufficiencySchema = z.enum(["sufficient", "limited"]);

const adjudicatedOutcomeFields = {
  status: z.literal("adjudicated"),
  verdict: fidelityVerdictSchema,
  citingAssertion: z.string().min(1),
  sourceStatement: z.string().min(1),
  mutationKinds: z.array(mutationKindSchema).max(3),
  direction: mutationDirectionSchema,
  rationale: z.string().min(1),
  confidence: confidenceSchema,
  evaluatedCitingClaimText: z.string().min(1),
  evaluatedClaimRecordIds: z.array(stableIdentifierSchema).min(1),
  /** The chunks Evidence selected for this record. */
  selectedCitedChunkIds: z.array(stableIdentifierSchema).min(1),
  /**
   * The chunks the verdict rests on. Without `seedQuotes` they are the
   * selected chunks the model cited. With `seedQuotes` they are the corpus
   * chunks holding a verified quote, selected by Evidence or not, and are
   * empty only for an `E` that quotes nothing.
   */
  modelCitedChunkIds: z.array(stableIdentifierSchema),
  /**
   * Present when the adjudicator read the whole seed text instead of the
   * selected chunks: the passages it quoted, each verified as exact text of
   * the seed block it names.
   */
  seedQuotes: z
    .array(
      z
        .object({ blockId: z.string().min(1), quote: z.string().min(1) })
        .strict(),
    )
    .optional(),
  /** With `seedQuotes`: quotes the model gave that its block does not contain. */
  unverifiedSeedQuoteCount: z.number().int().nonnegative().optional(),
  /**
   * Deterministic packet diagnostic: whether selected text evidence could
   * contain the supporting material. Does not invent a new verdict mode.
   */
  evidenceSufficiency: evidenceSufficiencySchema,
  evidenceLimitation: evidenceLimitationSchema.optional(),
  execution: modelExecutionSchema,
} as const;

export const adjudicateRecordOutcomeSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        recordId: stableIdentifierSchema,
        familyId: stableIdentifierSchema,
        citationOccurrenceId: stableIdentifierSchema,
        adjudicationResultId: stableIdentifierSchema,
        ...adjudicatedOutcomeFields,
      })
      .strict(),
    z
      .object({
        recordId: stableIdentifierSchema,
        familyId: stableIdentifierSchema,
        citationOccurrenceId: stableIdentifierSchema,
        adjudicationResultId: stableIdentifierSchema,
        status: z.literal("not_adjudicated"),
        gateCode: adjudicateGateCodeSchema,
        reason: z.string().min(1),
      })
      .strict(),
    z
      .object({
        recordId: stableIdentifierSchema,
        familyId: stableIdentifierSchema,
        citationOccurrenceId: stableIdentifierSchema,
        adjudicationResultId: stableIdentifierSchema,
        status: z.literal("adjudication_failed"),
        failureCode: adjudicateNonfatalFailureCodeSchema,
        reason: z.string().min(1),
        execution: modelExecutionSchema,
      })
      .strict(),
    z
      .object({
        recordId: stableIdentifierSchema,
        familyId: stableIdentifierSchema,
        citationOccurrenceId: stableIdentifierSchema,
        adjudicationResultId: stableIdentifierSchema,
        status: z.literal("invalid_output"),
        reason: z.string().min(1),
        execution: modelExecutionSchema,
      })
      .strict(),
  ])
  .superRefine((outcome, context) => {
    if (outcome.status === "adjudicated") {
      addMutationConsistencyIssues(outcome, context);
      addDuplicateIdentifierIssue(
        outcome.evaluatedClaimRecordIds,
        ["evaluatedClaimRecordIds"],
        context,
      );
      addDuplicateIdentifierIssue(
        outcome.selectedCitedChunkIds,
        ["selectedCitedChunkIds"],
        context,
      );
      addDuplicateIdentifierIssue(
        outcome.modelCitedChunkIds,
        ["modelCitedChunkIds"],
        context,
      );
      addEvidenceBasisIssues(outcome, context);
    }
    if (outcome.adjudicationResultId !== buildAdjudicationResultId(outcome)) {
      context.addIssue({
        code: "custom",
        path: ["adjudicationResultId"],
        message:
          "adjudicationResultId does not match record, method, and immutable outcome",
      });
    }
  });
export type AdjudicateRecordOutcome = z.infer<
  typeof adjudicateRecordOutcomeSchema
>;

/** A verdict rests on cited selected chunks or on verified seed quotes. */
function addEvidenceBasisIssues(
  outcome: {
    verdict: FidelityVerdict;
    selectedCitedChunkIds: string[];
    modelCitedChunkIds: string[];
    seedQuotes?: { blockId: string; quote: string }[] | undefined;
    unverifiedSeedQuoteCount?: number | undefined;
  },
  context: z.RefinementCtx,
): void {
  const issue = (path: string, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });
  if (outcome.seedQuotes == null) {
    const selected = new Set(outcome.selectedCitedChunkIds);
    if (outcome.modelCitedChunkIds.length === 0)
      issue("modelCitedChunkIds", "A verdict must cite a selected chunk");
    if (outcome.modelCitedChunkIds.some((chunkId) => !selected.has(chunkId)))
      issue(
        "modelCitedChunkIds",
        "Model-cited chunk is not in Evidence's exact final selection",
      );
    if (outcome.unverifiedSeedQuoteCount != null)
      issue(
        "unverifiedSeedQuoteCount",
        "Only a whole-seed-text verdict counts unverified quotes",
      );
    return;
  }
  if (outcome.unverifiedSeedQuoteCount == null)
    issue(
      "unverifiedSeedQuoteCount",
      "A whole-seed-text verdict states how many quotes failed verification",
    );
  if (outcome.verdict !== "E" && outcome.seedQuotes.length === 0)
    issue(
      "seedQuotes",
      `A ${outcome.verdict} verdict must rest on at least one verified seed quote`,
    );
  if (
    (outcome.seedQuotes.length === 0) !==
    (outcome.modelCitedChunkIds.length === 0)
  )
    issue(
      "modelCitedChunkIds",
      "Model-cited chunks must be exactly those holding a verified seed quote",
    );
}

/**
 * Result identity binds prepared record ID, versioned method, and immutable
 * scientific outcome. Timestamps, artifact URIs, and
 * storage locations are excluded.
 */
export function buildAdjudicationResultId(
  outcome:
    | AdjudicateRecordOutcome
    | Omit<AdjudicateRecordOutcome, "adjudicationResultId">,
): string {
  return buildStableId("adjudication", {
    identityKind: adjudicateMethodId,
    recordId: outcome.recordId,
    method: adjudicateMethod,
    status: outcome.status,
    // adjudicationResultId is excluded from identity hashing below.
    immutableOutcome: immutableOutcomeForIdentity(
      outcome as AdjudicateRecordOutcome,
    ),
  });
}

/**
 * What was asked and what came back — not how it was served. The request
 * artifact is deliberately excluded: its body carries `cachePolicy` and
 * `promptCachePolicy`, so hashing it made the same verdict on the same prompt
 * produce a different `adjudicationResultId` on a cached re-run. `requestHash`
 * covers the request semantically, and `promptContentHash` covers the prompt.
 */
function executionIdentity(execution: ModelExecution) {
  return {
    provider: execution.provider,
    model: execution.model,
    promptId: execution.promptId,
    promptVersion: execution.promptVersion,
    promptContentHash: execution.promptContentHash,
    requestHash: execution.requestHash,
  };
}

function immutableOutcomeForIdentity(
  outcome: AdjudicateRecordOutcome,
): unknown {
  if (outcome.status === "adjudicated") {
    return {
      verdict: outcome.verdict,
      citingAssertion: outcome.citingAssertion,
      sourceStatement: outcome.sourceStatement,
      mutationKinds: outcome.mutationKinds,
      direction: outcome.direction,
      rationale: outcome.rationale,
      confidence: outcome.confidence,
      evaluatedCitingClaimText: outcome.evaluatedCitingClaimText,
      evaluatedClaimRecordIds: outcome.evaluatedClaimRecordIds,
      selectedCitedChunkIds: outcome.selectedCitedChunkIds,
      modelCitedChunkIds: outcome.modelCitedChunkIds,
      ...(outcome.seedQuotes
        ? {
            seedQuotes: outcome.seedQuotes,
            unverifiedSeedQuoteCount: outcome.unverifiedSeedQuoteCount,
          }
        : {}),
      evidenceSufficiency: outcome.evidenceSufficiency,
      ...(outcome.evidenceLimitation
        ? { evidenceLimitation: outcome.evidenceLimitation }
        : {}),
      execution: executionIdentity(outcome.execution),
    };
  }
  if (outcome.status === "not_adjudicated") {
    return {
      gateCode: outcome.gateCode,
    };
  }
  if (outcome.status === "adjudication_failed") {
    return {
      failureCode: outcome.failureCode,
      execution: executionIdentity(outcome.execution),
    };
  }
  return {
    execution: executionIdentity(outcome.execution),
  };
}

export const adjudicateArtifactPayloadSchema = z
  .object({
    lineage: adjudicateLineageSchema,
    method: adjudicateMethodSchema,
    records: z.array(adjudicateRecordOutcomeSchema),
  })
  .strict()
  .superRefine(validateAdjudicatePayload);
export type AdjudicateArtifactPayload = z.infer<
  typeof adjudicateArtifactPayloadSchema
>;

function validateAdjudicatePayload(
  payload: z.infer<typeof adjudicateArtifactPayloadSchema>,
  context: z.RefinementCtx,
): void {
  const recordIds = payload.records.map((record) => record.recordId);
  addDuplicateIdentifierIssue(recordIds, ["records"], context);

  const sortedIds = [...recordIds].sort(compareCodeUnits);
  if (canonicalSerialize(recordIds) !== canonicalSerialize(sortedIds)) {
    context.addIssue({
      code: "custom",
      path: ["records"],
      message:
        "Adjudicate records must be ordered by stable recordId for deterministic accounting",
    });
  }

  for (const [index, record] of payload.records.entries()) {
    if (record.status === "adjudicated" && record.verdict === "U") {
      // U is scientific uncertainty only when exact cited evidence was evaluated.
      if (record.selectedCitedChunkIds.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "selectedCitedChunkIds"],
          message:
            "U requires exact selected cited evidence and cannot encode operational failure",
        });
      }
    }
  }
}

export function validateAdjudicateArtifactLineage(
  artifact: {
    runId: string;
    inputArtifacts: ArtifactReference[];
    decisions: Array<{
      recordId: string;
      decisionType: string;
      actor: {
        kind: "deterministic" | "model" | "external" | "human";
        identifier: string;
      };
      evidenceArtifacts: ArtifactReference[];
    }>;
    provenance: {
      models: Array<{
        provider: string;
        model: string;
        requestHash: string;
        requestArtifact: ArtifactReference;
        responseArtifact: ArtifactReference;
      }>;
      prompts: Array<{
        promptId: string;
        version: string;
        contentHash: string;
      }>;
    };
    execution: {
      kind: string;
      replayableFromInputs?: boolean;
      responseArtifacts?: ArtifactReference[] | undefined;
    };
    payload: AdjudicateArtifactPayload;
  },
  context: z.RefinementCtx,
): void {
  // Run and input-artifact agreement is checked once, generically, by the
  // envelope. What remains here is specific to Adjudicate: a fully gated run
  // must not claim model provenance, and a modeled one must carry it.
  const { lineage } = artifact.payload;
  const modeledRecords = artifact.payload.records.filter(
    (record) =>
      record.status === "adjudicated" ||
      record.status === "adjudication_failed" ||
      record.status === "invalid_output",
  );
  const hasModelOutcome = modeledRecords.length > 0;
  if (hasModelOutcome) {
    // Count provenance entries by their exact match key once, so each record
    // is checked in constant time; a scan per record is quadratic at census
    // scale.
    const countBy = <T>(values: readonly T[], key: (value: T) => string) => {
      const counts = new Map<string, number>();
      for (const value of values) {
        const k = key(value);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return counts;
    };
    const promptKey = (prompt: {
      promptId: string;
      version: string;
      contentHash: string;
    }) =>
      canonicalSerialize([prompt.promptId, prompt.version, prompt.contentHash]);
    const modelKey = (model: {
      provider: string;
      model: string;
      requestHash: string;
      requestArtifact: ArtifactReference;
      responseArtifact: ArtifactReference;
    }) =>
      canonicalSerialize([
        model.provider,
        model.model,
        model.requestHash,
        model.requestArtifact,
        model.responseArtifact,
      ]);
    const promptCounts = countBy(artifact.provenance.prompts, promptKey);
    const modelCounts = countBy(artifact.provenance.models, modelKey);
    const responseCounts = countBy(
      artifact.execution.responseArtifacts ?? [],
      (reference) => canonicalSerialize(reference),
    );
    for (const record of modeledRecords) {
      const execution = record.execution;
      if (
        promptCounts.get(
          promptKey({
            promptId: execution.promptId,
            version: execution.promptVersion,
            contentHash: execution.promptContentHash,
          }),
        ) !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["provenance", "prompts"],
          message: `Modeled outcome lacks one exact prompt provenance entry: ${record.recordId}`,
        });
      }
      if (modelCounts.get(modelKey(execution)) !== 1) {
        context.addIssue({
          code: "custom",
          path: ["provenance", "models"],
          message: `Modeled outcome lacks one exact model provenance entry: ${record.recordId}`,
        });
      }
      if (
        responseCounts.get(canonicalSerialize(execution.responseArtifact)) !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["execution", "responseArtifacts"],
          message: `Modeled outcome response artifact is not bound exactly once to stage execution: ${record.recordId}`,
        });
      }
    }

    const expectedPrompts = uniqueCanonicalValues(
      modeledRecords.map((record) => ({
        promptId: record.execution.promptId,
        version: record.execution.promptVersion,
        contentHash: record.execution.promptContentHash,
      })),
    );
    if (
      !sameCanonicalCollection(artifact.provenance.prompts, expectedPrompts)
    ) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "prompts"],
        message:
          "Adjudicate prompt provenance must exactly match modeled outcomes",
      });
    }
    const expectedModels = uniqueCanonicalValues(
      modeledRecords.map((record) => ({
        provider: record.execution.provider,
        model: record.execution.model,
        requestHash: record.execution.requestHash,
        requestArtifact: record.execution.requestArtifact,
        responseArtifact: record.execution.responseArtifact,
      })),
    );
    if (!sameCanonicalCollection(artifact.provenance.models, expectedModels)) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "models"],
        message:
          "Adjudicate model provenance must exactly match modeled outcomes",
      });
    }
    const expectedResponses = uniqueCanonicalValues(
      modeledRecords.map((record) => record.execution.responseArtifact),
    );
    if (
      !sameCanonicalCollection(
        artifact.execution.responseArtifacts ?? [],
        expectedResponses,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["execution", "responseArtifacts"],
        message:
          "Adjudicate stage response artifacts must exactly match modeled outcomes",
      });
    }
  } else {
    if (
      artifact.execution.kind !== "deterministic" ||
      artifact.execution.replayableFromInputs !== true
    ) {
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message:
          "Fully gated Adjudicate runs must be deterministic and replayable",
      });
    }
    if (
      artifact.provenance.prompts.length !== 0 ||
      artifact.provenance.models.length !== 0 ||
      (artifact.execution.responseArtifacts?.length ?? 0) !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message:
          "Fully gated Adjudicate artifacts cannot carry prompt, model, or response provenance",
      });
    }
  }

  const lineageArtifacts = [lineage.evidenceArtifact, lineage.prepareArtifact];
  for (const record of artifact.payload.records) {
    const decision = findSingleDecision(
      artifact.decisions,
      record.recordId,
      "adjudicate_outcome",
    );
    if (!decision) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: `Adjudicate decisions are missing or duplicated: ${record.recordId}`,
      });
      continue;
    }

    if (record.status === "not_adjudicated") {
      if (
        decision.actor.kind !== "deterministic" ||
        !sameCanonicalCollection(decision.evidenceArtifacts, lineageArtifacts)
      ) {
        context.addIssue({
          code: "custom",
          path: ["decisions"],
          message: `A gated Adjudicate decision must be deterministic and lineage-only: ${record.recordId}`,
        });
      }
      continue;
    }

    if (
      decision.actor.kind !== "model" ||
      decision.actor.identifier !==
        `${record.execution.provider}/${record.execution.model}` ||
      !sameCanonicalCollection(decision.evidenceArtifacts, [
        ...lineageArtifacts,
        record.execution.requestArtifact,
        record.execution.responseArtifact,
      ])
    ) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: `A modeled Adjudicate decision lacks exact request/response provenance: ${record.recordId}`,
      });
    }
  }
}

function findSingleDecision<
  T extends {
    recordId: string;
    decisionType: string;
  },
>(decisions: T[], recordId: string, decisionType: string): T | undefined {
  const matching = decisions.filter(
    (decision) =>
      decision.recordId === recordId && decision.decisionType === decisionType,
  );
  return matching.length === 1 ? matching[0] : undefined;
}

function uniqueCanonicalValues<T>(values: readonly T[]): T[] {
  const byValue = new Map<string, T>();
  for (const value of values) {
    byValue.set(canonicalSerialize(value), value);
  }
  return [...byValue.values()];
}

function sameCanonicalCollection(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  const normalized = (values: readonly unknown[]) =>
    values.map((value) => canonicalSerialize(value)).sort(compareCodeUnits);
  return (
    canonicalSerialize(normalized(left)) ===
    canonicalSerialize(normalized(right))
  );
}

/** Content hash helper for packet/prompt provenance (not outcome identity). */
export function hashAdjudicatePrompt(promptText: string): string {
  return canonicalSha256(promptText);
}

export function hashAdjudicateRequest(request: unknown): string {
  return canonicalSha256(request);
}
