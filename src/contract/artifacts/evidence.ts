/**
 * Evidence artifact payload: chunked seed text, BM25 and rerank
 * versions, final selections, and one outcome per Prepare record.
 */
import { z } from "zod";

import { parsedBlockKindSchema } from "../../domain/parsing.js";
import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../../shared/stable-identity.js";
import {
  evidenceRerankStatusSchema,
  evidenceRetrievalStatusSchema,
} from "./evidence-statuses.js";
import {
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
} from "./primitives.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "../model-execution.js";
import { seedSectionRoleSchema } from "./seed-section-role.js";
import {
  addDuplicateIdentifierIssue,
  addIssue,
  findDuplicate,
  normalizeWhitespace,
  sameIdentifierSequence,
  validateScoreOrdering,
} from "./checks.js";
import { scopeGroundingStatusSchema } from "./scope.js";

const evidencePrepareArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("prepare-input"),
    stage: z.literal("prepare"),
  })
  .strict();

const evidenceScopeArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("scope-input"),
    stage: z.literal("scope"),
  })
  .strict();

export const evidenceLineageSchema = z
  .object({
    runId: z.string().min(1),
    prepareArtifact: evidencePrepareArtifactReferenceSchema,
    scopeArtifact: evidenceScopeArtifactReferenceSchema,
  })
  .strict();
export type EvidenceLineage = z.infer<typeof evidenceLineageSchema>;

export const evidenceChunkConfigurationSchema = z
  .object({
    version: z.literal("evidence-chunking-v1"),
    strategy: z.literal("scope-block-character-windows"),
    boundaryRule: z.literal("fixed-character"),
    maxCharacters: z.number().int().positive(),
    overlapCharacters: z.number().int().nonnegative(),
    sourceOrdering: z.literal("scope-block-offset-then-chunk-offset"),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.overlapCharacters >= configuration.maxCharacters) {
      context.addIssue({
        code: "custom",
        path: ["overlapCharacters"],
        message: "Chunk overlap must be smaller than the chunk size",
      });
    }
  });
export type EvidenceChunkConfiguration = z.infer<
  typeof evidenceChunkConfigurationSchema
>;

export type EvidenceChunkIdentityInputs = {
  seedId: string;
  sourceBlockKind: z.infer<typeof parsedBlockKindSchema>;
  sourceSectionTitle?: string | undefined;
  sourceBlockCharOffsetStart: number;
  sourceBlockCharOffsetEnd: number;
  charOffsetStart: number;
  charOffsetEnd: number;
  textContentHash: string;
  configuration: EvidenceChunkConfiguration;
};

export function buildEvidenceChunkId(
  input: EvidenceChunkIdentityInputs,
): string {
  return buildStableId("evidence-chunk", {
    identityKind: "scope-seed-text-chunk-v1",
    seedId: input.seedId,
    sourceBlockKind: input.sourceBlockKind,
    sourceSectionTitle: input.sourceSectionTitle,
    sourceBlockCharOffsetStart: input.sourceBlockCharOffsetStart,
    sourceBlockCharOffsetEnd: input.sourceBlockCharOffsetEnd,
    charOffsetStart: input.charOffsetStart,
    charOffsetEnd: input.charOffsetEnd,
    textContentHash: input.textContentHash,
    configuration: input.configuration,
  });
}

export const evidenceChunkSchema = z
  .object({
    chunkId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    chunkIndex: z.number().int().nonnegative(),
    text: z.string().min(1),
    contentHash: sha256DigestSchema,
    sourceBlockId: z.string().min(1),
    sourceBlockKind: parsedBlockKindSchema,
    sourceSectionTitle: z.string().min(1).optional(),
    sourceSectionRole: seedSectionRoleSchema.optional(),
    /** True when the source block contains the seed's own citations to other work. */
    sourceCitesOtherWork: z.boolean().optional(),
    sourceBlockCharOffsetStart: z.number().int().nonnegative(),
    sourceBlockCharOffsetEnd: z.number().int().positive(),
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().positive(),
    overlapWithPrevious: z.number().int().nonnegative(),
    sourceArtifact: artifactReferenceSchema,
    sourceArtifacts: z.array(artifactReferenceSchema).min(1),
    configuration: evidenceChunkConfigurationSchema,
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.charOffsetEnd - chunk.charOffsetStart !== chunk.text.length) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Chunk offsets must exactly bound the untruncated text",
      });
    }
  });
