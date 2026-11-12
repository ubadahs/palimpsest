import { z } from "zod";

import { uniqueSortedArtifactReferences } from "../contract/lean-artifact-primitives.js";
import { pMap } from "../shared/concurrency.js";
import { compareCodeUnits } from "../shared/order.js";
import { createBoundaryParser } from "../shared/boundary.js";

import {
  assessAdjudicatePacketQuality,
  buildCanonicalAdjudicatePacket,
  buildCanonicalAdjudicatePrompt,
  CANONICAL_ADJUDICATE_PROMPT_ID,
  CANONICAL_ADJUDICATE_PROMPT_VERSION,
  packetEvidenceLimitation,
  type CanonicalAdjudicatePacket,
} from "../adjudication/canonical-adjudicate-packet.js";
import {
  buildSeedTextAdjudicatePrompt,
  chunkIdsHoldingQuotes,
  resolveSeedTextJudgment,
  SEED_TEXT_ADJUDICATE_PROMPT_ID,
  SEED_TEXT_ADJUDICATE_PROMPT_VERSION,
  SEED_TEXT_MAX_CHARACTERS,
  seedTextAdjudicateReplySchema,
  seedTextBlocksFromCorpus,
  type SeedTextBlock,
  type SeedTextJudgment,
} from "../adjudication/seed-text-adjudicate.js";
import {
  adjudicateArtifactPayloadSchema,
  adjudicateArtifactSchema,
  adjudicateFailureCodeSchema,
  adjudicateFatalFailureCodeSchema,
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
  type AdjudicateNonfatalFailureCode,
  type AdjudicateRecordOutcome,
  type AppendOnlyDecision,
  type ArtifactReference,
  type EvidenceArtifact,
  type EvidenceChunk,
  type EvidenceRecordOutcome,
  type EvidenceSelection,
  type LeanArtifactProvenance,
  type PrepareArtifact,
  resolvePreparedRecords,
  type ResolvedPreparedCitationInstance,
} from "../contract/lean-artifacts.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "../contract/model-execution.js";
import { adjudicationEvidenceSchema } from "../contract/run-types.js";
import type { Result } from "../domain/common.js";
import { canonicalSerialize } from "../shared/stable-identity.js";

const canonicalAdjudicateOptionsSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    evidenceArtifactUri: z.string().min(1).optional(),
    prepareArtifactUri: z.string().min(1).optional(),
    /** Model requests in flight at once; results keep input order. */
    concurrency: z.number().int().positive().optional(),
    /** What the adjudicator reads of the seed paper. */
    evidence: adjudicationEvidenceSchema,
    /** A longer seed text is adjudicated from its selected chunks instead. */
    seedTextMaxCharacters: z
      .number()
      .int()
      .positive()
      .default(SEED_TEXT_MAX_CHARACTERS),
  })
  .strict();
export type CanonicalAdjudicateOptions = z.input<
  typeof canonicalAdjudicateOptionsSchema
>;

const canonicalAdjudicateAdapterResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      rawOutput: z.unknown(),
      execution: modelExecutionSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reasonCode: adjudicateFailureCodeSchema,
      reason: z.string().min(1),
      execution: modelExecutionSchema,
    })
    .strict(),
]);
/**
 * One request to the adjudication model. A whole-seed-text request keeps the
 * seed text apart as a prefix, which is the same for every record of a seed
 * and so can be cached by the provider.
 */
export type CanonicalAdjudicateAdapterInput = {
  purpose: "categorical_adjudication";
  recordId: string;
  packet: CanonicalAdjudicatePacket;
} & (
  | {
      evidence: "selected_chunks";
      promptId: typeof CANONICAL_ADJUDICATE_PROMPT_ID;
      promptVersion: typeof CANONICAL_ADJUDICATE_PROMPT_VERSION;
      promptText: string;
    }
  | {
      evidence: "seed_text";
      promptId: typeof SEED_TEXT_ADJUDICATE_PROMPT_ID;
      promptVersion: typeof SEED_TEXT_ADJUDICATE_PROMPT_VERSION;
      promptPrefix: string;
      promptSuffix: string;
    }
);

