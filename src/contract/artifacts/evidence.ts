/**
 * Canonical Evidence artifact payload: chunked seed text, BM25 and rerank
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
} from "../canonical-evidence-statuses.js";
import {
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
} from "../lean-artifact-primitives.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "../model-execution.js";
import { seedSectionRoleSchema } from "./seed-section-role.js";
import {
  addDuplicateIdentifierIssue,
  addIssue,
  addSortedUniqueIdentifierIssue,
  findDuplicate,
  normalizeWhitespace,
  sameArtifactReference,
  sameIdentifierSequence,
  validateScoreOrdering,
} from "./checks.js";
import { buildCitationInstanceRecordId } from "./prepare.js";
import { scopeGroundingStatusSchema } from "./scope.js";

const evidencePrepareArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-prepare-input"),
    canonicalStage: z.literal("prepare"),
  })
  .strict();

const evidenceScopeArtifactReferenceSchema = artifactReferenceSchema
  .extend({
    role: z.literal("canonical-scope-input"),
    canonicalStage: z.literal("scope"),
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
    version: z.literal("canonical-evidence-chunking-v1"),
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
    if (
      chunk.sourceBlockCharOffsetEnd <= chunk.sourceBlockCharOffsetStart ||
      chunk.charOffsetStart < chunk.sourceBlockCharOffsetStart ||
      chunk.charOffsetEnd > chunk.sourceBlockCharOffsetEnd ||
      chunk.charOffsetEnd <= chunk.charOffsetStart
    ) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Chunk offsets must lie within the exact source block",
      });
    }
    if (chunk.charOffsetEnd - chunk.charOffsetStart !== chunk.text.length) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Chunk offsets must exactly bound the untruncated text",
      });
    }
    if (chunk.contentHash !== canonicalSha256(chunk.text)) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "Chunk content hash does not match its exact text",
      });
    }
    if (
      chunk.chunkId !==
      buildEvidenceChunkId({
        ...chunk,
        textContentHash: chunk.contentHash,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["chunkId"],
        message: "chunkId does not match semantic source location and text",
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
    addDuplicateIdentifierIssue(
      corpus.chunks.map((chunk) => chunk.chunkId),
      ["chunks"],
      context,
    );
    if (
      corpus.chunks.some(
        (chunk, index) =>
          chunk.seedId !== corpus.seedId ||
          chunk.chunkIndex !== index ||
          canonicalSerialize(chunk.configuration) !==
            canonicalSerialize(corpus.configuration) ||
          !sameArtifactReference(
            chunk.sourceArtifact,
            corpus.seedTextArtifact,
          ) ||
          canonicalSerialize(chunk.sourceArtifacts) !==
            canonicalSerialize(corpus.sourceArtifacts),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["chunks"],
        message:
          "Corpus chunks must preserve seed, order, configuration, and source artifact",
      });
    }
    for (let index = 0; index < corpus.chunks.length; index++) {
      const chunk = corpus.chunks[index]!;
      const previous = corpus.chunks[index - 1];
      const next = corpus.chunks[index + 1];
      if (chunk.text.length > corpus.configuration.maxCharacters) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "text"],
          message: "Chunk text exceeds the declared deterministic window",
        });
      }
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
    if (
      corpus.corpusId !==
      buildEvidenceChunkCorpusId({
        seedId: corpus.seedId,
        configuration: corpus.configuration,
        chunkIds: corpus.chunks.map((chunk) => chunk.chunkId),
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["corpusId"],
        message: "corpusId does not match its ordered semantic chunk set",
      });
    }
  });
export type EvidenceChunkCorpus = z.infer<typeof evidenceChunkCorpusSchema>;

export type EvidenceQueryIdentityInputs =
  | {
      familyId: string;
      text: string;
      source: "scope-family-tracked-claim";
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
    source: z.enum(["scope-family-tracked-claim", "occurrence-local-claims"]),
    groundingStatus: scopeGroundingStatusSchema,
    verificationStatus: z.enum([
      "scope_grounded",
      "scope_ambiguous",
      "unverified_attributed_claim",
    ]),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      (query.source === "occurrence-local-claims" &&
        query.citationOccurrenceId == null) ||
      (query.source === "scope-family-tracked-claim" &&
        query.citationOccurrenceId != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["citationOccurrenceId"],
        message:
          "Only occurrence-local Evidence queries must identify their citation occurrence",
      });
    }
    if (query.text !== normalizeWhitespace(query.text)) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "Evidence query text must use normalized whitespace",
      });
    }
    if (query.contentHash !== canonicalSha256(query.text)) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "Evidence query content hash does not match its exact text",
      });
    }
    if (
      query.queryId !==
      buildEvidenceQueryId(
        query.source === "occurrence-local-claims"
          ? {
              familyId: query.familyId,
              citationOccurrenceId: query.citationOccurrenceId ?? "",
              text: query.text,
              source: query.source,
            }
          : {
              familyId: query.familyId,
              text: query.text,
              source: query.source,
            },
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["queryId"],
        message: "queryId does not match the Evidence query identity",
      });
    }
    const expectedVerification =
      query.groundingStatus === "grounded"
        ? "scope_grounded"
        : query.groundingStatus === "ambiguous"
          ? "scope_ambiguous"
          : "unverified_attributed_claim";
    if (query.verificationStatus !== expectedVerification) {
      context.addIssue({
        code: "custom",
        path: ["verificationStatus"],
        message:
          "Query verification must honestly reflect the Scope grounding annotation",
      });
    }
  });
export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;

export const evidenceBm25ConfigurationSchema = z
  .object({
    version: z.literal("canonical-bm25-v1"),
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
    identityKind: "canonical-evidence-bm25-run-v2",
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
  .strict()
  .superRefine((run, context) => {
    addDuplicateIdentifierIssue(
      run.corpusChunkIds,
      ["corpusChunkIds"],
      context,
    );
    addDuplicateIdentifierIssue(
      run.candidates.map((candidate) => candidate.chunkId),
      ["candidates"],
      context,
    );
    if (run.componentBm25RunIds) {
      addSortedUniqueIdentifierIssue(
        run.componentBm25RunIds,
        ["componentBm25RunIds"],
        context,
      );
    }
    if (
      run.candidates.some(
        (candidate, index) =>
          candidate.rank !== index + 1 ||
          !run.corpusChunkIds.includes(candidate.chunkId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message:
          "BM25 candidates must have contiguous ranks and belong to the exact corpus",
      });
    }
    if (run.candidates.length > run.configuration.candidateLimit) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "BM25 candidates exceed the declared candidate limit",
      });
    }
    validateScoreOrdering(
      run.candidates,
      (candidate) => candidate.rawScore,
      (candidate) => candidate.chunkId,
      ["candidates"],
      context,
    );
    const expectedStatus =
      run.candidates.length > 0 ? "matched" : "no_lexical_matches";
    if (run.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "BM25 status does not match its candidate results",
      });
    }
    if (
      run.rankingContentHash !==
      canonicalSha256({
        queryTerms: run.queryTerms,
        candidates: run.candidates,
        ...(run.componentBm25RunIds
          ? { componentBm25RunIds: run.componentBm25RunIds }
          : {}),
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["rankingContentHash"],
        message:
          "BM25 ranking content hash does not match raw scores and ranks",
      });
    }
    if (run.bm25RunId !== buildEvidenceBm25RunId(run)) {
      context.addIssue({
        code: "custom",
        path: ["bm25RunId"],
        message:
          "bm25RunId does not match query, corpus, and BM25 configuration",
      });
    }
  });
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
    identityKind: "canonical-evidence-relevance-rerank-v1",
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
    addDuplicateIdentifierIssue(
      run.candidateChunkIds,
      ["candidateChunkIds"],
      context,
    );
    if (
      run.rerankRunId !==
      buildEvidenceRerankRunId({
        ...run,
        outcomeContentHash: run.rankingContentHash,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["rerankRunId"],
        message:
          "rerankRunId does not match its BM25 run, model request, and immutable outcome",
      });
    }
    if (run.status === "completed") {
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
    }
    const expectedHash =
      run.status === "completed"
        ? canonicalSha256({ status: run.status, results: run.results })
        : canonicalSha256({
            status: run.status,
            results: run.results,
            failure: run.failure,
          });
    if (run.rankingContentHash !== expectedHash) {
      context.addIssue({
        code: "custom",
        path: ["rankingContentHash"],
        message: "Rerank content hash does not match its immutable outcome",
      });
    }
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
    identityKind: "canonical-evidence-final-selection-v1",
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
  .strict()
  .superRefine((selection, context) => {
    addDuplicateIdentifierIssue(
      selection.selectedChunkIds,
      ["selectedChunkIds"],
      context,
    );
    if (selection.pinnedChunkIds) {
      addDuplicateIdentifierIssue(
        selection.pinnedChunkIds,
        ["pinnedChunkIds"],
        context,
      );
    }
    if (selection.selectedChunkIds.length > selection.selectionLimit) {
      context.addIssue({
        code: "custom",
        path: ["selectedChunkIds"],
        message: "Final evidence selection exceeds its declared limit",
      });
    }
    if (
      (selection.rankingSource === "bm25" ||
        selection.rankingSource === "bm25_with_scope_pins") &&
      (selection.rankingId !== selection.bm25RunId ||
        selection.rerankRunId != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rankingId"],
        message: "BM25 selection must point only to its immutable BM25 run",
      });
    }
    const declaresPins = selection.rankingSource.endsWith("_with_scope_pins");
    const hasPins =
      selection.pinnedChunkIds != null && selection.pinnedChunkIds.length > 0;
    if (declaresPins && !hasPins) {
      context.addIssue({
        code: "custom",
        path: ["pinnedChunkIds"],
        message: "Scope-pinned selection requires pinned chunk IDs",
      });
    }
    if (!declaresPins && hasPins) {
      context.addIssue({
        code: "custom",
        path: ["pinnedChunkIds"],
        message: "Unpinned selection cannot declare scope pins",
      });
    }
    if (
      (selection.rankingSource === "reranked" ||
        selection.rankingSource === "reranked_with_scope_pins") &&
      (selection.rerankRunId == null ||
        selection.rankingId !== selection.rerankRunId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rankingId"],
        message: "Reranked selection must name its separate rerank run",
      });
    }
    if (
      selection.selectionContentHash !==
      canonicalSha256(selection.selectedChunkIds)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectionContentHash"],
        message: "Selection content hash does not match selected chunk IDs",
      });
    }
    if (selection.selectionId !== buildEvidenceSelectionId(selection)) {
      context.addIssue({
        code: "custom",
        path: ["selectionId"],
        message: "selectionId does not match its source ranking and chunks",
      });
    }
  });
export type EvidenceSelection = z.infer<typeof evidenceSelectionSchema>;

export const evidencePreparedRecordLedgerEntrySchema = z
  .object({
    recordId: stableIdentifierSchema,
    familyId: stableIdentifierSchema,
    citationOccurrenceId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.recordId !== buildCitationInstanceRecordId(record)) {
      context.addIssue({
        code: "custom",
        path: ["recordId"],
        message:
          "Evidence ledger recordId does not match family × citation occurrence",
      });
    }
  });
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
      .enum(["scope-family-tracked-claim", "occurrence-local-claims"])
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
  const sortedCollections: Array<{
    values: string[];
    path: string;
  }> = [
    {
      values: payload.preparedRecords.map((record) => record.recordId),
      path: "preparedRecords",
    },
    {
      values: payload.queries.map((query) => query.queryId),
      path: "queries",
    },
    {
      values: payload.corpora.map((corpus) => corpus.corpusId),
      path: "corpora",
    },
    {
      values: payload.bm25Runs.map((run) => run.bm25RunId),
      path: "bm25Runs",
    },
    {
      values: payload.rerankRuns.map((run) => run.rerankRunId),
      path: "rerankRuns",
    },
    {
      values: payload.selections.map((selection) => selection.selectionId),
      path: "selections",
    },
    {
      values: payload.records.map((record) => record.recordId),
      path: "records",
    },
  ];
  for (const collection of sortedCollections) {
    addSortedUniqueIdentifierIssue(
      collection.values,
      [collection.path],
      context,
    );
  }

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
    const outcome = outcomesByRecordId.get(preparedRecord.recordId);
    if (!outcome) {
      addIssue(
        context,
        ["records"],
        `Missing Evidence outcome for Prepare record: ${preparedRecord.recordId}`,
      );
    } else if (
      outcome.familyId !== preparedRecord.familyId ||
      outcome.citationOccurrenceId !== preparedRecord.citationOccurrenceId ||
      outcome.seedId !== preparedRecord.seedId
    ) {
      addIssue(
        context,
        ["records"],
        `Evidence outcome changed Prepare record identity: ${preparedRecord.recordId}`,
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

  const queriesById = new Map(
    payload.queries.map((query) => [query.queryId, query]),
  );
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

  for (const run of payload.bm25Runs) {
    const query = queriesById.get(run.queryId);
    const corpus = corporaById.get(run.corpusId);
    if (
      !query ||
      query.familyId !== run.familyId ||
      query.text !== run.queryText
    ) {
      addIssue(
        context,
        ["bm25Runs"],
        `BM25 run does not preserve its exact family query: ${run.bm25RunId}`,
      );
    }
    if (
      !corpus ||
      !sameIdentifierSequence(
        run.corpusChunkIds,
        corpus.chunks.map((chunk) => chunk.chunkId),
      )
    ) {
      addIssue(
        context,
        ["bm25Runs"],
        `BM25 run does not name its exact ordered chunk corpus: ${run.bm25RunId}`,
      );
    }
    for (const componentBm25RunId of run.componentBm25RunIds ?? []) {
      const component = bm25RunsById.get(componentBm25RunId);
      if (
        !component ||
        component.bm25RunId === run.bm25RunId ||
        component.corpusId !== run.corpusId
      ) {
        addIssue(
          context,
          ["bm25Runs"],
          `Union BM25 run references an invalid component run: ${run.bm25RunId}`,
        );
      }
    }
  }

  for (const run of payload.rerankRuns) {
    const bm25Run = bm25RunsById.get(run.bm25RunId);
    const query = queriesById.get(run.queryId);
    if (
      !bm25Run ||
      !query ||
      bm25Run.queryText !== run.queryText ||
      query.text !== run.queryText ||
      !sameIdentifierSequence(
        run.candidateChunkIds,
        bm25Run.candidates.map((candidate) => candidate.chunkId),
      )
    ) {
      addIssue(
        context,
        ["rerankRuns"],
        `Rerank run does not reference one immutable BM25 candidate set: ${run.rerankRunId}`,
      );
    }
  }

  for (const selection of payload.selections) {
    const bm25Run = bm25RunsById.get(selection.bm25RunId);
    if (!bm25Run) {
      addIssue(
        context,
        ["selections"],
        `Selection references an unknown BM25 run: ${selection.selectionId}`,
      );
      continue;
    }
    const rerankRun = selection.rerankRunId
      ? rerankRunsById.get(selection.rerankRunId)
      : undefined;
    const usesRerank =
      selection.rankingSource === "reranked" ||
      selection.rankingSource === "reranked_with_scope_pins";
    const rankedChunkIds = usesRerank
      ? rerankRun &&
        rerankRun.status === "completed" &&
        rerankRun.bm25RunId === bm25Run.bm25RunId
        ? rerankRun.results.map((result) => result.chunkId)
        : undefined
      : bm25Run.candidates.map((candidate) => candidate.chunkId);
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
    if (selection.rankingSource.endsWith("_with_scope_pins")) {
      const corpus = corporaById.get(bm25Run.corpusId);
      const pinSet = new Set(selection.pinnedChunkIds ?? []);
      if (
        !corpus ||
        [...pinSet].some(
          (chunkId) =>
            !corpus.chunks.some((chunk) => chunk.chunkId === chunkId),
        )
      ) {
        addIssue(
          context,
          ["selections"],
          `Scope-pinned selection references chunks outside its corpus: ${selection.selectionId}`,
        );
      }
    }
  }

  const usedQueryIds = new Set<string>();
  const usedCorpusIds = new Set<string>();
  const usedBm25RunIds = new Set<string>();
  const usedRerankRunIds = new Set<string>();
  const usedSelectionIds = new Set<string>();
  for (const outcome of payload.records) {
    const query = queriesById.get(outcome.queryId);
    if (
      !query ||
      query.familyId !== outcome.familyId ||
      (query.source === "occurrence-local-claims" &&
        query.citationOccurrenceId !== outcome.citationOccurrenceId) ||
      (outcome.primaryQuerySource != null &&
        outcome.primaryQuerySource !== query.source)
    ) {
      addIssue(
        context,
        ["records"],
        `Evidence outcome references a dangling or cross-family query: ${outcome.recordId}`,
      );
    } else {
      usedQueryIds.add(query.queryId);
    }
    if (outcome.fallbackQueryId) {
      const fallbackQuery = queriesById.get(outcome.fallbackQueryId);
      if (
        !fallbackQuery ||
        fallbackQuery.familyId !== outcome.familyId ||
        fallbackQuery.source !== "scope-family-tracked-claim"
      ) {
        addIssue(
          context,
          ["records"],
          `Evidence outcome references a dangling or cross-family fallback query: ${outcome.recordId}`,
        );
      } else {
        usedQueryIds.add(fallbackQuery.queryId);
      }
    }
    validateEvidenceOutcomeReferences(
      outcome,
      query,
      payload.rerankingPolicy,
      corporaById,
      bm25RunsById,
      rerankRunsById,
      selectionsById,
      context,
    );
    if (outcome.corpusId) usedCorpusIds.add(outcome.corpusId);
    if (outcome.bm25RunId) usedBm25RunIds.add(outcome.bm25RunId);
    for (const componentBm25RunId of outcome.componentBm25RunIds ?? []) {
      if (!bm25RunsById.has(componentBm25RunId)) {
        addIssue(
          context,
          ["records"],
          `Evidence outcome references an unknown component BM25 run: ${outcome.recordId}`,
        );
      }
      usedBm25RunIds.add(componentBm25RunId);
    }
    if (outcome.rerankRunId) usedRerankRunIds.add(outcome.rerankRunId);
    if (outcome.finalSelectionId) {
      usedSelectionIds.add(outcome.finalSelectionId);
    }
  }

  for (const query of payload.queries) {
    if (!usedQueryIds.has(query.queryId)) {
      addIssue(
        context,
        ["queries"],
        `Evidence query has no prepared record outcome: ${query.queryId}`,
      );
    }
  }
  for (const corpus of payload.corpora) {
    if (!usedCorpusIds.has(corpus.corpusId)) {
      addIssue(
        context,
        ["corpora"],
        `Evidence corpus has no record outcome: ${corpus.corpusId}`,
      );
    }
  }
  for (const run of payload.bm25Runs) {
    if (!usedBm25RunIds.has(run.bm25RunId)) {
      addIssue(
        context,
        ["bm25Runs"],
        `BM25 run has no record outcome: ${run.bm25RunId}`,
      );
    }
  }
  for (const run of payload.rerankRuns) {
    if (!usedRerankRunIds.has(run.rerankRunId)) {
      addIssue(
        context,
        ["rerankRuns"],
        `Rerank run has no record outcome: ${run.rerankRunId}`,
      );
    }
  }
  for (const selection of payload.selections) {
    if (!usedSelectionIds.has(selection.selectionId)) {
      addIssue(
        context,
        ["selections"],
        `Final selection has no record outcome: ${selection.selectionId}`,
      );
    }
  }
}

function validateEvidenceOutcomeReferences(
  outcome: EvidenceRecordOutcome,
  query: EvidenceQuery | undefined,
  rerankingPolicy: EvidenceRerankingPolicy,
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

  if (
    corpus &&
    (corpus.seedId !== outcome.seedId ||
      (bm25Run != null &&
        (bm25Run.corpusId !== corpus.corpusId ||
          query == null ||
          canonicalSha256(bm25Run.queryText) !== query.contentHash)) ||
      (selection != null && selection.bm25RunId !== bm25Run?.bm25RunId))
  ) {
    addIssue(
      context,
      ["records"],
      `Evidence outcome products do not share one query and corpus: ${outcome.recordId}`,
    );
  }

  for (const componentBm25RunId of outcome.componentBm25RunIds ?? []) {
    const component = bm25RunsById.get(componentBm25RunId);
    if (component && component.corpusId !== outcome.corpusId) {
      addIssue(
        context,
        ["records"],
        `Evidence outcome component BM25 runs must share its corpus: ${outcome.recordId}`,
      );
    }
  }

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

  if (!rerankingPolicy.enabled) {
    if (outcome.rerankStatus !== "disabled" || outcome.rerankRunId != null) {
      addIssue(
        context,
        ["records"],
        `Disabled reranking cannot carry execution provenance: ${outcome.recordId}`,
      );
    }
    if (
      selection &&
      selection.rankingSource !== "bm25" &&
      selection.rankingSource !== "bm25_with_scope_pins"
    ) {
      addIssue(
        context,
        ["records"],
        `Disabled reranking requires deterministic BM25 selection: ${outcome.recordId}`,
      );
    }
    return;
  }

  switch (outcome.rerankStatus) {
    case "completed":
      if (
        !rerankRun ||
        rerankRun.status !== "completed" ||
        (selection?.rankingSource !== "reranked" &&
          selection?.rankingSource !== "reranked_with_scope_pins") ||
        selection.rerankRunId !== rerankRun.rerankRunId
      ) {
        addIssue(
          context,
          ["records"],
          `Completed reranking must use its separate immutable ranking: ${outcome.recordId}`,
        );
      }
      break;
    case "failed":
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
      break;
    case "not_attempted_no_candidates":
      if (
        outcome.rerankRunId != null ||
        bm25Run?.status !== "no_lexical_matches" ||
        outcome.finalSelectionId != null ||
        selection != null
      ) {
        addIssue(
          context,
          ["records"],
          `No-candidate rerank status requires an empty BM25 result: ${outcome.recordId}`,
        );
      }
      break;
    case "not_attempted_unavailable":
      if (
        outcome.retrievalStatus !== "seed_text_unavailable" &&
        outcome.retrievalStatus !== "seed_acquisition_failed"
      ) {
        addIssue(
          context,
          ["records"],
          `Unavailable rerank status requires unavailable seed text: ${outcome.recordId}`,
        );
      }
      break;
    case "not_attempted_retrieval_failure":
      if (outcome.retrievalStatus !== "retrieval_failed") {
        addIssue(
          context,
          ["records"],
          `Rerank retrieval-failure status requires typed retrieval failure: ${outcome.recordId}`,
        );
      }
      break;
    case "disabled":
      addIssue(
        context,
        ["records"],
        `Enabled reranking cannot emit disabled status: ${outcome.recordId}`,
      );
      break;
  }
}
