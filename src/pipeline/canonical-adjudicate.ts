import { z } from "zod";

import {
  buildCanonicalAdjudicatePacket,
  buildCanonicalAdjudicatePrompt,
  CANONICAL_ADJUDICATE_PROMPT_ID,
  CANONICAL_ADJUDICATE_PROMPT_VERSION,
} from "../adjudication/canonical-adjudicate-packet.js";
import {
  adjudicateArtifactPayloadSchema,
  adjudicateArtifactSchema,
  adjudicateFailureCodeSchema,
  adjudicateFatalFailureCodeSchema,
  adjudicateModelExecutionSchema,
  buildAdjudicationResultId,
  canonicalAdjudicateMethod,
  canonicalAdjudicateModelOutputSchema,
  createAppendOnlyDecision,
  createLeanStageArtifact,
  evidenceArtifactSchema,
  hashCanonicalAdjudicatePrompt,
  hashCanonicalAdjudicateRequest,
  leanArtifactSchemaVersion,
  leanArtifactVersion,
  prepareArtifactSchema,
  type AdjudicateArtifact,
  type AdjudicateArtifactPayload,
  type AdjudicateGateCode,
  type AdjudicateLineage,
  type AdjudicateModelExecution,
  type AdjudicateNonfatalFailureCode,
  type AdjudicateRecordOutcome,
  type AppendOnlyDecision,
  type AppendOnlyExclusion,
  type ArtifactReference,
  type EvidenceArtifact,
  type EvidenceChunk,
  type EvidenceRecordOutcome,
  type EvidenceSelection,
  type LeanArtifactProvenance,
  type PrepareArtifact,
  type PreparedCitationInstance,
} from "../contract/lean-artifacts.js";
import { canonicalSerialize } from "../shared/stable-identity.js";

export const canonicalAdjudicateOptionsSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    evidenceArtifactUri: z.string().min(1).optional(),
    prepareArtifactUri: z.string().min(1).optional(),
  })
  .strict();
export type CanonicalAdjudicateOptions = z.input<
  typeof canonicalAdjudicateOptionsSchema
>;

export const canonicalAdjudicateAdapterResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("completed"),
        rawOutput: z.unknown(),
        execution: adjudicateModelExecutionSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: adjudicateFailureCodeSchema,
        reason: z.string().min(1),
        execution: adjudicateModelExecutionSchema,
      })
      .strict(),
  ],
);
export type CanonicalAdjudicateAdapterResult = z.infer<
  typeof canonicalAdjudicateAdapterResultSchema
>;

export type CanonicalAdjudicateAdapterInput = {
  purpose: "categorical_adjudication";
  recordId: string;
  promptId: typeof CANONICAL_ADJUDICATE_PROMPT_ID;
  promptVersion: typeof CANONICAL_ADJUDICATE_PROMPT_VERSION;
  promptText: string;
  packet: ReturnType<typeof buildCanonicalAdjudicatePacket>;
};

export type CanonicalAdjudicateAdapters = {
  adjudicate?: (input: CanonicalAdjudicateAdapterInput) => Promise<unknown>;
};

export type CanonicalAdjudicateProvenanceInputs = {
  prompts: LeanArtifactProvenance["prompts"];
  models: LeanArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
};

export type CanonicalAdjudicateResult = {
  payload: AdjudicateArtifactPayload;
  decisions: AppendOnlyDecision[];
  exclusions: AppendOnlyExclusion[];
  provenanceInputs: CanonicalAdjudicateProvenanceInputs;
};

export class CanonicalAdjudicateBoundaryError extends Error {
  override readonly name = "CanonicalAdjudicateBoundaryError";
}

export class CanonicalAdjudicateFatalError extends Error {
  override readonly name = "CanonicalAdjudicateFatalError";

  constructor(
    readonly failureCode: z.infer<typeof adjudicateFatalFailureCodeSchema>,
    message: string,
  ) {
    super(message);
  }
}