/** The whole prompt a request sends, as its content hash covers it. */
export function adjudicatePromptText(
  request: CanonicalAdjudicateAdapterInput,
): string {
  return request.evidence === "seed_text"
    ? request.promptPrefix + request.promptSuffix
    : request.promptText;
}

export type CanonicalAdjudicateAdapters = {
  adjudicate?: (input: CanonicalAdjudicateAdapterInput) => Promise<unknown>;
};

type CanonicalAdjudicateProvenanceInputs = {
  prompts: LeanArtifactProvenance["prompts"];
  models: LeanArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
};

export type CanonicalAdjudicateResult = {
  payload: AdjudicateArtifactPayload;
  decisions: AppendOnlyDecision[];
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

type EvidenceLimitation = ReturnType<typeof packetEvidenceLimitation>;

/** A verdict whose references to the seed have been checked. */
type CheckedJudgment = Pick<
  SeedTextJudgment,
  | "citingAssertion"
  | "sourceStatement"
  | "verdict"
  | "mutationKinds"
  | "direction"
  | "rationale"
  | "confidence"
> & {
  modelCitedChunkIds: string[];
  seedQuotes?: SeedTextJudgment["seedQuotes"];
  unverifiedSeedQuoteCount?: number;
};

/**
 * One way of putting a record to the model: the request to send, how to check
 * the reply against the seed, and whether the text shown could hold the
 * support the citing side points at.
 */
type Reading = {
  request: CanonicalAdjudicateAdapterInput;
  limitation: EvidenceLimitation;
  check: (rawOutput: unknown) => Result<CheckedJudgment>;
};

type SeedText = { blocks: SeedTextBlock[]; chunks: readonly EvidenceChunk[] };

function malformed(error: z.ZodError): Result<never> {
  return {
    ok: false,
    error: `Malformed adjudication output: ${error.issues[0]?.message ?? "invalid JSON shape"}`,
  };
}

function readSelectedChunks(
  packet: CanonicalAdjudicatePacket,
  selectedChunkIds: readonly string[],
): Reading {
  return {
    request: {
      purpose: "categorical_adjudication",
      recordId: packet.recordId,
      packet,
      evidence: "selected_chunks",
      promptId: CANONICAL_ADJUDICATE_PROMPT_ID,
      promptVersion: CANONICAL_ADJUDICATE_PROMPT_VERSION,
      promptText: buildCanonicalAdjudicatePrompt(packet),
    },
    limitation: packetEvidenceLimitation(packet),
    check(rawOutput) {
      const parsed = canonicalAdjudicateModelOutputSchema.safeParse(rawOutput);
      if (!parsed.success) return malformed(parsed.error);
      const { citedChunkIds, ...judgment } = parsed.data;
      const referenceError = validateModelReferences({
        citedChunkIds,
        selectedChunkIds,
      });
      if (referenceError) return { ok: false, error: referenceError };
      const cited = new Set(citedChunkIds);
      return {
        ok: true,
        data: {
          ...judgment,
          modelCitedChunkIds: selectedChunkIds.filter((id) => cited.has(id)),
        },
      };
    },
  };
}

function readSeedText(
  packet: CanonicalAdjudicatePacket,
  seedText: SeedText,
): Reading {
  const { blocks, chunks } = seedText;
  const prompt = buildSeedTextAdjudicatePrompt({
    packet,
    seed: { title: packet.citedPaperTitle, blocks },
  });
  return {
    request: {
      purpose: "categorical_adjudication",
      recordId: packet.recordId,
      packet,
      evidence: "seed_text",
      promptId: SEED_TEXT_ADJUDICATE_PROMPT_ID,
      promptVersion: SEED_TEXT_ADJUDICATE_PROMPT_VERSION,
      promptPrefix: prompt.prefix,
      promptSuffix: prompt.suffix,
    },
    limitation: packetEvidenceLimitation(
      packet,
      blocks.map((block) => block.text),
    ),
    check(rawOutput) {
      const reply = seedTextAdjudicateReplySchema.safeParse(rawOutput);
      if (!reply.success) return malformed(reply.error);
      const resolved = resolveSeedTextJudgment(reply.data, blocks);
      if (!resolved.ok) return resolved;
      const { unverifiedQuoteCount, ...judgment } = resolved.data;
      return {
        ok: true,
        data: {
          ...judgment,
          unverifiedSeedQuoteCount: unverifiedQuoteCount,
          modelCitedChunkIds: chunkIdsHoldingQuotes(
            chunks,
            blocks,
            judgment.seedQuotes,
          ),
        },
      };
    },
  };
}

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
    resolvePreparedRecords(prepareArtifact.payload).map((record) => [
      record.recordId,
      record,
    ]),
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
  // Seeds whose whole text the adjudicator reads. A seed that is absent here,
  // because chunks were asked for or its text is too long, is read from the
  // chunks Evidence selected.
  const seedTextBySeedId = new Map(
    options.evidence === "seed_text"
      ? evidenceArtifact.payload.corpora.flatMap((corpus) => {
          const blocks = seedTextBlocksFromCorpus(corpus.chunks);
          const characters = blocks.reduce(
            (total, block) => total + block.text.length,
            0,
          );
          return characters > options.seedTextMaxCharacters
            ? []
            : [[corpus.seedId, { blocks, chunks: corpus.chunks }] as const];
        })
      : [],
  );

  // Stable ordering independent of adapter completion order.
  const orderedEvidenceRecords = [...evidenceArtifact.payload.records].sort(
    (left, right) => compareCodeUnits(left.recordId, right.recordId),
  );

  const adjudicate = adapters.adjudicate;

  /** Everything one record contributes to the artifact, in one value. */
  type RecordAdjudication = {
    outcome: AdjudicateRecordOutcome;
    /** Present only when the record reached the model. */
    execution?: ModelExecution;
  };

  async function adjudicateRecord(
    evidenceOutcome: EvidenceRecordOutcome,
  ): Promise<RecordAdjudication> {
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
      return {
        outcome: buildNotAdjudicatedOutcome({
          prepareRecord,
          gateCode: gate.gateCode,
          reason: gate.reason,
        }),
      };
    }

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
    const packetQuality = assessAdjudicatePacketQuality(packet);
    if (!packetQuality.ok) {
      return {
        outcome: buildNotAdjudicatedOutcome({
          prepareRecord,
          gateCode: "manual_review_extraction_limited",
          reason:
            packetQuality.gateReason ??
            "Adjudicate packet failed citation-scope quality checks",
        }),
      };
    }
    const seedText = seedTextBySeedId.get(prepareRecord.seed.seedId);
    const reading = seedText
      ? readSeedText(packet, seedText)
      : readSelectedChunks(packet, gate.selection.selectedChunkIds);

    const adapterRaw = await adjudicate(reading.request);
    const adapterResult = parseBoundary(
      canonicalAdjudicateAdapterResultSchema,
      adapterRaw,
      `canonical Adjudicate adapter result for ${prepareRecord.recordId}`,
    );
    verifyAdapterExecution(reading.request, adapterResult.execution);
    const modeled = { execution: adapterResult.execution };

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
      return {
        ...modeled,
        outcome: buildFailedOutcome({
          prepareRecord,
          failureCode:
            adapterResult.reasonCode as AdjudicateNonfatalFailureCode,
          reason: adapterResult.reason,
          execution: adapterResult.execution,
        }),
      };
    }

    const checked = reading.check(adapterResult.rawOutput);
    if (!checked.ok) {
      return {
        ...modeled,
        outcome: buildInvalidOutputOutcome({
          prepareRecord,
          reason: checked.error,
          execution: adapterResult.execution,
        }),
      };
    }

    return {
      ...modeled,
      outcome: buildAdjudicatedOutcome({
        prepareRecord,
        judgment: checked.data,
        selectedChunkIds: gate.selection.selectedChunkIds,
        limitation: reading.limitation,
        execution: adapterResult.execution,
      }),
    };
  }

  // Records are independent, so eligible ones call the model side by side.
  // Results come back in record order, so the artifact is the same at any
  // concurrency; only the wall time changes.
  const adjudications = await pMap(orderedEvidenceRecords, adjudicateRecord, {
    concurrency: options.concurrency ?? 1,
  });

  const outcomes: AdjudicateRecordOutcome[] = [];
  const prompts: LeanArtifactProvenance["prompts"] = [];
  const modelProvenance: LeanArtifactProvenance["models"] = [];
  const responseArtifacts: ArtifactReference[] = [];
  for (const { outcome, execution } of adjudications) {
    outcomes.push(outcome);
    if (!execution) continue;
    prompts.push({
      promptId: execution.promptId,
      version: execution.promptVersion,
      contentHash: execution.promptContentHash,
    });
    modelProvenance.push({
      provider: execution.provider,
      model: execution.model,
      requestHash: execution.requestHash,
      requestArtifact: execution.requestArtifact,
      responseArtifact: execution.responseArtifact,
    });
    responseArtifacts.push(execution.responseArtifact);
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
    prompts: uniqueSorted(prompts),
    models: uniqueSorted(modelProvenance),
    responseArtifacts: uniqueSortedArtifactReferences(responseArtifacts),
  };

  return {
    payload,
    decisions,
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
    payload: input.result.payload,
  });
  return parseBoundary(
    adjudicateArtifactSchema,
    artifact,
    "canonical Adjudicate artifact",
  );
}

