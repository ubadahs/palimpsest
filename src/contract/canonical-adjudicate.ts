import { z } from "zod";

import { confidenceSchema } from "../domain/classification.js";
import { fidelityTopLabelSchema } from "../domain/taxonomy.js";
import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../shared/stable-identity.js";
import {
  artifactReferenceSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "./lean-artifact-primitives.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "./model-execution.js";

/**
 * Canonical Adjudicate contract (isolated stage module). Shared envelope
 * primitives come from a cycle-free module; scientific stage contracts stay
 * outside that primitive boundary.
 */

export const canonicalAdjudicateMethodId =
  "canonical-categorical-adjudicate-v2" as const;

export const canonicalAdjudicateMethodSchema = z
  .object({
    methodId: z.literal(canonicalAdjudicateMethodId),
    strategy: z.literal("single_categorical"),
    calibrationStatus: z.literal("uncalibrated"),
    routing: z.literal("none"),
  })
  .strict();
export type CanonicalAdjudicateMethod = z.infer<
  typeof canonicalAdjudicateMethodSchema
>;

export const canonicalAdjudicateMethod: CanonicalAdjudicateMethod = {
  methodId: canonicalAdjudicateMethodId,
  strategy: "single_categorical",
  calibrationStatus: "uncalibrated",
  routing: "none",
};

const adjudicateEvidenceArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-evidence-input"),
    canonicalStage: z.literal("evidence"),
  })
  .strict();

const adjudicatePrepareArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-prepare-input"),
    canonicalStage: z.literal("prepare"),
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

/**
 * Categorical kinds of alteration a `D` verdict can name. These record the
 * dimension and direction of a mutation so drift can be aggregated across
 * citers and hops; they never route the verdict.
 */
export const mutationKindSchema = z.enum([
  "scope_broadened",
  "scope_narrowed",
  "population_shifted",
  "certainty_strengthened",
  "certainty_weakened",
  "correlation_to_causation",
  "conditions_dropped",
  "endpoint_substituted",
  "generality_increased",
  "entity_substituted",
]);
export type MutationKind = z.infer<typeof mutationKindSchema>;

export const mutationDirectionSchema = z.enum([
  "strengthened",
  "weakened",
  "shifted",
  "none",
]);
export type MutationDirection = z.infer<typeof mutationDirectionSchema>;