type GateDecision =
  | { eligible: true; selection: EvidenceSelection; chunks: EvidenceChunk[] }
  | { eligible: false; gateCode: AdjudicateGateCode; reason: string };

export async function runCanonicalAdjudicate(
  evidenceArtifactInput: unknown,
  prepareArtifactInput: unknown,
  adapters: CanonicalAdjudicateAdapters,
  optionsInput: CanonicalAdjudicateOptions,
): Promise<CanonicalAdjudicateResult> {
  const evidenceArtifact = parseBoundary(
    evidenceArtifactSchema,
    evidenceArtifactInput,
    "canonical Evidence input",
  );
  const prepareArtifact = parseBoundary(
    prepareArtifactSchema,
    prepareArtifactInput,
    "canonical Prepare ancestor",
  );
  const options = parseBoundary(
    canonicalAdjudicateOptionsSchema,
    optionsInput,
    "canonical Adjudicate options",
  );
  verifyAdjudicateAncestors(evidenceArtifact, prepareArtifact);

  const lineage = buildAdjudicateLineage(
    evidenceArtifact,
    prepareArtifact,
    options,
  );
  const prepareById = new Map(
    prepareArtifact.payload.records.map((record) => [record.recordId, record]),
  );
  const evidenceById = new Map(
    evidenceArtifact.payload.records.map((record) => [record.recordId, record]),
  );
  const selectionsById = new Map(
    evidenceArtifact.payload.selections.map((selection) => [
      selection.selectionId,
      selection,
    ]),
  );
  const chunksById = new Map(
    evidenceArtifact.payload.corpora.flatMap((corpus) =>
      corpus.chunks.map((chunk) => [chunk.chunkId, chunk] as const),
    ),
  );

  // Stable ordering independent of adapter completion order.
  const orderedEvidenceRecords = [...evidenceArtifact.payload.records].sort(
    (left, right) => compareCodeUnits(left.recordId, right.recordId),
  );

  const outcomes: AdjudicateRecordOutcome[] = [];
  const promptHashes = new Set<string>();
  const modelProvenance: LeanArtifactProvenance["models"] = [];
  const responseArtifacts: ArtifactReference[] = [];

  for (const evidenceOutcome of orderedEvidenceRecords) {
    const prepareRecord = prepareById.get(evidenceOutcome.recordId);
    if (!prepareRecord) {
      throw new CanonicalAdjudicateBoundaryError(
        `Evidence record has no matching Prepare record: ${evidenceOutcome.recordId}`,
      );
    }
    if (
      prepareRecord.familyId !== evidenceOutcome.familyId ||
      prepareRecord.citationOccurrenceId !==
        evidenceOutcome.citationOccurrenceId
    ) {
      throw new CanonicalAdjudicateBoundaryError(
        `Evidence/Prepare identity mismatch for record: ${evidenceOutcome.recordId}`,
      );
    }

    const gate = evaluateAdjudicationGate({
      prepareRecord,
      evidenceOutcome,
      selectionsById,
      chunksById,
    });

    if (!gate.eligible) {
      outcomes.push(
        buildNotAdjudicatedOutcome({
          prepareRecord,
          gateCode: gate.gateCode,
          reason: gate.reason,
        }),
      );
      continue;
    }

    const adjudicate = adapters.adjudicate;
    if (!adjudicate) {
      throw new CanonicalAdjudicateBoundaryError(
        `Canonical Adjudicate requires an adapter for eligible record: ${prepareRecord.recordId}`,
      );
    }
    const packet = buildCanonicalAdjudicatePacket({
      prepareRecord,
      selection: gate.selection,
      selectedChunks: gate.chunks,
    });
    const promptText = buildCanonicalAdjudicatePrompt(packet);
    const promptContentHash = hashCanonicalAdjudicatePrompt(promptText);
    promptHashes.add(promptContentHash);

    const adapterInput: CanonicalAdjudicateAdapterInput = {
      purpose: "categorical_adjudication",
      recordId: prepareRecord.recordId,
      promptId: CANONICAL_ADJUDICATE_PROMPT_ID,
      promptVersion: CANONICAL_ADJUDICATE_PROMPT_VERSION,
      promptText,
      packet,
    };
    const expectedRequestHash = hashCanonicalAdjudicateRequest(adapterInput);
    const adapterRaw = await adjudicate(adapterInput);
    const adapterResult = parseBoundary(
      canonicalAdjudicateAdapterResultSchema,
      adapterRaw,
      `canonical Adjudicate adapter result for ${prepareRecord.recordId}`,
    );
    verifyAdapterExecution({
      recordId: prepareRecord.recordId,
      execution: adapterResult.execution,
      promptContentHash,
      expectedRequestHash,
    });

    modelProvenance.push({
      provider: adapterResult.execution.provider,
      model: adapterResult.execution.model,
      requestHash: adapterResult.execution.requestHash,
      requestArtifact: adapterResult.execution.requestArtifact,
      responseArtifact: adapterResult.execution.responseArtifact,
    });
    responseArtifacts.push(adapterResult.execution.responseArtifact);

    if (adapterResult.status === "failed") {
      if (
        adjudicateFatalFailureCodeSchema.safeParse(adapterResult.reasonCode)
          .success
      ) {
        throw new CanonicalAdjudicateFatalError(
          adapterResult.reasonCode as z.infer<
            typeof adjudicateFatalFailureCodeSchema
          >,
          adapterResult.reason,
        );
      }
      outcomes.push(
        buildFailedOutcome({
          prepareRecord,
          failureCode:
            adapterResult.reasonCode as AdjudicateNonfatalFailureCode,
          reason: adapterResult.reason,
          execution: adapterResult.execution,
        }),
      );
      continue;
    }

    const parsedOutput = canonicalAdjudicateModelOutputSchema.safeParse(
      adapterResult.rawOutput,
    );
    if (!parsedOutput.success) {
      outcomes.push(
        buildInvalidOutputOutcome({
          prepareRecord,
          reason: `Malformed adjudication output: ${parsedOutput.error.issues[0]?.message ?? "invalid JSON shape"}`,
          execution: adapterResult.execution,
        }),
      );
      continue;
    }

    const referenceError = validateModelReferences({
      output: parsedOutput.data,
      prepareRecord,
      selectedChunkIds: gate.selection.selectedChunkIds,
    });
    if (referenceError) {
      outcomes.push(
        buildInvalidOutputOutcome({
          prepareRecord,
          reason: referenceError,
          execution: adapterResult.execution,
        }),
      );
      continue;
    }

    outcomes.push(
      buildAdjudicatedOutcome({
        prepareRecord,
        output: parsedOutput.data,
        selectedChunkIds: gate.selection.selectedChunkIds,
        execution: adapterResult.execution,
      }),
    );
  }

  // Complete Evidence accounting: every Evidence record must appear once.
  if (outcomes.length !== evidenceArtifact.payload.records.length) {
    throw new CanonicalAdjudicateBoundaryError(
      "Canonical Adjudicate did not emit one outcome per Evidence record",
    );
  }
  for (const evidenceOutcome of evidenceArtifact.payload.records) {
    if (!evidenceById.has(evidenceOutcome.recordId)) {
      throw new CanonicalAdjudicateBoundaryError(
        `Missing Evidence record unexpectedly: ${evidenceOutcome.recordId}`,
      );
    }
    if (
      !outcomes.some((outcome) => outcome.recordId === evidenceOutcome.recordId)
    ) {
      throw new CanonicalAdjudicateBoundaryError(
        `Canonical Adjudicate omitted Evidence record: ${evidenceOutcome.recordId}`,
      );
    }
  }

  const payload = adjudicateArtifactPayloadSchema.parse({
    lineage,
    method: canonicalAdjudicateMethod,
    records: outcomes,
  });
  const decisions = createAdjudicateDecisions(
    payload,
    options.recordedAt,
    lineage,
  );
  const provenanceInputs: CanonicalAdjudicateProvenanceInputs = {
    prompts: [...promptHashes].sort(compareCodeUnits).map((contentHash) => ({
      promptId: CANONICAL_ADJUDICATE_PROMPT_ID,
      version: CANONICAL_ADJUDICATE_PROMPT_VERSION,
      contentHash,
    })),
    models: uniqueModelProvenance(modelProvenance),
    responseArtifacts: uniqueSortedArtifactReferences(responseArtifacts),
  };

  return {
    payload,
    decisions,
    exclusions: [],
    provenanceInputs,
  };
}