export type EvidenceChunk = z.infer<typeof evidenceChunkSchema>;

export type EvidenceChunkCorpusIdentityInputs = {
  seedId: string;
  configuration: EvidenceChunkConfiguration;
  chunkIds: readonly string[];
};

export function buildEvidenceChunkCorpusId(
  input: EvidenceChunkCorpusIdentityInputs,
): string {
  return buildStableId("evidence-corpus", {
    identityKind: "scope-seed-text-corpus-v1",
    seedId: input.seedId,
    configuration: input.configuration,
    chunkIds: input.chunkIds,
  });
}

export const evidenceChunkCorpusSchema = z
  .object({
    corpusId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    seedTextArtifact: artifactReferenceSchema,
    sourceArtifacts: z.array(artifactReferenceSchema).min(1),
    configuration: evidenceChunkConfigurationSchema,
    chunks: z.array(evidenceChunkSchema).min(1),
  })
  .strict()
  .superRefine((corpus, context) => {
    for (let index = 0; index < corpus.chunks.length; index++) {
      const chunk = corpus.chunks[index]!;
      const previous = corpus.chunks[index - 1];
      const next = corpus.chunks[index + 1];
      if (!previous || previous.sourceBlockId !== chunk.sourceBlockId) {
        if (
          chunk.overlapWithPrevious !== 0 ||
          chunk.charOffsetStart !== chunk.sourceBlockCharOffsetStart ||
          (previous &&
            chunk.sourceBlockCharOffsetStart <
              previous.sourceBlockCharOffsetEnd)
        ) {
          context.addIssue({
            code: "custom",
            path: ["chunks", index],
            message:
              "Source-block chunks must begin at the block start in immutable source order",
          });
        }
      } else {
        const expectedOverlap = Math.max(
          0,
          previous.charOffsetEnd - chunk.charOffsetStart,
        );
        if (
          chunk.sourceBlockKind !== previous.sourceBlockKind ||
          chunk.sourceSectionTitle !== previous.sourceSectionTitle ||
          chunk.sourceBlockCharOffsetStart !==
            previous.sourceBlockCharOffsetStart ||
          chunk.sourceBlockCharOffsetEnd !==
            previous.sourceBlockCharOffsetEnd ||
          chunk.charOffsetStart <= previous.charOffsetStart ||
          chunk.overlapWithPrevious !== expectedOverlap ||
          expectedOverlap !== corpus.configuration.overlapCharacters
        ) {
          context.addIssue({
            code: "custom",
            path: ["chunks", index, "overlapWithPrevious"],
            message:
              "Adjacent source-block chunks must preserve one locator and the declared overlap",
          });
        }
      }
      if (next?.sourceBlockId === chunk.sourceBlockId) {
        if (chunk.text.length !== corpus.configuration.maxCharacters) {
          context.addIssue({
            code: "custom",
            path: ["chunks", index, "text"],
            message:
              "Every non-final source-block chunk must fill its deterministic window",
          });
        }
      } else if (chunk.charOffsetEnd !== chunk.sourceBlockCharOffsetEnd) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "charOffsetEnd"],
          message:
            "The final chunk of each source block must reach the exact block end",
        });
      }
    }
  });
export type EvidenceChunkCorpus = z.infer<typeof evidenceChunkCorpusSchema>;