function addMutationConsistencyIssues(
  output: {
    verdict: z.infer<typeof fidelityTopLabelSchema>;
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
 * Strict model JSON crossing the adapter boundary. Chunk IDs are checked
 * against the supplied packet after parse. The occurrence-local claim set is
 * fixed by the Prepare record and is not echoed by the model.
 */
export const canonicalAdjudicateModelOutputSchema = z
  .object({
    citingAssertion: z.string().min(1),
    sourceStatement: z.string().min(1),
    verdict: fidelityTopLabelSchema,
    mutationKinds: z.array(mutationKindSchema).max(3),
    direction: mutationDirectionSchema,
    rationale: z.string().min(1),
    confidence: confidenceSchema,
    citedChunkIds: z.array(stableIdentifierSchema).min(1),
  })
  .strict()
  .superRefine(addMutationConsistencyIssues);
export type CanonicalAdjudicateModelOutput = z.infer<
  typeof canonicalAdjudicateModelOutputSchema
>;

const evidenceLimitationSchema = z.enum(["figure_only_support"]);
const evidenceSufficiencySchema = z.enum(["sufficient", "limited"]);

const adjudicatedOutcomeFields = {
  status: z.literal("adjudicated"),
  verdict: fidelityTopLabelSchema,
  citingAssertion: z.string().min(1),
  sourceStatement: z.string().min(1),
  mutationKinds: z.array(mutationKindSchema).max(3),
  direction: mutationDirectionSchema,
  rationale: z.string().min(1),
  confidence: confidenceSchema,
  evaluatedCitingClaimText: z.string().min(1),
  evaluatedClaimRecordIds: z.array(stableIdentifierSchema).min(1),
  selectedCitedChunkIds: z.array(stableIdentifierSchema).min(1),
  modelCitedChunkIds: z.array(stableIdentifierSchema).min(1),
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
      const selected = new Set(outcome.selectedCitedChunkIds);
      for (const [index, chunkId] of outcome.modelCitedChunkIds.entries()) {
        if (!selected.has(chunkId)) {
          context.addIssue({
            code: "custom",
            path: ["modelCitedChunkIds", index],
            message:
              "Model-cited chunk is not in Evidence's exact final selection",
          });
        }
      }
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

/**
 * Result identity binds prepared record ID, versioned method, and immutable
 * scientific outcome. Timestamps, confidence routing, artifact URIs, and
 * storage locations are excluded.
 */
export function buildAdjudicationResultId(
  outcome:
    | AdjudicateRecordOutcome
    | Omit<AdjudicateRecordOutcome, "adjudicationResultId">,
): string {
  return buildStableId("adjudication", {
    identityKind: canonicalAdjudicateMethodId,
    recordId: outcome.recordId,
    method: canonicalAdjudicateMethod,
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
    method: canonicalAdjudicateMethodSchema,
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
  if (payload.method.methodId !== canonicalAdjudicateMethodId) {
    context.addIssue({
      code: "custom",
      path: ["method", "methodId"],
      message:
        "Canonical Adjudicate method ID is not the current categorical method",
    });
  }
  if (payload.method.routing !== "none") {
    context.addIssue({
      code: "custom",
      path: ["method", "routing"],
      message: "Canonical Adjudicate forbids advisor/vector/confidence routing",
    });
  }
  if (payload.method.calibrationStatus !== "uncalibrated") {
    context.addIssue({
      code: "custom",
      path: ["method", "calibrationStatus"],
      message:
        "Canonical Adjudicate remains uncalibrated until blinded human labels exist",
    });
  }

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
    exclusions: unknown[];
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
  const { lineage } = artifact.payload;
  if (artifact.runId !== lineage.runId) {
    context.addIssue({
      code: "custom",
      path: ["payload", "lineage", "runId"],
      message:
        "Adjudicate run ID must match its verified Evidence/Prepare lineage",
    });
  }
  if (
    artifact.inputArtifacts.length !== 2 ||
    !sameArtifactReference(
      artifact.inputArtifacts[0],
      lineage.evidenceArtifact,
    ) ||
    !sameArtifactReference(artifact.inputArtifacts[1], lineage.prepareArtifact)
  ) {
    context.addIssue({
      code: "custom",
      path: ["inputArtifacts"],
      message:
        "Adjudicate must reference exact canonical Evidence and Prepare inputs",
    });
  }
  if (artifact.exclusions.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["exclusions"],
      message:
        "Adjudicate performs complete accounting and cannot exclude Evidence records",
    });
  }
  if (artifact.decisions.length !== artifact.payload.records.length * 3) {
    context.addIssue({
      code: "custom",
      path: ["decisions"],
      message:
        "Adjudicate must record gate, model, and final-outcome decisions for every Evidence record",
    });
  }

  const modeledRecords = artifact.payload.records.filter(
    (record) =>
      record.status === "adjudicated" ||
      record.status === "adjudication_failed" ||
      record.status === "invalid_output",
  );
  const hasModelOutcome = modeledRecords.length > 0;
  if (hasModelOutcome) {
    if (artifact.execution.kind !== "model") {
      context.addIssue({
        code: "custom",
        path: ["execution", "kind"],
        message:
          "Model adjudication requires non-deterministic model execution metadata",
      });
    }
    if (artifact.execution.replayableFromInputs !== false) {
      context.addIssue({
        code: "custom",
        path: ["execution", "replayableFromInputs"],
        message: "Model adjudication cannot claim replayability from inputs",
      });
    }
    for (const record of modeledRecords) {
      const execution = record.execution;
      const promptMatches = artifact.provenance.prompts.filter(
        (prompt) =>
          prompt.promptId === execution.promptId &&
          prompt.version === execution.promptVersion &&
          prompt.contentHash === execution.promptContentHash,
      );
      if (promptMatches.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["provenance", "prompts"],
          message: `Modeled outcome lacks one exact prompt provenance entry: ${record.recordId}`,
        });
      }

      const modelMatches = artifact.provenance.models.filter((model) =>
        modelProvenanceMatchesExecution(model, execution),
      );
      if (modelMatches.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["provenance", "models"],
          message: `Modeled outcome lacks one exact model provenance entry: ${record.recordId}`,
        });
      }

      const responseMatches = (
        artifact.execution.responseArtifacts ?? []
      ).filter((reference) =>
        sameArtifactReference(reference, execution.responseArtifact),
      );
      if (responseMatches.length !== 1) {
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

  for (const record of artifact.payload.records) {
    const gateDecision = findSingleDecision(
      artifact.decisions,
      record.recordId,
      "adjudicate_gate_outcome",
    );
    const modelDecision = findSingleDecision(
      artifact.decisions,
      record.recordId,
      "adjudicate_model_outcome",
    );
    const finalDecision = findSingleDecision(
      artifact.decisions,
      record.recordId,
      "adjudicate_final_outcome",
    );
    if (!gateDecision || !modelDecision || !finalDecision) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: `Adjudicate decisions are missing or duplicated: ${record.recordId}`,
      });
      continue;
    }

    const lineageArtifacts = [
      lineage.evidenceArtifact,
      lineage.prepareArtifact,
    ];
    if (
      gateDecision.actor.kind !== "deterministic" ||
      !sameCanonicalCollection(gateDecision.evidenceArtifacts, lineageArtifacts)
    ) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: `Adjudicate gate decision must be deterministic and lineage-only: ${record.recordId}`,
      });
    }

    if (record.status === "not_adjudicated") {
      for (const decision of [modelDecision, finalDecision]) {
        if (
          decision.actor.kind !== "deterministic" ||
          !sameCanonicalCollection(decision.evidenceArtifacts, lineageArtifacts)
        ) {
          context.addIssue({
            code: "custom",
            path: ["decisions"],
            message: `Gated Adjudicate decisions must remain deterministic and lineage-only: ${record.recordId}`,
          });
        }
      }
    } else {
      const modeledArtifacts = [
        ...lineageArtifacts,
        record.execution.requestArtifact,
        record.execution.responseArtifact,
      ];
      for (const decision of [modelDecision, finalDecision]) {
        if (
          decision.actor.kind !== "model" ||
          decision.actor.identifier !==
            `${record.execution.provider}/${record.execution.model}` ||
          !sameCanonicalCollection(decision.evidenceArtifacts, modeledArtifacts)
        ) {
          context.addIssue({
            code: "custom",
            path: ["decisions"],
            message: `Modeled Adjudicate decision lacks exact request/response provenance: ${record.recordId}`,
          });
        }
      }
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

function modelProvenanceMatchesExecution(
  model: {
    provider: string;
    model: string;
    requestHash: string;
    requestArtifact: ArtifactReference;
    responseArtifact: ArtifactReference;
  },
  execution: ModelExecution,
): boolean {
  return (
    model.provider === execution.provider &&
    model.model === execution.model &&
    model.requestHash === execution.requestHash &&
    sameArtifactReference(model.requestArtifact, execution.requestArtifact) &&
    sameArtifactReference(model.responseArtifact, execution.responseArtifact)
  );
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

function addDuplicateIdentifierIssue(
  values: readonly string[],
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path,
        message: `Duplicate identifier: ${value}`,
      });
      return;
    }
    seen.add(value);
  }
}

function sameArtifactReference(
  left:
    | {
        artifactId: string;
        contentHash: string;
        role: string;
        canonicalStage?: string | undefined;
        uri?: string | undefined;
      }
    | undefined,
  right: {
    artifactId: string;
    contentHash: string;
    role: string;
    canonicalStage?: string | undefined;
    uri?: string | undefined;
  },
): boolean {
  return (
    left != null &&
    left.artifactId === right.artifactId &&
    left.contentHash === right.contentHash &&
    left.role === right.role &&
    left.canonicalStage === right.canonicalStage &&
    left.uri === right.uri
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Content hash helper for packet/prompt provenance (not outcome identity). */
export function hashCanonicalAdjudicatePrompt(promptText: string): string {
  return canonicalSha256(promptText);
}

export function hashCanonicalAdjudicateRequest(request: unknown): string {
  return canonicalSha256(request);
}