function verifyAdapterExecution(
  request: CanonicalAdjudicateAdapterInput,
  execution: ModelExecution,
): void {
  if (
    execution.promptId !== request.promptId ||
    execution.promptVersion !== request.promptVersion ||
    execution.promptContentHash !==
      hashCanonicalAdjudicatePrompt(adjudicatePromptText(request))
  ) {
    throw new CanonicalAdjudicateBoundaryError(
      `Adjudicate adapter execution does not match the exact prompt sent: ${request.recordId}`,
    );
  }
  if (execution.requestHash !== hashCanonicalAdjudicateRequest(request)) {
    throw new CanonicalAdjudicateBoundaryError(
      `Adjudicate adapter execution does not match the exact request sent: ${request.recordId}`,
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
    seedId: record.citationOccurrence.seedId,
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
  prepareRecord: ResolvedPreparedCitationInstance;
  evidenceOutcome: EvidenceRecordOutcome;
  selectionsById: Map<string, EvidenceSelection>;
  chunksById: Map<string, EvidenceChunk>;
}): GateDecision {
  const { prepareRecord, evidenceOutcome, selectionsById, chunksById } = input;
  const classificationGate = classificationGateDecision(prepareRecord);
  if (classificationGate) {
    return classificationGate;
  }

  const contextText = prepareRecord.citationOccurrence.rawContext.trim();
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
  prepareRecord: ResolvedPreparedCitationInstance,
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
  citedChunkIds: readonly string[];
  selectedChunkIds: readonly string[];
}): string | undefined {
  const allowedChunks = new Set(input.selectedChunkIds);
  const seenChunks = new Set<string>();
  for (const chunkId of input.citedChunkIds) {
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
  prepareRecord: ResolvedPreparedCitationInstance;
  judgment: CheckedJudgment;
  selectedChunkIds: readonly string[];
  limitation: EvidenceLimitation;
  execution: ModelExecution;
}): AdjudicateRecordOutcome {
  const evaluatedClaimRecordIds =
    input.prepareRecord.occurrenceSourceClaimRecords.map(
      (claim) => claim.claimRecordId,
    );
  const evaluatedCitingClaimText =
    input.prepareRecord.occurrenceSourceClaimRecords
      .map((claim) => claim.extractedClaimText)
      .join("\n");
  const { judgment, limitation } = input;
  const draft = {
    recordId: input.prepareRecord.recordId,
    familyId: input.prepareRecord.familyId,
    citationOccurrenceId: input.prepareRecord.citationOccurrenceId,
    status: "adjudicated" as const,
    verdict: judgment.verdict,
    citingAssertion: judgment.citingAssertion,
    sourceStatement: judgment.sourceStatement,
    mutationKinds: [...judgment.mutationKinds].sort(compareCodeUnits),
    direction: judgment.direction,
    rationale: judgment.rationale,
    confidence: judgment.confidence,
    evaluatedCitingClaimText,
    evaluatedClaimRecordIds,
    selectedCitedChunkIds: [...input.selectedChunkIds],
    modelCitedChunkIds: judgment.modelCitedChunkIds,
    ...(judgment.seedQuotes
      ? {
          seedQuotes: judgment.seedQuotes,
          unverifiedSeedQuoteCount: judgment.unverifiedSeedQuoteCount,
        }
      : {}),
    evidenceSufficiency: limitation.evidenceSufficiency,
    ...(limitation.evidenceLimitation
      ? { evidenceLimitation: limitation.evidenceLimitation }
      : {}),
    execution: input.execution,
  };
  return {
    ...draft,
    adjudicationResultId: buildAdjudicationResultId(draft),
  };
}