export type EvidenceQueryIdentityInputs =
  | {
      familyId: string;
      text: string;
      source: "scope-family-claim";
      citationOccurrenceId?: never;
    }
  | {
      familyId: string;
      citationOccurrenceId: string;
      text: string;
      source: "occurrence-local-claims";
    };

export function buildEvidenceQueryId(
  input: EvidenceQueryIdentityInputs,
): string {
  return buildStableId("evidence-query", {
    identityKind: "evidence-query-v2",
    familyId: input.familyId,
    ...(input.source === "occurrence-local-claims"
      ? { citationOccurrenceId: input.citationOccurrenceId }
      : {}),
    text: normalizeWhitespace(input.text),
    source: input.source,
  });
}

export const evidenceQuerySchema = z
  .object({
    queryId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema.optional(),
    text: z.string().min(1),
    contentHash: sha256DigestSchema,
    source: z.enum(["scope-family-claim", "occurrence-local-claims"]),
    groundingStatus: scopeGroundingStatusSchema,
    verificationStatus: z.enum([
      "scope_grounded",
      "scope_ambiguous",
      "unverified_attributed_claim",
    ]),
  })
  .strict();
export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;

export const evidenceBm25ConfigurationSchema = z
  .object({
    version: z.literal("bm25-v1"),
    k1: z.number().positive(),
    b: z.number().min(0).max(1),
    tokenizer: z
      .object({
        version: z.literal("unicode-token-plural-fold-stopwords-v2"),
        tokenPattern: z.string().min(1),
        lowercase: z.literal(true),
        stopWords: z.array(z.string().min(1)),
      })
      .strict(),
    candidateLimit: z.number().int().positive(),
    tieBreaker: z.literal("chunk-id-code-unit-ascending"),
  })
  .strict();
export type EvidenceBm25Configuration = z.infer<
  typeof evidenceBm25ConfigurationSchema
>;

export type EvidenceBm25RunIdentityInputs = {
  queryText: string;
  corpusId: string;
  corpusChunkIds: readonly string[];
  configuration: EvidenceBm25Configuration;
  rankingContentHash: string;
  componentBm25RunIds?: readonly string[] | undefined;
};

export function buildEvidenceBm25RunId(
  input: EvidenceBm25RunIdentityInputs,
): string {
  return buildStableId("bm25-run", {
    identityKind: "evidence-bm25-run-v2",
    queryContentHash: canonicalSha256(normalizeWhitespace(input.queryText)),
    corpusId: input.corpusId,
    corpusChunkIds: input.corpusChunkIds,
    configuration: input.configuration,
    rankingContentHash: input.rankingContentHash,
    ...(input.componentBm25RunIds
      ? { componentBm25RunIds: input.componentBm25RunIds }
      : {}),
  });
}

export const evidenceBm25CandidateSchema = z
  .object({
    chunkId: stableIdentifierSchema,
    rawScore: z.number().positive(),
    rank: z.number().int().positive(),
  })
  .strict();
export type EvidenceBm25Candidate = z.infer<typeof evidenceBm25CandidateSchema>;

export const evidenceBm25RunSchema = z
  .object({
    bm25RunId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    queryId: stableIdentifierSchema,
    queryText: z.string().min(1),
    queryTerms: z.array(z.string().min(1)),
    corpusId: stableIdentifierSchema,
    corpusChunkIds: z.array(stableIdentifierSchema).min(1),
    configuration: evidenceBm25ConfigurationSchema,
    status: z.enum(["matched", "no_lexical_matches"]),
    candidates: z.array(evidenceBm25CandidateSchema),
    componentBm25RunIds: z.array(stableIdentifierSchema).min(2).optional(),
    rankingContentHash: sha256DigestSchema,
  })
  .strict();
export type EvidenceBm25Run = z.infer<typeof evidenceBm25RunSchema>;