export function buildCanonicalAdjudicateArtifact(input: {
  result: CanonicalAdjudicateResult;
  runId: string;
  createdAt: string;
  configuration?: LeanArtifactProvenance["configuration"];
  code?: LeanArtifactProvenance["code"];
  implementation?: string;
}): AdjudicateArtifact {
  const hasModelExecution = input.result.provenanceInputs.models.length > 0;
  const provenance: LeanArtifactProvenance = {
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.code ? { code: input.code } : {}),
    prompts: input.result.provenanceInputs.prompts,
    models: input.result.provenanceInputs.models,
  };
  const artifact = createLeanStageArtifact({
    schemaVersion: leanArtifactSchemaVersion,
    artifactVersion: leanArtifactVersion,
    runId: input.runId,
    createdAt: input.createdAt,
    canonicalStage: "adjudicate",
    inputArtifacts: [
      input.result.payload.lineage.evidenceArtifact,
      input.result.payload.lineage.prepareArtifact,
    ],
    provenance,
    execution: hasModelExecution
      ? {
          kind: "model",
          implementation: input.implementation ?? "canonical-adjudicate-v1",
          replayableFromInputs: false,
          responseArtifacts: input.result.provenanceInputs.responseArtifacts,
        }
      : {
          kind: "deterministic",
          implementation: input.implementation ?? "canonical-adjudicate-v1",
          replayableFromInputs: true,
        },
    decisions: input.result.decisions,
    exclusions: input.result.exclusions,
    payload: input.result.payload,
  });
  return parseBoundary(
    adjudicateArtifactSchema,
    artifact,
    "canonical Adjudicate artifact",
  );
}

