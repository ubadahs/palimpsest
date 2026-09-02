import { z } from "zod";

import { uniqueSortedArtifactReferences } from "../contract/lean-artifact-primitives.js";
import { compareCodeUnits, uniqueSorted } from "../shared/order.js";
import { sameIdentifierSequence } from "../contract/artifacts/checks.js";
import { createBoundaryParser } from "../shared/boundary.js";

import { classifyCitationFunction } from "../classification/classify-citation-function.js";
import { deriveEvaluationMode } from "../classification/evaluation-mode.js";
import type { CitationRole } from "../domain/classification.js";
import {
  buildCitationInstanceRecordId,
  createAppendOnlyDecision,
  createLeanStageArtifact,
  discoverArtifactSchema,
  leanArtifactSchemaVersion,
  leanArtifactVersion,
  prepareArtifactPayloadSchema,
  prepareArtifactSchema,
  prepareClassificationFailureExecutionSchema,
  prepareClassificationSchema,
  type PrepareClassificationFailureExecution,
  prepareFatalFailureCodeSchema,
  scopeArtifactSchema,
  type AppendOnlyDecision,
  type ArtifactReference,
  type DiscoverArtifact,
  type DiscoverCitationOccurrence,
  type DiscoverCitingPaperRecord,
  type DiscoverSeed,
  type LeanArtifactProvenance,
  type PrepareArtifact,
  type PrepareArtifactPayload,
  type PrepareClassification,
  type PreparedCitationInstance,
  type ScopeArtifact,
  type ScopedFamily,
} from "../contract/lean-artifacts.js";

export const canonicalPrepareOptionsSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    scopeArtifactUri: z.string().min(1).optional(),
  })
  .strict();
export type CanonicalPrepareOptions = z.infer<
  typeof canonicalPrepareOptionsSchema
>;

const fatalClassificationResultSchema = z
  .object({
    status: z.literal("failed"),
    reasonCode: prepareFatalFailureCodeSchema,
    reason: z.string().min(1),
    execution: prepareClassificationFailureExecutionSchema,
  })
  .strict();

export const canonicalPrepareClassificationResultSchema = z.union([
  prepareClassificationSchema,
  fatalClassificationResultSchema,
]);
export type CanonicalPrepareClassifierInput = {
  family: ScopedFamily;
  sourceCandidates: PreparedCitationInstance["sourceCandidates"];
  sourceClaimRecords: PreparedCitationInstance["sourceClaimRecords"];
  occurrenceSourceCandidates: PreparedCitationInstance["occurrenceSourceCandidates"];
  occurrenceSourceClaimRecords: PreparedCitationInstance["occurrenceSourceClaimRecords"];
  seed: DiscoverSeed;
  citingPaper: DiscoverCitingPaperRecord;
  citationOccurrence: DiscoverCitationOccurrence;
};

export type CanonicalPrepareAdapters = {
  classifyCitation: (
    input: CanonicalPrepareClassifierInput,
  ) => Promise<unknown>;
};

type CanonicalPrepareProvenanceInputs = {
  prompts: LeanArtifactProvenance["prompts"];
  models: LeanArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
  hasModelExecution: boolean;
  hasExternalExecution: boolean;
};

export type CanonicalPrepareResult = {
  payload: PrepareArtifactPayload;
  decisions: AppendOnlyDecision[];
  provenanceInputs: CanonicalPrepareProvenanceInputs;
};

export class CanonicalPrepareBoundaryError extends Error {
  override readonly name = "CanonicalPrepareBoundaryError";
}

export class CanonicalPrepareFatalError extends Error {
  override readonly name = "CanonicalPrepareFatalError";

  constructor(
    readonly failureCode: z.infer<typeof prepareFatalFailureCodeSchema>,
    message: string,
  ) {
    super(message);
  }
}