function buildNotAdjudicatedOutcome(input: {
  prepareRecord: ResolvedPreparedCitationInstance;
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
  prepareRecord: ResolvedPreparedCitationInstance;
  failureCode: AdjudicateNonfatalFailureCode;
  reason: string;
  execution: ModelExecution;
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
  prepareRecord: ResolvedPreparedCitationInstance;
  reason: string;
  execution: ModelExecution;
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

/**
 * One decision per record. The earlier three-per-record ledger (gate, model,
 * final) restated the same `record.status` three times with three wordings; the
 * outcome, its reason, and the model that produced it are all on the record.
 */
function createAdjudicateDecisions(
  payload: AdjudicateArtifactPayload,
  recordedAt: string,
  lineage: AdjudicateLineage,
): AppendOnlyDecision[] {
  const baseArtifacts = [lineage.evidenceArtifact, lineage.prepareArtifact];
  return payload.records.map((record) => {
    const gated = record.status === "not_adjudicated";
    return createAppendOnlyDecision({
      recordId: record.recordId,
      decisionType: "adjudicate_outcome",
      outcome: gated ? record.gateCode : record.status,
      reason:
        record.status === "adjudicated"
          ? `Final categorical verdict ${record.verdict}`
          : record.reason,
      recordedAt,
      actor: gated
        ? { kind: "deterministic", identifier: "canonical-adjudicate-gate-v1" }
        : {
            kind: "model",
            identifier: `${record.execution.provider}/${record.execution.model}`,
          },
      evidenceArtifacts: uniqueSortedArtifactReferences(
        gated
          ? baseArtifacts
          : [
              ...baseArtifacts,
              record.execution.requestArtifact,
              record.execution.responseArtifact,
            ],
      ),
    });
  });
}

/** Distinct values in the order of their canonical serialization. */
function uniqueSorted<T>(values: readonly T[]): T[] {
  const byKey = new Map(
    values.map((value) => [canonicalSerialize(value), value]),
  );
  return [...byKey.keys()].sort(compareCodeUnits).map((key) => byKey.get(key)!);
}

const parseBoundary = createBoundaryParser(CanonicalAdjudicateBoundaryError);