function verifyAdapterExecution(input: {
  recordId: string;
  execution: AdjudicateModelExecution;
  promptContentHash: string;
  expectedRequestHash: string;
}): void {
  const { execution } = input;
  if (
    execution.promptId !== CANONICAL_ADJUDICATE_PROMPT_ID ||
    execution.promptVersion !== CANONICAL_ADJUDICATE_PROMPT_VERSION ||
    execution.promptContentHash !== input.promptContentHash
  ) {
    throw new CanonicalAdjudicateBoundaryError(
      `Adjudicate adapter execution does not match the exact prompt sent: ${input.recordId}`,
    );
  }
  if (execution.requestHash !== input.expectedRequestHash) {
    throw new CanonicalAdjudicateBoundaryError(
      `Adjudicate adapter execution does not match the exact request sent: ${input.recordId}`,
    );
  }
}

function verifyAdjudicateAncestors(
  evidenceArtifact: EvidenceArtifact,
  prepareArtifact: PrepareArtifact,
): void {
  if (
    evidenceArtifact.runId !== prepareArtifact.runId ||
    evidenceArtifact.payload.lineage.runId !== prepareArtifact.runId ||
    prepareArtifact.payload.lineage.runId !== prepareArtifact.runId
  ) {
    throw new CanonicalAdjudicateBoundaryError(
      "Canonical Evidence and Prepare inputs belong to different runs",
    );
  }
  const prepareReference = evidenceArtifact.payload.lineage.prepareArtifact;
  if (
    prepareReference.artifactId !== prepareArtifact.artifactId ||
    prepareReference.contentHash !== prepareArtifact.contentHash
  ) {
    throw new CanonicalAdjudicateBoundaryError(
      "Canonical Evidence does not reference the supplied Prepare artifact ID and content hash",
    );
  }

  const evidenceLedger = evidenceArtifact.payload.preparedRecords;
  const prepareLedger = prepareArtifact.payload.records.map((record) => ({
    recordId: record.recordId,
    familyId: record.familyId,
    citationOccurrenceId: record.citationOccurrenceId,
    seedId: record.seed.seedId,
  }));
  if (
    canonicalSerialize(evidenceLedger) !== canonicalSerialize(prepareLedger)
  ) {
    throw new CanonicalAdjudicateBoundaryError(
      "Canonical Evidence prepared-record ledger does not match the supplied Prepare records",
    );
  }
  if (
    evidenceArtifact.payload.records.length !==
    prepareArtifact.payload.records.length
  ) {
    throw new CanonicalAdjudicateBoundaryError(
      "Canonical Evidence record count does not match Prepare record count",
    );
  }
  const prepareIds = new Set(
    prepareArtifact.payload.records.map((record) => record.recordId),
  );
  for (const record of evidenceArtifact.payload.records) {
    if (!prepareIds.has(record.recordId)) {
      throw new CanonicalAdjudicateBoundaryError(
        `Evidence outcome has no Prepare ancestor record: ${record.recordId}`,
      );
    }
  }
}