export async function runCanonicalPrepare(
  scopeArtifactInput: unknown,
  discoverArtifactInput: unknown,
  adapters: CanonicalPrepareAdapters,
  optionsInput: CanonicalPrepareOptions,
): Promise<CanonicalPrepareResult> {
  const scopeArtifact = parseBoundary(
    scopeArtifactSchema,
    scopeArtifactInput,
    "canonical Scope input",
  );
  const discoverArtifact = parseBoundary(
    discoverArtifactSchema,
    discoverArtifactInput,
    "canonical Discover ancestor",
  );
  const options = parseBoundary(
    canonicalPrepareOptionsSchema,
    optionsInput,
    "canonical Prepare options",
  );
  verifyPrepareAncestors(scopeArtifact, discoverArtifact);

  const lineage: PrepareArtifactPayload["lineage"] = {
    runId: scopeArtifact.runId,
    scopeArtifact: {
      artifactId: scopeArtifact.artifactId,
      contentHash: scopeArtifact.contentHash,
      role: "canonical-scope-input",
      canonicalStage: "scope",
      ...(options.scopeArtifactUri ? { uri: options.scopeArtifactUri } : {}),
    },
    discoverArtifact: scopeArtifact.payload.discoverArtifact,
  };
  const seedsById = new Map(
    discoverArtifact.payload.seeds.map((seed) => [seed.seedId, seed]),
  );
  const citingPapersById = new Map(
    discoverArtifact.payload.citingPapers.map((paper) => [
      paper.citingPaperRecordId,
      paper,
    ]),
  );
  const occurrencesById = new Map(
    discoverArtifact.payload.citationMentions.map((occurrence) => [
      occurrence.mentionId,
      occurrence,
    ]),
  );
  const candidatesById = new Map(
    discoverArtifact.payload.claimCandidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  const sourceClaimsById = new Map(
    discoverArtifact.payload.attributedClaimRecords.map((sourceClaim) => [
      sourceClaim.claimRecordId,
      sourceClaim,
    ]),
  );
  const records: PreparedCitationInstance[] = [];
  const decisions: AppendOnlyDecision[] = [];
  const prompts: LeanArtifactProvenance["prompts"] = [];
  const models: LeanArtifactProvenance["models"] = [];
  const responseArtifacts: ArtifactReference[] = [];
  let hasModelExecution = false;
  let hasExternalExecution = false;

  for (const family of scopeArtifact.payload.families) {
    const seed = seedsById.get(family.seedId);
    if (!seed) {
      throw new CanonicalPrepareBoundaryError(
        `Scope family references an unknown Discover seed: ${family.familyId}`,
      );
    }
    const sourceCandidates = family.candidateIds.map((candidateId) => {
      const candidate = candidatesById.get(candidateId);
      if (!candidate) {
        throw new CanonicalPrepareBoundaryError(
          `Scope family references an unknown Discover candidate: ${candidateId}`,
        );
      }
      return candidate;
    });
    const sourceClaimRecords = family.sourceClaimRecordIds.map(
      (sourceClaimRecordId) => {
        const sourceClaim = sourceClaimsById.get(sourceClaimRecordId);
        if (!sourceClaim) {
          throw new CanonicalPrepareBoundaryError(
            `Scope family references an unknown Discover source claim: ${sourceClaimRecordId}`,
          );
        }
        return sourceClaim;
      },
    );
    for (const citationOccurrenceId of family.includedCitationOccurrenceIds) {
      const citationOccurrence = occurrencesById.get(citationOccurrenceId);
      if (!citationOccurrence) {
        throw new CanonicalPrepareBoundaryError(
          `Scope family references an unknown Discover occurrence: ${citationOccurrenceId}`,
        );
      }
      const citingPaper = citingPapersById.get(
        citationOccurrence.citingPaperRecordId,
      );
      if (!citingPaper) {
        throw new CanonicalPrepareBoundaryError(
          `Discover occurrence references an unknown citing-paper record: ${citationOccurrence.mentionId}`,
        );
      }
      const occurrenceSourceCandidates = sourceCandidates.filter((candidate) =>
        candidate.memberMentionIds.includes(citationOccurrenceId),
      );
      const occurrenceSourceClaimRecords = sourceClaimRecords.filter(
        (sourceClaim) => sourceClaim.mentionId === citationOccurrenceId,
      );
      if (
        occurrenceSourceCandidates.length === 0 ||
        occurrenceSourceClaimRecords.length === 0
      ) {
        throw new CanonicalPrepareBoundaryError(
          `Scoped pair has no occurrence-local source provenance: ${family.familyId} × ${citationOccurrenceId}`,
        );
      }
      const classificationResult = parseBoundary(
        canonicalPrepareClassificationResultSchema,
        await adapters.classifyCitation({
          family,
          sourceCandidates,
          sourceClaimRecords,
          occurrenceSourceCandidates,
          occurrenceSourceClaimRecords,
          seed,
          citingPaper,
          citationOccurrence,
        }),
        `classification for ${family.familyId} × ${citationOccurrenceId}`,
      );
      if (
        classificationResult.status === "failed" &&
        prepareFatalFailureCodeSchema.safeParse(classificationResult.reasonCode)
          .success
      ) {
        throw new CanonicalPrepareFatalError(
          prepareFatalFailureCodeSchema.parse(classificationResult.reasonCode),
          classificationResult.reason,
        );
      }
      const classification =
        prepareClassificationSchema.parse(classificationResult);
      const recordId = buildCitationInstanceRecordId({
        familyId: family.familyId,
        citationOccurrenceId,
      });
      const record = {
        recordId,
        familyId: family.familyId,
        citationOccurrenceId,
        family,
        sourceCandidates,
        sourceClaimRecords,
        occurrenceSourceCandidates,
        occurrenceSourceClaimRecords,
        seed,
        citingPaper,
        citationOccurrence,
        classification,
        lineage,
      };
      records.push(record);

      const executionArtifacts = classificationExecutionArtifacts(
        classification.execution,
      );
      const actor = classificationActor(classification.execution);
      decisions.push(
        createAppendOnlyDecision({
          recordId,
          decisionType: "prepare_classification_outcome",
          outcome: classification.status,
          reason: classificationReason(classification),
          recordedAt: options.recordedAt,
          actor,
          evidenceArtifacts: uniqueSortedArtifactReferences([
            lineage.scopeArtifact,
            lineage.discoverArtifact,
            ...executionArtifacts,
          ]),
        }),
      );
      if (classification.execution.kind === "model") {
        hasModelExecution = true;
        prompts.push({
          promptId: classification.execution.promptId,
          version: classification.execution.promptVersion,
          contentHash: classification.execution.promptContentHash,
        });
        models.push({
          provider: classification.execution.provider,
          model: classification.execution.model,
          requestHash: classification.execution.requestHash,
          requestArtifact: classification.execution.requestArtifact,
          responseArtifact: classification.execution.responseArtifact,
        });
        responseArtifacts.push(classification.execution.responseArtifact);
      } else if (classification.execution.kind === "external") {
        hasExternalExecution = true;
        responseArtifacts.push(classification.execution.responseArtifact);
      }
    }
  }

  const payload = parseBoundary(
    prepareArtifactPayloadSchema,
    {
      lineage,
      scopedFamilies: scopeArtifact.payload.families,
      records: records.sort((left, right) =>
        compareCodeUnits(left.recordId, right.recordId),
      ),
    },
    "canonical Prepare payload",
  );
  return {
    payload,
    decisions: decisions.sort((left, right) =>
      compareCodeUnits(left.decisionId, right.decisionId),
    ),
    provenanceInputs: {
      prompts: uniqueSorted(prompts),
      models: uniqueSorted(models),
      responseArtifacts: uniqueSortedArtifactReferences(responseArtifacts),
      hasModelExecution,
      hasExternalExecution,
    },
  };
}

export function buildCanonicalPrepareArtifact(input: {
  result: CanonicalPrepareResult;
  runId: string;
  createdAt: string;
  implementation?: string | undefined;
  configuration?: LeanArtifactProvenance["configuration"] | undefined;
  code?: LeanArtifactProvenance["code"] | undefined;
}): PrepareArtifact {
  if (input.runId !== input.result.payload.lineage.runId) {
    throw new CanonicalPrepareBoundaryError(
      "Prepare artifact run ID differs from its verified Scope and Discover inputs",
    );
  }
  const provenance: LeanArtifactProvenance = {
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.code ? { code: input.code } : {}),
    prompts: input.result.provenanceInputs.prompts,
    models: input.result.provenanceInputs.models,
  };
  const { hasModelExecution, hasExternalExecution, responseArtifacts } =
    input.result.provenanceInputs;
  const executionKind =
    hasModelExecution && hasExternalExecution
      ? "hybrid"
      : hasModelExecution
        ? "model"
        : hasExternalExecution
          ? "external"
          : "deterministic";
  const execution =
    executionKind === "deterministic"
      ? ({
          kind: "deterministic",
          implementation: input.implementation ?? "canonical-prepare-v1",
          replayableFromInputs: true,
        } as const)
      : ({
          kind: executionKind,
          implementation: input.implementation ?? "canonical-prepare-v1",
          replayableFromInputs: false,
          responseArtifacts,
        } as const);
  const artifact = createLeanStageArtifact({
    schemaVersion: leanArtifactSchemaVersion,
    artifactVersion: leanArtifactVersion,
    runId: input.runId,
    createdAt: input.createdAt,
    canonicalStage: "prepare",
    inputArtifacts: [
      input.result.payload.lineage.scopeArtifact,
      input.result.payload.lineage.discoverArtifact,
    ],
    provenance,
    execution,
    decisions: input.result.decisions,
    payload: input.result.payload,
  });
  return parseBoundary(
    prepareArtifactSchema,
    artifact,
    "canonical Prepare artifact",
  );
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

function weakestClaimConfidence(
  claims: PreparedCitationInstance["occurrenceSourceClaimRecords"],
): "low" | "medium" | "high" {
  let weakest: "low" | "medium" | "high" | undefined;
  for (const claim of claims) {
    if (!claim.confidence) continue;
    if (
      !weakest ||
      CONFIDENCE_RANK[claim.confidence] < CONFIDENCE_RANK[weakest]
    ) {
      weakest = claim.confidence;
    }
  }
  return weakest ?? "medium";
}

/**
 * Production-neutral deterministic baseline built from the existing pure role
 * and evaluation-mode helpers. Model/external adapters may replace it without
 * changing record membership or identity.
 */
export function classifyPrepareOccurrenceDeterministically(
  citationOccurrence: DiscoverCitationOccurrence,
  options: {
    isReviewMediated?: boolean;
    occurrenceSourceClaimRecords?: PreparedCitationInstance["occurrenceSourceClaimRecords"];
  } = {},
): PrepareClassification {
  const occurrenceClaims = options.occurrenceSourceClaimRecords ?? [];
  // The extractor reports a confidence per claim; the weakest one governs the
  // occurrence so low-information citations reach the low-information gate
  // instead of the manual-review queue.
  const confidence = weakestClaimConfidence(occurrenceClaims);
  const missingVerifiedSpan =
    occurrenceClaims.length > 0 &&
    occurrenceClaims.some((claim) => claim.supportSpan == null);
  if (missingVerifiedSpan) {
    return prepareClassificationSchema.parse({
      status: "ambiguous",
      citationRole: "unclear",
      evaluationMode: "manual_review_extraction_limited",
      modifiers: {
        isBundled: citationOccurrence.isBundledCitation,
        isReviewMediated: options.isReviewMediated ?? false,
        bundleSize: citationOccurrence.bundleSize,
      },
      signals: ["extraction:missing_verified_support_span"],
      rationale:
        "One or more occurrence-local claims lack an exact-verified support span in the citing context",
      confidence: "low",
      execution: {
        kind: "deterministic" as const,
        implementation: "canonical-prepare-citation-function-v2",
      },
    });
  }

  const claimSupportText = occurrenceClaims
    .map((claim) => claim.supportSpan?.text)
    .filter((text): text is string => text != null && text.length > 0)
    .join("\n");
  const classified = classifyCitationFunction(
    {
      rawContext: citationOccurrence.rawContext,
      citationMarker: citationOccurrence.citationMarker,
      sectionTitle: citationOccurrence.sectionTitle,
      contextLength: citationOccurrence.rawContext.length,
      confidence,
      isBundledCitation: citationOccurrence.isBundledCitation,
      bundleSize: citationOccurrence.bundleSize,
      ...(claimSupportText.length > 0 ? { claimSupportText } : {}),
    },
    options.isReviewMediated ?? false,
  );
  const modifiers = {
    isBundled: classified.modifiers.isBundled,
    isReviewMediated: classified.modifiers.isReviewMediated,
    bundleSize: citationOccurrence.bundleSize,
  };
  const evaluationMode = deriveEvaluationMode(
    classified.citationRole,
    modifiers,
    confidence,
  );
  const rationale =
    classified.classificationSignals.length > 0
      ? `Deterministic citation-function signals: ${classified.classificationSignals.join(", ")}`
      : "No decisive deterministic citation-function signal was present.";
  const common = {
    evaluationMode,
    modifiers,
    signals: classified.classificationSignals,
    rationale,
    confidence,
    execution: {
      kind: "deterministic" as const,
      implementation: "canonical-prepare-citation-function-v2",
    },
  };
  return prepareClassificationSchema.parse(
    classified.citationRole === "unclear"
      ? {
          status: "ambiguous",
          citationRole: "unclear",
          ...common,
        }
      : {
          status: "classified",
          citationRole: classified.citationRole,
          ...common,
        },
  );
}

type AmbiguousPrepareClassification = Extract<
  PrepareClassification,
  { status: "ambiguous" }
>;

/**
 * True when the deterministic pass left the role unresolved for a reason a
 * model can settle. `manual_review_extraction_limited` is deliberately
 * excluded: those records either lack a verified support span or carry a
 * low-confidence extraction, so there is nothing trustworthy to show a model.
 */
export function prepareRoleNeedsModelFallback(
  classification: PrepareClassification,
): classification is AmbiguousPrepareClassification {
  return (
    classification.status === "ambiguous" &&
    classification.evaluationMode === "manual_review_role_ambiguous"
  );
}

/**
 * Replace an unresolved deterministic role with a model-supplied one. The
 * regex pass stays the free first filter; only its `unclear` verdict reaches a
 * model, and a model that is also unclear leaves the record gated with its
 * call recorded.
 */
export function applyPrepareModelRole(
  deterministic: PrepareClassification,
  model: {
    citationRole: CitationRole;
    rationale: string;
    signals: readonly string[];
    execution: PrepareClassificationFailureExecution;
  },
): PrepareClassification {
  if (!prepareRoleNeedsModelFallback(deterministic)) {
    throw new CanonicalPrepareBoundaryError(
      "Model role fallback applied to a classification the regex pass had already resolved",
    );
  }
  const common = {
    modifiers: deterministic.modifiers,
    signals: [...deterministic.signals, ...model.signals],
    rationale: model.rationale,
    confidence: deterministic.confidence,
    execution: model.execution,
  };
  return prepareClassificationSchema.parse(
    model.citationRole === "unclear"
      ? {
          status: "ambiguous",
          citationRole: "unclear",
          evaluationMode: deterministic.evaluationMode,
          ...common,
        }
      : {
          status: "classified",
          citationRole: model.citationRole,
          evaluationMode: deriveEvaluationMode(
            model.citationRole,
            deterministic.modifiers,
            deterministic.confidence,
          ),
          ...common,
        },
  );
}

function verifyPrepareAncestors(
  scopeArtifact: ScopeArtifact,
  discoverArtifact: DiscoverArtifact,
): void {
  if (scopeArtifact.runId !== discoverArtifact.runId) {
    throw new CanonicalPrepareBoundaryError(
      "Canonical Scope and Discover inputs belong to different runs",
    );
  }
  const discoverReference = scopeArtifact.payload.discoverArtifact;
  if (
    discoverReference.artifactId !== discoverArtifact.artifactId ||
    discoverReference.contentHash !== discoverArtifact.contentHash
  ) {
    throw new CanonicalPrepareBoundaryError(
      "Canonical Scope does not reference the supplied Discover artifact ID and content hash",
    );
  }

  const candidatesById = new Map(
    discoverArtifact.payload.claimCandidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  const dispositionsById = new Map(
    discoverArtifact.payload.candidateDispositions.map((disposition) => [
      disposition.candidateId,
      disposition,
    ]),
  );
  if (scopeArtifact.payload.candidateDecisions.length !== candidatesById.size) {
    throw new CanonicalPrepareBoundaryError(
      "Scope candidate accounting does not cover the exact Discover candidate set",
    );
  }
  for (const decision of scopeArtifact.payload.candidateDecisions) {
    const candidate = candidatesById.get(decision.candidateId);
    const disposition = dispositionsById.get(decision.candidateId);
    if (!candidate || !disposition) {
      throw new CanonicalPrepareBoundaryError(
        `Scope decision references an unknown Discover candidate: ${decision.candidateId}`,
      );
    }
    const expectedDisposition = disposition.selectedForScope
      ? "scoped"
      : "deferred_upstream";
    if (
      decision.seedId !== candidate.seedId ||
      decision.discoverRank !== disposition.rank ||
      decision.discoverReason !== disposition.reason ||
      decision.disposition !== expectedDisposition
    ) {
      throw new CanonicalPrepareBoundaryError(
        `Scope decision differs from its Discover candidate disposition: ${decision.candidateId}`,
      );
    }
    if (
      decision.disposition === "scoped" &&
      (!sameIdentifierSequence(
        decision.sourceClaimRecordIds,
        [...candidate.sourceClaimRecordIds].sort(compareCodeUnits),
      ) ||
        !sameIdentifierSequence(
          decision.memberMentionIds,
          [...candidate.memberMentionIds].sort(compareCodeUnits),
        ))
    ) {
      throw new CanonicalPrepareBoundaryError(
        `Scope decision changed Discover source membership: ${decision.candidateId}`,
      );
    }
  }

  const seedsById = new Map(
    discoverArtifact.payload.seeds.map((seed) => [seed.seedId, seed]),
  );
  const mentionsById = new Map(
    discoverArtifact.payload.citationMentions.map((mention) => [
      mention.mentionId,
      mention,
    ]),
  );
  const citingPapersById = new Map(
    discoverArtifact.payload.citingPapers.map((paper) => [
      paper.citingPaperRecordId,
      paper,
    ]),
  );
  for (const family of scopeArtifact.payload.families) {
    if (!seedsById.has(family.seedId)) {
      throw new CanonicalPrepareBoundaryError(
        `Scope family references an unknown Discover seed: ${family.familyId}`,
      );
    }
    for (const candidateId of family.candidateIds) {
      const candidate = candidatesById.get(candidateId);
      if (!candidate || candidate.seedId !== family.seedId) {
        throw new CanonicalPrepareBoundaryError(
          `Scope family references a dangling or cross-seed Discover candidate: ${candidateId}`,
        );
      }
    }
    for (const mentionId of family.includedCitationOccurrenceIds) {
      const mention = mentionsById.get(mentionId);
      const citingPaper = mention
        ? citingPapersById.get(mention.citingPaperRecordId)
        : undefined;
      if (
        !mention ||
        mention.seedId !== family.seedId ||
        !citingPaper ||
        citingPaper.paper.paperId !== mention.citingPaperId
      ) {
        throw new CanonicalPrepareBoundaryError(
          `Scope family references a dangling or inconsistent Discover occurrence: ${mentionId}`,
        );
      }
    }
  }
}

function classificationExecutionArtifacts(
  execution: PrepareClassification["execution"],
): ArtifactReference[] {
  return execution.kind === "deterministic"
    ? []
    : [execution.requestArtifact, execution.responseArtifact];
}

function classificationActor(
  execution: PrepareClassification["execution"],
): AppendOnlyDecision["actor"] {
  if (execution.kind === "deterministic") {
    return { kind: "deterministic", identifier: execution.implementation };
  }
  if (execution.kind === "model") {
    return {
      kind: "model",
      identifier: `${execution.provider}/${execution.model}`,
    };
  }
  return { kind: "external", identifier: execution.provider };
}

function classificationReason(classification: PrepareClassification): string {
  return classification.status === "failed"
    ? classification.reason
    : classification.rationale;
}

const parseBoundary = createBoundaryParser(CanonicalPrepareBoundaryError);