export const evidenceRerankFatalFailureCodeSchema = z.enum([
  "authentication",
  "authorization",
  "billing",
  "quota",
]);
export type EvidenceRerankFatalFailureCode = z.infer<
  typeof evidenceRerankFatalFailureCodeSchema
>;

export const evidenceRerankNonfatalFailureCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "transport",
  "invalid_response",
  "provider_failure",
]);
export type EvidenceRerankNonfatalFailureCode = z.infer<
  typeof evidenceRerankNonfatalFailureCodeSchema
>;

export const evidenceRerankFailureCodeSchema = z.union([
  evidenceRerankFatalFailureCodeSchema,
  evidenceRerankNonfatalFailureCodeSchema,
]);

export const evidenceRerankOutputSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            chunkId: stableIdentifierSchema,
            relevanceScore: z.number().min(0).max(100),
            rank: z.number().int().positive(),
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type EvidenceRerankOutput = z.infer<typeof evidenceRerankOutputSchema>;

export type EvidenceRerankRunIdentityInputs = {
  bm25RunId: string;
  candidateChunkIds: readonly string[];
  topN: number;
  execution: ModelExecution;
  outcomeContentHash: string;
};

export function buildEvidenceRerankRunId(
  input: EvidenceRerankRunIdentityInputs,
): string {
  return buildStableId("rerank-run", {
    identityKind: "evidence-relevance-rerank-v1",
    bm25RunId: input.bm25RunId,
    candidateChunkIds: input.candidateChunkIds,
    topN: input.topN,
    provider: input.execution.provider,
    model: input.execution.model,
    promptId: input.execution.promptId,
    promptVersion: input.execution.promptVersion,
    promptContentHash: input.execution.promptContentHash,
    requestHash: input.execution.requestHash,
    responseArtifact: {
      artifactId: input.execution.responseArtifact.artifactId,
      contentHash: input.execution.responseArtifact.contentHash,
    },
    outcomeContentHash: input.outcomeContentHash,
  });
}

const evidenceRerankRunBaseShape = {
  rerankRunId: stableIdentifierSchema,
  bm25RunId: stableIdentifierSchema,
  queryId: stableIdentifierSchema,
  queryText: z.string().min(1),
  candidateChunkIds: z.array(stableIdentifierSchema).min(1),
  topN: z.number().int().positive(),
  execution: modelExecutionSchema,
};

export const evidenceRerankRunSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        ...evidenceRerankRunBaseShape,
        status: z.literal("completed"),
        results: evidenceRerankOutputSchema.shape.results,
        rankingContentHash: sha256DigestSchema,
      })
      .strict(),
    z
      .object({
        ...evidenceRerankRunBaseShape,
        status: z.literal("failed"),
        results: z.array(z.never()).length(0),
        failure: z
          .object({
            code: evidenceRerankNonfatalFailureCodeSchema,
            reason: z.string().min(1),
          })
          .strict(),
        rankingContentHash: sha256DigestSchema,
      })
      .strict(),
  ])
  .superRefine((run, context) => {
    if (run.status !== "completed") return;
    addDuplicateIdentifierIssue(
      run.results.map((result) => result.chunkId),
      ["results"],
      context,
    );
    if (
      run.results.length > run.topN ||
      run.results.some(
        (result, index) =>
          result.rank !== index + 1 ||
          !run.candidateChunkIds.includes(result.chunkId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message:
          "Reranked results must be a ranked subset of the supplied BM25 candidates",
      });
    }
    validateScoreOrdering(
      run.results,
      (result) => result.relevanceScore,
      (result) => result.chunkId,
      ["results"],
      context,
    );
  });
export type EvidenceRerankRun = z.infer<typeof evidenceRerankRunSchema>;

export const evidenceRerankingPolicySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      topN: z.number().int().positive(),
    })
    .strict(),
]);
export type EvidenceRerankingPolicy = z.infer<
  typeof evidenceRerankingPolicySchema
>;