function evaluateAdjudicationGate(input: {
  prepareRecord: PreparedCitationInstance;
  evidenceOutcome: EvidenceRecordOutcome;
  selectionsById: Map<string, EvidenceSelection>;
  chunksById: Map<string, EvidenceChunk>;
}): GateDecision {
  const { prepareRecord, evidenceOutcome, selectionsById, chunksById } = input;
  const classificationGate = classificationGateDecision(prepareRecord);
  if (classificationGate) {
    return classificationGate;
  }

  const contextText = prepareRecord.context.verbatim.text.trim();
  if (contextText.length === 0) {
    return {
      eligible: false,
      gateCode: "invalid_context",
      reason: "Prepared citing context is empty or whitespace-only",
    };
  }
  if (prepareRecord.occurrenceSourceClaimRecords.length === 0) {
    return {
      eligible: false,
      gateCode: "invalid_context",
      reason: "Prepared record has no occurrence-local attributed claims",
    };
  }

  switch (evidenceOutcome.retrievalStatus) {
    case "seed_text_unavailable":
      return {
        eligible: false,
        gateCode: "seed_text_unavailable",
        reason: "Cited seed text was unavailable for evidence retrieval",
      };
    case "seed_acquisition_failed":
      return {
        eligible: false,
        gateCode: "seed_acquisition_failed",
        reason: "Cited seed text acquisition failed before retrieval",
      };
    case "retrieval_failed":
      return {
        eligible: false,
        gateCode: "retrieval_failed",
        reason:
          evidenceOutcome.failure?.reason ??
          "Cited-manuscript retrieval failed before final selection",
      };
    case "no_lexical_matches":
      return {
        eligible: false,
        gateCode: "no_lexical_matches",
        reason:
          "BM25 found no lexical matches; operational non-adjudication, not a fidelity verdict",
      };
    case "retrieved":
      break;
    default: {
      const _exhaustive: never = evidenceOutcome.retrievalStatus;
      return _exhaustive;
    }
  }

  if (evidenceOutcome.finalSelectionId == null) {
    throw new CanonicalAdjudicateBoundaryError(
      `Validated retrieved Evidence outcome lost its final selection: ${evidenceOutcome.recordId}`,
    );
  }
  const selection = selectionsById.get(evidenceOutcome.finalSelectionId);
  if (!selection) {
    throw new CanonicalAdjudicateBoundaryError(
      `Validated Evidence selection map is corrupt: ${evidenceOutcome.finalSelectionId}`,
    );
  }
  if (selection.selectedChunkIds.length === 0) {
    throw new CanonicalAdjudicateBoundaryError(
      `Validated Evidence selection became empty: ${selection.selectionId}`,
    );
  }

  const chunks: EvidenceChunk[] = [];
  for (const chunkId of selection.selectedChunkIds) {
    const chunk = chunksById.get(chunkId);
    if (!chunk) {
      throw new CanonicalAdjudicateBoundaryError(
        `Validated Evidence chunk map is corrupt: ${chunkId}`,
      );
    }
    chunks.push(chunk);
  }

  // Scope grounding status (including scientific not_found and operational
  // grounding_failed) is intentionally not a gate when Evidence independently
  // carries exact selected cited text. Prior grounding verdicts are also
  // excluded from the model packet.
  return { eligible: true, selection, chunks };
}

