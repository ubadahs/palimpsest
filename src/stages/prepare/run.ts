import { z } from "zod";

import { uniqueSortedArtifactReferences } from "../../contract/artifacts/primitives.js";
import { compareCodeUnits, uniqueSorted } from "../../shared/order.js";
import { sameIdentifierSequence } from "../../contract/artifacts/checks.js";
import { createBoundaryParser } from "../../shared/boundary.js";
import { pMap } from "../../shared/concurrency.js";

import { classifyRoleByRules } from "./role-rules.js";
import { deriveEvaluationMode } from "./evaluation-mode.js";
import type { CitationRole } from "../../domain/classification.js";
import {
  buildCitationInstanceRecordId,
  createAppendOnlyDecision,
  createStageArtifact,
  discoverArtifactSchema,
  currentArtifactSchemaVersion,
  currentArtifactVersion,
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
  type DiscoverAttributedClaimRecord,
  type DiscoverCitationOccurrence,
  type DiscoverClaimCandidate,
  type DiscoverCitingPaperRecord,
  type DiscoverSeed,
  type ArtifactProvenance,
  type PrepareArtifact,
  type PrepareArtifactPayload,
  type PrepareClassification,
  type PreparedCitationInstance,
  type ScopeArtifact,
  type ScopedFamily,
} from "../../contract/artifacts/index.js";

export const prepareOptionsSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    scopeArtifactUri: z.string().min(1).optional(),
    /** Classifier requests in flight at once; results keep input order. */
    concurrency: z.number().int().positive().optional(),
  })
  .strict();
export type PrepareOptions = z.infer<typeof prepareOptionsSchema>;

const fatalClassificationResultSchema = z
  .object({
    status: z.literal("failed"),
    reasonCode: prepareFatalFailureCodeSchema,
    reason: z.string().min(1),
    execution: prepareClassificationFailureExecutionSchema,
  })
  .strict();

export const prepareClassificationResultSchema = z.union([
  prepareClassificationSchema,
  fatalClassificationResultSchema,
]);
export type PrepareClassifierInput = {
  family: ScopedFamily;
  sourceCandidates: DiscoverClaimCandidate[];
  sourceClaimRecords: DiscoverAttributedClaimRecord[];
  occurrenceSourceCandidates: DiscoverClaimCandidate[];
  occurrenceSourceClaimRecords: DiscoverAttributedClaimRecord[];
  seed: DiscoverSeed;
  citingPaper: DiscoverCitingPaperRecord;
  citationOccurrence: DiscoverCitationOccurrence;
};

export type PrepareAdapters = {
  classifyCitation: (input: PrepareClassifierInput) => Promise<unknown>;
};

type PrepareProvenanceInputs = {
  prompts: ArtifactProvenance["prompts"];
  models: ArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
  hasModelExecution: boolean;
  hasExternalExecution: boolean;
};

export type PrepareResult = {
  payload: PrepareArtifactPayload;
  decisions: AppendOnlyDecision[];
  provenanceInputs: PrepareProvenanceInputs;
};

export class PrepareBoundaryError extends Error {
  override readonly name = "PrepareBoundaryError";
}

export class PrepareFatalError extends Error {
  override readonly name = "PrepareFatalError";

  constructor(
    readonly failureCode: z.infer<typeof prepareFatalFailureCodeSchema>,
    message: string,
  ) {
    super(message);
  }
}