/**
 * Which ranking produced the final selection. Scope grounding pins, when
 * present, are placed first in either branch and named in the source so
 * Report can stratify verdicts by evidence regime.
 */
export const evidenceRankingSourceSchema = z.enum([
  "bm25",
  "reranked",
  "bm25_with_scope_pins",
  "reranked_with_scope_pins",
]);
export type EvidenceRankingSource = z.infer<typeof evidenceRankingSourceSchema>;

export type EvidenceSelectionIdentityInputs = {
  bm25RunId: string;
  rerankRunId?: string | undefined;
  rankingSource:
    | "bm25"
    | "reranked"
    | "bm25_with_scope_pins"
    | "reranked_with_scope_pins";
  rankingId: string;
  selectionLimit: number;
  selectedChunkIds: readonly string[];
  pinnedChunkIds?: readonly string[] | undefined;
};

export function buildEvidenceSelectionId(
  input: EvidenceSelectionIdentityInputs,
): string {
  return buildStableId("evidence-selection", {
    identityKind: "evidence-final-selection-v1",
    bm25RunId: input.bm25RunId,
    rerankRunId: input.rerankRunId,
    rankingSource: input.rankingSource,
    rankingId: input.rankingId,
    selectionLimit: input.selectionLimit,
    selectedChunkIds: input.selectedChunkIds,
    ...(input.pinnedChunkIds != null && input.pinnedChunkIds.length > 0
      ? { pinnedChunkIds: input.pinnedChunkIds }
      : {}),
  });
}

export const evidenceSelectionSchema = z
  .object({
    selectionId: stableIdentifierSchema,
    bm25RunId: stableIdentifierSchema,
    rerankRunId: stableIdentifierSchema.optional(),
    rankingSource: evidenceRankingSourceSchema,
    rankingId: stableIdentifierSchema,
    selectionLimit: z.number().int().positive(),
    selectedChunkIds: z.array(stableIdentifierSchema).min(1),
    pinnedChunkIds: z.array(stableIdentifierSchema).optional(),
    selectionContentHash: sha256DigestSchema,
  })
  .strict();
export type EvidenceSelection = z.infer<typeof evidenceSelectionSchema>;

export const evidencePreparedRecordLedgerEntrySchema = z
  .object({
    recordId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
  })
  .strict();
export type EvidencePreparedRecordLedgerEntry = z.infer<
  typeof evidencePreparedRecordLedgerEntrySchema
>;