function classificationGateDecision(
  prepareRecord: PreparedCitationInstance,
): GateDecision | undefined {
  const classification = prepareRecord.classification;
  if (classification.status === "failed") {
    return {
      eligible: false,
      gateCode: "classification_failed",
      reason: classification.reason,
    };
  }
  if (classification.status === "ambiguous") {
    if (classification.evaluationMode === "manual_review_extraction_limited") {
      return {
        eligible: false,
        gateCode: "manual_review_extraction_limited",
        reason:
          "Citation role/extraction is limited and reserved for manual review",
      };
    }
    if (classification.evaluationMode === "manual_review_role_ambiguous") {
      return {
        eligible: false,
        gateCode: "manual_review_role_ambiguous",
        reason: "Citation role is ambiguous and reserved for manual review",
      };
    }
    return {
      eligible: false,
      gateCode: "ambiguous_citation_role",
      reason: "Citation role is unclear and is not model-adjudicated",
    };
  }
  if (classification.citationRole === "acknowledgment_or_low_information") {
    return {
      eligible: false,
      gateCode: "skip_low_information",
      reason: "Low-information citation role is not model-adjudicated",
    };
  }
  if (classification.evaluationMode === "skip_low_information") {
    return {
      eligible: false,
      gateCode: "skip_low_information",
      reason: "Skip/low-information evaluation mode is not model-adjudicated",
    };
  }
  if (classification.evaluationMode === "manual_review_role_ambiguous") {
    return {
      eligible: false,
      gateCode: "manual_review_role_ambiguous",
      reason: "Citation role is reserved for manual review",
    };
  }
  if (classification.evaluationMode === "manual_review_extraction_limited") {
    return {
      eligible: false,
      gateCode: "manual_review_extraction_limited",
      reason: "Extraction-limited citation is reserved for manual review",
    };
  }
  return undefined;
}

function validateModelReferences(input: {
  output: z.infer<typeof canonicalAdjudicateModelOutputSchema>;
  prepareRecord: PreparedCitationInstance;
  selectedChunkIds: readonly string[];
}): string | undefined {
  const allowedClaims = new Set(
    input.prepareRecord.occurrenceSourceClaimRecords.map(
      (claim) => claim.claimRecordId,
    ),
  );
  const allowedChunks = new Set(input.selectedChunkIds);
  const seenClaims = new Set<string>();
  for (const claimId of input.output.evaluatedClaimRecordIds) {
    if (!allowedClaims.has(claimId)) {
      return `Unknown occurrence-local claim reference: ${claimId}`;
    }
    if (seenClaims.has(claimId)) {
      return `Duplicate occurrence-local claim reference: ${claimId}`;
    }
    seenClaims.add(claimId);
  }
  if (seenClaims.size !== allowedClaims.size) {
    const missingClaimIds = [...allowedClaims].filter(
      (claimId) => !seenClaims.has(claimId),
    );
    return `Model omitted occurrence-local claim references: ${missingClaimIds.join(", ")}`;
  }
  const seenChunks = new Set<string>();
  for (const chunkId of input.output.citedChunkIds) {
    if (!allowedChunks.has(chunkId)) {
      return `Unknown selected chunk reference: ${chunkId}`;
    }
    if (seenChunks.has(chunkId)) {
      return `Duplicate selected chunk reference: ${chunkId}`;
    }
    seenChunks.add(chunkId);
  }
  return undefined;
}