export async function runPrepare(
  scopeArtifactInput: unknown,
  discoverArtifactInput: unknown,
  adapters: PrepareAdapters,
  optionsInput: PrepareOptions,
): Promise<PrepareResult> {
  const scopeArtifact = parseBoundary(
    scopeArtifactSchema,
    scopeArtifactInput,
    "Scope input",
  );
  const discoverArtifact = parseBoundary(
    discoverArtifactSchema,
    discoverArtifactInput,
    "Discover ancestor",
  );
  const options = parseBoundary(
    prepareOptionsSchema,
    optionsInput,
    "Prepare options",
  );
  verifyPrepareAncestors(scopeArtifact, discoverArtifact);

  const lineage: PrepareArtifactPayload["lineage"] = {
    runId: scopeArtifact.runId,
    scopeArtifact: {
      artifactId: scopeArtifact.artifactId,
      contentHash: scopeArtifact.contentHash,
      role: "scope-input",
      stage: "scope",
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
  const pending: Array<{
    family: ScopedFamily;
    citationOccurrenceId: string;
    citingPaper: DiscoverCitingPaperRecord;
    occurrenceSourceCandidates: DiscoverClaimCandidate[];
    occurrenceSourceClaimRecords: DiscoverAttributedClaimRecord[];
    request: PrepareClassifierInput;
  }> = [];
  const preparedSeeds = new Map<string, DiscoverSeed>();
  const preparedCandidates = new Map<string, DiscoverClaimCandidate>();
  const preparedClaims = new Map<string, DiscoverAttributedClaimRecord>();
  const preparedCitingPapers = new Map<string, DiscoverCitingPaperRecord>();
  const decisions: AppendOnlyDecision[] = [];
  const prompts: ArtifactProvenance["prompts"] = [];
  const models: ArtifactProvenance["models"] = [];
  const responseArtifacts: ArtifactReference[] = [];
  let hasModelExecution = false;
  let hasExternalExecution = false;

  for (const family of scopeArtifact.payload.families) {
    const seed = seedsById.get(family.seedId);
    if (!seed) {
      throw new PrepareBoundaryError(
        `Scope family references an unknown Discover seed: ${family.familyId}`,
      );
    }
    const sourceCandidates = family.candidateIds.map((candidateId) => {
      const candidate = candidatesById.get(candidateId);
      if (!candidate) {
        throw new PrepareBoundaryError(
          `Scope family references an unknown Discover candidate: ${candidateId}`,
        );
      }
      return candidate;
    });
    const sourceClaimRecords = family.sourceClaimRecordIds.map(
      (sourceClaimRecordId) => {
        const sourceClaim = sourceClaimsById.get(sourceClaimRecordId);
        if (!sourceClaim) {
          throw new PrepareBoundaryError(
            `Scope family references an unknown Discover source claim: ${sourceClaimRecordId}`,
          );
        }
        return sourceClaim;
      },
    );
    preparedSeeds.set(seed.seedId, seed);
    for (const candidate of sourceCandidates) {
      preparedCandidates.set(candidate.candidateId, candidate);
    }
    for (const sourceClaim of sourceClaimRecords) {
      preparedClaims.set(sourceClaim.claimRecordId, sourceClaim);
    }
    for (const citationOccurrenceId of family.includedCitationOccurrenceIds) {
      const citationOccurrence = occurrencesById.get(citationOccurrenceId);
      if (!citationOccurrence) {
        throw new PrepareBoundaryError(
          `Scope family references an unknown Discover occurrence: ${citationOccurrenceId}`,
        );
      }
      const citingPaper = citingPapersById.get(
        citationOccurrence.citingPaperRecordId,
      );
      if (!citingPaper) {
        throw new PrepareBoundaryError(
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
        throw new PrepareBoundaryError(
          `Scoped pair has no occurrence-local source provenance: ${family.familyId} × ${citationOccurrenceId}`,
        );
      }
      pending.push({
        family,
        citationOccurrenceId,
        citingPaper,
        occurrenceSourceCandidates,
        occurrenceSourceClaimRecords,
        request: {
          family,
          sourceCandidates,
          sourceClaimRecords,
          occurrenceSourceCandidates,
          occurrenceSourceClaimRecords,
          seed,
          citingPaper,
          citationOccurrence,
        },
      });
    }
  }

  // Role classification is the only model call in Prepare (the regex pass's
  // unclear verdicts), so it fans out like every other stage's calls. pMap
  // returns results in input order and everything below appends in that
  // order, so the artifact is identical at any concurrency.
  const classified = await pMap(
    pending,
    async (entry) => {
      const classificationResult = parseBoundary(
        prepareClassificationResultSchema,
        await adapters.classifyCitation(entry.request),
        `classification for ${entry.family.familyId} × ${entry.citationOccurrenceId}`,
      );
      if (
        classificationResult.status === "failed" &&
        prepareFatalFailureCodeSchema.safeParse(classificationResult.reasonCode)
          .success
      ) {
        throw new PrepareFatalError(
          prepareFatalFailureCodeSchema.parse(classificationResult.reasonCode),
          classificationResult.reason,
        );
      }
      return { ...entry, classificationResult };
    },
    { concurrency: options.concurrency ?? 1 },
  );

  for (const {
    family,
    citationOccurrenceId,
    citingPaper,
    occurrenceSourceCandidates,
    occurrenceSourceClaimRecords,
    request: { citationOccurrence },
    classificationResult,
  } of classified) {
    const classification =
      prepareClassificationSchema.parse(classificationResult);
    const recordId = buildCitationInstanceRecordId({
      familyId: family.familyId,
      citationOccurrenceId,
    });
    preparedCitingPapers.set(citingPaper.citingPaperRecordId, citingPaper);
    records.push({
      recordId,
      familyId: family.familyId,
      citationOccurrenceId,
      occurrenceSourceCandidateIds: occurrenceSourceCandidates.map(
        (candidate) => candidate.candidateId,
      ),
      occurrenceSourceClaimRecordIds: occurrenceSourceClaimRecords.map(
        (sourceClaim) => sourceClaim.claimRecordId,
      ),
      citationOccurrence,
      classification,
    });

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

  const payload = parseBoundary(
    prepareArtifactPayloadSchema,
    {
      lineage,
      seeds: sortedById(preparedSeeds),
      scopedFamilies: scopeArtifact.payload.families,
      sourceCandidates: sortedById(preparedCandidates),
      sourceClaimRecords: sortedById(preparedClaims),
      citingPapers: sortedById(preparedCitingPapers),
      records: records.sort((left, right) =>
        compareCodeUnits(left.recordId, right.recordId),
      ),
    },
    "Prepare payload",
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

export function buildPrepareArtifact(input: {
  result: PrepareResult;
  runId: string;
  createdAt: string;
  implementation?: string | undefined;
  configuration?: ArtifactProvenance["configuration"] | undefined;
  code?: ArtifactProvenance["code"] | undefined;
}): PrepareArtifact {
  if (input.runId !== input.result.payload.lineage.runId) {
    throw new PrepareBoundaryError(
      "Prepare artifact run ID differs from its verified Scope and Discover inputs",
    );
  }
  const provenance: ArtifactProvenance = {
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
          implementation: input.implementation ?? "prepare-v2",
          replayableFromInputs: true,
        } as const)
      : ({
          kind: executionKind,
          implementation: input.implementation ?? "prepare-v2",
          replayableFromInputs: false,
          responseArtifacts,
        } as const);
  const artifact = createStageArtifact({
    schemaVersion: currentArtifactSchemaVersion,
    artifactVersion: currentArtifactVersion,
    runId: input.runId,
    createdAt: input.createdAt,
    stage: "prepare",
    inputArtifacts: [
      input.result.payload.lineage.scopeArtifact,
      input.result.payload.lineage.discoverArtifact,
    ],
    provenance,
    execution,
    decisions: input.result.decisions,
    payload: input.result.payload,
  });
  return parseBoundary(prepareArtifactSchema, artifact, "Prepare artifact");
}

function sortedById<T>(byId: ReadonlyMap<string, T>): T[] {
  return [...byId.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, value]) => value);
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

function weakestClaimConfidence(
  claims: readonly DiscoverAttributedClaimRecord[],
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
    occurrenceSourceClaimRecords?: readonly DiscoverAttributedClaimRecord[];
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
        implementation: "prepare-role-rules-v3",
      },
    });
  }

  const claimSupportText = occurrenceClaims
    .map((claim) => claim.supportSpan?.text)
    .filter((text): text is string => text != null && text.length > 0)
    .join("\n");
  const classified = classifyRoleByRules(
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
  );
  const rationale =
    classified.classificationSignals.length > 0
      ? `Deterministic citation-role signals: ${classified.classificationSignals.join(", ")}`
      : "No decisive deterministic citation-role signal was present.";
  const common = {
    evaluationMode,
    modifiers,
    signals: classified.classificationSignals,
    rationale,
    confidence,
    execution: {
      kind: "deterministic" as const,
      implementation: "prepare-role-rules-v3",
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
 * excluded: those records lack a verified support span, so there is no
 * verified text to show a model.
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
    throw new PrepareBoundaryError(
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
    throw new PrepareBoundaryError(
      "Scope and Discover inputs belong to different runs",
    );
  }
  const discoverReference = scopeArtifact.payload.discoverArtifact;
  if (
    discoverReference.artifactId !== discoverArtifact.artifactId ||
    discoverReference.contentHash !== discoverArtifact.contentHash
  ) {
    throw new PrepareBoundaryError(
      "Scope does not reference the supplied Discover artifact ID and content hash",
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
    throw new PrepareBoundaryError(
      "Scope candidate accounting does not cover the exact Discover candidate set",
    );
  }
  for (const decision of scopeArtifact.payload.candidateDecisions) {
    const candidate = candidatesById.get(decision.candidateId);
    const disposition = dispositionsById.get(decision.candidateId);
    if (!candidate || !disposition) {
      throw new PrepareBoundaryError(
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
      throw new PrepareBoundaryError(
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
      throw new PrepareBoundaryError(
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
      throw new PrepareBoundaryError(
        `Scope family references an unknown Discover seed: ${family.familyId}`,
      );
    }
    for (const candidateId of family.candidateIds) {
      const candidate = candidatesById.get(candidateId);
      if (!candidate || candidate.seedId !== family.seedId) {
        throw new PrepareBoundaryError(
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
        throw new PrepareBoundaryError(
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

const parseBoundary = createBoundaryParser(PrepareBoundaryError);