export const evidenceRecordOutcomeSchema = z
  .object({
    recordId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    queryId: stableIdentifierSchema,
    retrievalStatus: evidenceRetrievalStatusSchema,
    rerankStatus: evidenceRerankStatusSchema,
    fallbackQueryId: stableIdentifierSchema.optional(),
    componentBm25RunIds: z.array(stableIdentifierSchema).min(1).optional(),
    primaryQuerySource: z
      .enum(["scope-family-claim", "occurrence-local-claims"])
      .optional(),
    corpusId: stableIdentifierSchema.optional(),
    bm25RunId: stableIdentifierSchema.optional(),
    rerankRunId: stableIdentifierSchema.optional(),
    finalSelectionId: stableIdentifierSchema.optional(),
    failure: z
      .object({
        code: z.enum(["chunking_failed", "bm25_failed"]),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EvidenceRecordOutcome = z.infer<typeof evidenceRecordOutcomeSchema>;

export const evidenceArtifactPayloadSchema = z
  .object({
    lineage: evidenceLineageSchema,
    rerankingPolicy: evidenceRerankingPolicySchema,
    preparedRecords: z.array(evidencePreparedRecordLedgerEntrySchema),
    queries: z.array(evidenceQuerySchema),
    corpora: z.array(evidenceChunkCorpusSchema),
    bm25Runs: z.array(evidenceBm25RunSchema),
    rerankRuns: z.array(evidenceRerankRunSchema),
    selections: z.array(evidenceSelectionSchema),
    records: z.array(evidenceRecordOutcomeSchema),
  })
  .strict()
  .superRefine(validateEvidencePayload);
export type EvidenceArtifactPayload = z.infer<
  typeof evidenceArtifactPayloadSchema
>;

function validateEvidencePayload(
  payload: EvidenceArtifactPayload,
  context: z.RefinementCtx,
): void {
  const duplicatePreparedPair = findDuplicate(
    payload.preparedRecords.map((record) =>
      canonicalSerialize({
        familyId: record.familyId,
        citationOccurrenceId: record.citationOccurrenceId,
      }),
    ),
  );
  if (duplicatePreparedPair) {
    addIssue(
      context,
      ["preparedRecords"],
      `Duplicate prepared family × occurrence ledger entry: ${duplicatePreparedPair}`,
    );
  }

  const ledgerByRecordId = new Map(
    payload.preparedRecords.map((record) => [record.recordId, record]),
  );
  const outcomesByRecordId = new Map(
    payload.records.map((record) => [record.recordId, record]),
  );
  for (const preparedRecord of payload.preparedRecords) {
    if (!outcomesByRecordId.has(preparedRecord.recordId)) {
      addIssue(
        context,
        ["records"],
        `Missing Evidence outcome for Prepare record: ${preparedRecord.recordId}`,
      );
    }
  }
  for (const outcome of payload.records) {
    if (!ledgerByRecordId.has(outcome.recordId)) {
      addIssue(
        context,
        ["records"],
        `Evidence outcome is outside the Prepare ledger: ${outcome.recordId}`,
      );
    }
  }

  const corporaById = new Map(
    payload.corpora.map((corpus) => [corpus.corpusId, corpus]),
  );
  const bm25RunsById = new Map(
    payload.bm25Runs.map((run) => [run.bm25RunId, run]),
  );
  const rerankRunsById = new Map(
    payload.rerankRuns.map((run) => [run.rerankRunId, run]),
  );
  const selectionsById = new Map(
    payload.selections.map((selection) => [selection.selectionId, selection]),
  );

  for (const selection of payload.selections) {
    const bm25Run = bm25RunsById.get(selection.bm25RunId);
    const rerankRun = selection.rerankRunId
      ? rerankRunsById.get(selection.rerankRunId)
      : undefined;
    const usesRerank =
      selection.rankingSource === "reranked" ||
      selection.rankingSource === "reranked_with_scope_pins";
    const rankedChunkIds = usesRerank
      ? bm25Run &&
        rerankRun &&
        rerankRun.status === "completed" &&
        rerankRun.bm25RunId === bm25Run.bm25RunId
        ? rerankRun.results.map((result) => result.chunkId)
        : undefined
      : bm25Run?.candidates.map((candidate) => candidate.chunkId);
    const pins = selection.pinnedChunkIds ?? [];
    const expectedChunkIds = (() => {
      if (!rankedChunkIds) return undefined;
      if (selection.rankingSource.endsWith("_with_scope_pins")) {
        if (pins.length === 0) return undefined;
        const selected: string[] = [...pins];
        const seen = new Set(selected);
        for (const chunkId of rankedChunkIds) {
          if (selected.length >= selection.selectionLimit) break;
          if (seen.has(chunkId)) continue;
          selected.push(chunkId);
          seen.add(chunkId);
        }
        return selected;
      }
      return rankedChunkIds.slice(0, selection.selectionLimit);
    })();
    if (
      !expectedChunkIds ||
      !sameIdentifierSequence(selection.selectedChunkIds, expectedChunkIds)
    ) {
      addIssue(
        context,
        ["selections"],
        `Selection does not preserve the top entries of its declared ranking: ${selection.selectionId}`,
      );
    }
  }

  for (const outcome of payload.records) {
    validateEvidenceOutcomeStatus(
      outcome,
      corporaById,
      bm25RunsById,
      rerankRunsById,
      selectionsById,
      context,
    );
  }
}

/** Each status names the retrieval products its outcome must and must not carry. */
function validateEvidenceOutcomeStatus(
  outcome: EvidenceRecordOutcome,
  corporaById: ReadonlyMap<string, EvidenceChunkCorpus>,
  bm25RunsById: ReadonlyMap<string, EvidenceBm25Run>,
  rerankRunsById: ReadonlyMap<string, EvidenceRerankRun>,
  selectionsById: ReadonlyMap<string, EvidenceSelection>,
  context: z.RefinementCtx,
): void {
  const corpus = outcome.corpusId
    ? corporaById.get(outcome.corpusId)
    : undefined;
  const bm25Run = outcome.bm25RunId
    ? bm25RunsById.get(outcome.bm25RunId)
    : undefined;
  const rerankRun = outcome.rerankRunId
    ? rerankRunsById.get(outcome.rerankRunId)
    : undefined;
  const selection = outcome.finalSelectionId
    ? selectionsById.get(outcome.finalSelectionId)
    : undefined;

  if (outcome.retrievalStatus === "retrieved") {
    if (
      !corpus ||
      !bm25Run ||
      bm25Run.status !== "matched" ||
      !selection ||
      selection.selectedChunkIds.length === 0 ||
      outcome.failure != null ||
      outcome.finalSelectionId == null
    ) {
      addIssue(
        context,
        ["records"],
        `Retrieved Evidence requires matched BM25 and a nonempty exact final selection: ${outcome.recordId}`,
      );
    }
  } else if (outcome.retrievalStatus === "no_lexical_matches") {
    if (
      !corpus ||
      !bm25Run ||
      bm25Run.status !== "no_lexical_matches" ||
      selection != null ||
      outcome.finalSelectionId != null ||
      outcome.rerankRunId != null ||
      outcome.failure != null
    ) {
      addIssue(
        context,
        ["records"],
        `No lexical matches must retain BM25 without claiming a final selection: ${outcome.recordId}`,
      );
    }
  } else if (outcome.retrievalStatus === "retrieval_failed") {
    if (
      outcome.failure == null ||
      outcome.bm25RunId != null ||
      outcome.componentBm25RunIds != null ||
      outcome.rerankRunId != null ||
      outcome.finalSelectionId != null
    ) {
      addIssue(
        context,
        ["records"],
        `Retrieval failure must remain typed and cannot claim a ranking: ${outcome.recordId}`,
      );
    }
  } else if (
    outcome.corpusId != null ||
    outcome.bm25RunId != null ||
    outcome.componentBm25RunIds != null ||
    outcome.rerankRunId != null ||
    outcome.finalSelectionId != null ||
    outcome.failure != null
  ) {
    addIssue(
      context,
      ["records"],
      `Unavailable seed text cannot claim retrieval products: ${outcome.recordId}`,
    );
  }

  if (outcome.rerankStatus === "skipped_pins_fill_selection") {
    if (
      outcome.rerankRunId != null ||
      selection?.rankingSource !== "bm25_with_scope_pins" ||
      selection.pinnedChunkIds?.length !== selection.selectionLimit ||
      !sameIdentifierSequence(
        selection.selectedChunkIds,
        selection.pinnedChunkIds,
      )
    ) {
      addIssue(
        context,
        ["records"],
        `Skipped reranking requires a complete, pin-only BM25 selection: ${outcome.recordId}`,
      );
    }
  } else if (outcome.rerankStatus === "failed") {
    if (
      !rerankRun ||
      rerankRun.status !== "failed" ||
      (selection?.rankingSource !== "bm25" &&
        selection?.rankingSource !== "bm25_with_scope_pins")
    ) {
      addIssue(
        context,
        ["records"],
        `Nonfatal rerank failure must remain explicit while selecting from BM25: ${outcome.recordId}`,
      );
    }
  }
}