function buildAdjudicatedOutcome(input: {
  prepareRecord: PreparedCitationInstance;
  output: z.infer<typeof canonicalAdjudicateModelOutputSchema>;
  selectedChunkIds: readonly string[];
  execution: AdjudicateModelExecution;
}): AdjudicateRecordOutcome {
  const evaluatedClaimRecordIds =
    input.prepareRecord.occurrenceSourceClaimRecords.map(
      (claim) => claim.claimRecordId,
    );
  const evaluatedCitingClaimText =
    input.prepareRecord.occurrenceSourceClaimRecords
      .map((claim) => claim.extractedClaimText)
      .join("\n");
  const citedChunkIds = new Set(input.output.citedChunkIds);
  const modelCitedChunkIds = input.selectedChunkIds.filter((chunkId) =>
    citedChunkIds.has(chunkId),
  );
  const draft = {
    recordId: input.prepareRecord.recordId,
    familyId: input.prepareRecord.familyId,
    citationOccurrenceId: input.prepareRecord.citationOccurrenceId,
    status: "adjudicated" as const,
    verdict: input.output.verdict,
    comparison: input.output.comparison,
    rationale: input.output.rationale,
    confidence: input.output.confidence,
    evaluatedCitingClaimText,
    evaluatedClaimRecordIds,
    selectedCitedChunkIds: [...input.selectedChunkIds],
    modelCitedChunkIds,
    execution: input.execution,
  };
  return {
    ...draft,
    adjudicationResultId: buildAdjudicationResultId(draft),
  };
}

function buildNotAdjudicatedOutcome(input: {
  prepareRecord: PreparedCitationInstance;
  gateCode: AdjudicateGateCode;
  reason: string;
}): AdjudicateRecordOutcome {
  const draft = {
    recordId: input.prepareRecord.recordId,
    familyId: input.prepareRecord.familyId,
    citationOccurrenceId: input.prepareRecord.citationOccurrenceId,
    status: "not_adjudicated" as const,
    gateCode: input.gateCode,
    reason: input.reason,
  };
  return {
    ...draft,
    adjudicationResultId: buildAdjudicationResultId(draft),
  };
}

function buildFailedOutcome(input: {
  prepareRecord: PreparedCitationInstance;
  failureCode: AdjudicateNonfatalFailureCode;
  reason: string;
  execution: AdjudicateModelExecution;
}): AdjudicateRecordOutcome {
  const draft = {
    recordId: input.prepareRecord.recordId,
    familyId: input.prepareRecord.familyId,
    citationOccurrenceId: input.prepareRecord.citationOccurrenceId,
    status: "adjudication_failed" as const,
    failureCode: input.failureCode,
    reason: input.reason,
    execution: input.execution,
  };
  return {
    ...draft,
    adjudicationResultId: buildAdjudicationResultId(draft),
  };
}

function buildInvalidOutputOutcome(input: {
  prepareRecord: PreparedCitationInstance;
  reason: string;
  execution: AdjudicateModelExecution;
}): AdjudicateRecordOutcome {
  const draft = {
    recordId: input.prepareRecord.recordId,
    familyId: input.prepareRecord.familyId,
    citationOccurrenceId: input.prepareRecord.citationOccurrenceId,
    status: "invalid_output" as const,
    reason: input.reason,
    execution: input.execution,
  };
  return {
    ...draft,
    adjudicationResultId: buildAdjudicationResultId(draft),
  };
}

function buildAdjudicateLineage(
  evidenceArtifact: EvidenceArtifact,
  prepareArtifact: PrepareArtifact,
  options: z.output<typeof canonicalAdjudicateOptionsSchema>,
): AdjudicateLineage {
  return {
    runId: evidenceArtifact.runId,
    evidenceArtifact: {
      artifactId: evidenceArtifact.artifactId,
      contentHash: evidenceArtifact.contentHash,
      role: "canonical-evidence-input",
      canonicalStage: "evidence",
      ...(options.evidenceArtifactUri
        ? { uri: options.evidenceArtifactUri }
        : {}),
    },
    prepareArtifact: {
      artifactId: prepareArtifact.artifactId,
      contentHash: prepareArtifact.contentHash,
      role: "canonical-prepare-input",
      canonicalStage: "prepare",
      ...(options.prepareArtifactUri
        ? { uri: options.prepareArtifactUri }
        : {}),
    },
  };
}

function createAdjudicateDecisions(
  payload: AdjudicateArtifactPayload,
  recordedAt: string,
  lineage: AdjudicateLineage,
): AppendOnlyDecision[] {
  const baseArtifacts = [lineage.evidenceArtifact, lineage.prepareArtifact];
  return payload.records.flatMap((record) => {
    const modelArtifacts =
      record.status === "adjudicated" ||
      record.status === "adjudication_failed" ||
      record.status === "invalid_output"
        ? [record.execution.requestArtifact, record.execution.responseArtifact]
        : [];
    const gateOutcome =
      record.status === "not_adjudicated" ? record.gateCode : "eligible";
    const gateReason =
      record.status === "not_adjudicated"
        ? record.reason
        : "Record passed deterministic adjudicability gates";
    const modelOutcome =
      record.status === "not_adjudicated"
        ? "not_attempted"
        : record.status === "adjudicated"
          ? "completed"
          : record.status;
    const modelReason =
      record.status === "not_adjudicated"
        ? "Model adjudication was not attempted because the record was gated"
        : record.status === "adjudicated"
          ? `Categorical verdict ${record.verdict} recorded (confidence does not alter routing)`
          : record.reason;
    const finalOutcome = record.status;
    const finalReason =
      record.status === "adjudicated"
        ? `Final categorical verdict ${record.verdict}`
        : record.reason;

    return [
      createAppendOnlyDecision({
        recordId: record.recordId,
        decisionType: "adjudicate_gate_outcome",
        outcome: gateOutcome,
        reason: gateReason,
        recordedAt,
        actor: {
          kind: "deterministic",
          identifier: "canonical-adjudicate-gate-v1",
        },
        evidenceArtifacts: baseArtifacts,
      }),
      createAppendOnlyDecision({
        recordId: record.recordId,
        decisionType: "adjudicate_model_outcome",
        outcome: modelOutcome,
        reason: modelReason,
        recordedAt,
        actor:
          record.status === "not_adjudicated"
            ? {
                kind: "deterministic",
                identifier: "canonical-adjudicate-gate-v1",
              }
            : {
                kind: "model",
                identifier: `${record.execution.provider}/${record.execution.model}`,
              },
        evidenceArtifacts: uniqueSortedArtifactReferences([
          ...baseArtifacts,
          ...modelArtifacts,
        ]),
      }),
      createAppendOnlyDecision({
        recordId: record.recordId,
        decisionType: "adjudicate_final_outcome",
        outcome: finalOutcome,
        reason: finalReason,
        recordedAt,
        actor:
          record.status === "not_adjudicated"
            ? {
                kind: "deterministic",
                identifier: "canonical-adjudicate-gate-v1",
              }
            : {
                kind: "model",
                identifier: `${record.execution.provider}/${record.execution.model}`,
              },
        evidenceArtifacts: uniqueSortedArtifactReferences([
          ...baseArtifacts,
          ...modelArtifacts,
        ]),
      }),
    ];
  });
}

function uniqueModelProvenance(
  models: LeanArtifactProvenance["models"],
): LeanArtifactProvenance["models"] {
  const seen = new Set<string>();
  const unique: LeanArtifactProvenance["models"] = [];
  for (const model of models) {
    const key = canonicalSerialize(model);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(model);
  }
  return unique.sort((left, right) =>
    compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
  );
}

function uniqueSortedArtifactReferences(
  references: ArtifactReference[],
): ArtifactReference[] {
  const seen = new Set<string>();
  const unique: ArtifactReference[] = [];
  for (const reference of references) {
    const key = canonicalSerialize(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique.sort((left, right) =>
    compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
  );
}

function parseBoundary<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "<root>";
    throw new CanonicalAdjudicateBoundaryError(
      `Invalid ${label} at ${path}: ${issue?.message ?? parsed.error.message}`,
    );
  }
  return parsed.data;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
