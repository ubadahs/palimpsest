import {
  buildEvidenceBm25RunId,
  buildEvidenceChunkCorpusId,
  buildEvidenceChunkId,
  buildEvidenceQueryId,
  evidenceBm25RunSchema,
  evidenceChunkCorpusSchema,
  evidenceQuerySchema,
  type EvidenceBm25Configuration,
  type EvidenceBm25Run,
  type EvidenceChunkConfiguration,
  type EvidenceChunkCorpus,
  type EvidenceQuery,
  type PreparedCitationInstance,
  type ScopeSeedMaterialization,
  type ScopedFamily,
} from "../contract/lean-artifacts.js";
import {
  BM25_DEFAULT_SCORING_CONFIGURATION,
  rankDocumentsByBm25Detailed,
  tokenizeBm25Text,
} from "./bm25.js";
import { canonicalSha256 } from "../shared/stable-identity.js";

export const canonicalEvidenceChunkConfiguration: EvidenceChunkConfiguration = {
  version: "canonical-evidence-chunking-v1",
  strategy: "scope-block-character-windows",
  boundaryRule: "fixed-character",
  maxCharacters: 1_200,
  overlapCharacters: 200,
  sourceOrdering: "scope-block-offset-then-chunk-offset",
};

export function chunkScopeSeedText(
  materialization: ScopeSeedMaterialization & { status: "materialized" },
  configuration: EvidenceChunkConfiguration = canonicalEvidenceChunkConfiguration,
): EvidenceChunkCorpus {
  const chunks: EvidenceChunkCorpus["chunks"] = [];

  for (const block of materialization.blocks) {
    let relativeStart = 0;
    while (relativeStart < block.text.length) {
      const relativeEnd = Math.min(
        block.text.length,
        relativeStart + configuration.maxCharacters,
      );
      const text = block.text.slice(relativeStart, relativeEnd);
      const charOffsetStart = block.charOffsetStart + relativeStart;
      const charOffsetEnd = block.charOffsetStart + relativeEnd;
      const contentHash = canonicalSha256(text);
      chunks.push({
        chunkId: buildEvidenceChunkId({
          seedId: materialization.seedId,
          sourceBlockKind: block.blockKind,
          sourceSectionTitle: block.sectionTitle,
          sourceBlockCharOffsetStart: block.charOffsetStart,
          sourceBlockCharOffsetEnd: block.charOffsetEnd,
          charOffsetStart,
          charOffsetEnd,
          textContentHash: contentHash,
          configuration,
        }),
        seedId: materialization.seedId,
        chunkIndex: chunks.length,
        text,
        contentHash,
        sourceBlockId: block.blockId,
        sourceBlockKind: block.blockKind,
        ...(block.sectionTitle
          ? { sourceSectionTitle: block.sectionTitle }
          : {}),
        sourceBlockCharOffsetStart: block.charOffsetStart,
        sourceBlockCharOffsetEnd: block.charOffsetEnd,
        charOffsetStart,
        charOffsetEnd,
        overlapWithPrevious:
          relativeStart === 0 ? 0 : configuration.overlapCharacters,
        sourceArtifact: materialization.seedTextArtifact,
        sourceArtifacts: materialization.sourceArtifacts,
        configuration,
      });
      if (relativeEnd === block.text.length) break;
      relativeStart = relativeEnd - configuration.overlapCharacters;
    }
  }

  return evidenceChunkCorpusSchema.parse({
    corpusId: buildEvidenceChunkCorpusId({
      seedId: materialization.seedId,
      configuration,
      chunkIds: chunks.map((chunk) => chunk.chunkId),
    }),
    seedId: materialization.seedId,
    seedTextArtifact: materialization.seedTextArtifact,
    sourceArtifacts: materialization.sourceArtifacts,
    configuration,
    chunks,
  });
}

export function buildScopedFamilyEvidenceQuery(
  family: ScopedFamily,
): EvidenceQuery {
  const text = normalizeWhitespace(family.trackedClaim);
  const source = "scope-family-tracked-claim" as const;
  const verificationStatus =
    family.grounding.status === "grounded"
      ? "scope_grounded"
      : family.grounding.status === "ambiguous"
        ? "scope_ambiguous"
        : "unverified_attributed_claim";
  return evidenceQuerySchema.parse({
    queryId: buildEvidenceQueryId({
      familyId: family.familyId,
      text,
      source,
    }),
    familyId: family.familyId,
    text,
    contentHash: canonicalSha256(text),
    source,
    groundingStatus: family.grounding.status,
    verificationStatus,
  });
}

export function buildOccurrenceLocalEvidenceQuery(
  record: PreparedCitationInstance,
  family: ScopedFamily,
): EvidenceQuery {
  const text = record.occurrenceSourceClaimRecords
    .slice()
    .sort((left, right) =>
      compareCodeUnits(left.claimRecordId, right.claimRecordId),
    )
    .map((claim) => normalizeWhitespace(claim.extractedClaimText))
    .join(" ");
  const source = "occurrence-local-claims" as const;
  const verificationStatus =
    family.grounding.status === "grounded"
      ? "scope_grounded"
      : family.grounding.status === "ambiguous"
        ? "scope_ambiguous"
        : "unverified_attributed_claim";
  return evidenceQuerySchema.parse({
    queryId: buildEvidenceQueryId({
      familyId: family.familyId,
      citationOccurrenceId: record.citationOccurrenceId,
      text,
      source,
    }),
    familyId: family.familyId,
    citationOccurrenceId: record.citationOccurrenceId,
    text,
    contentHash: canonicalSha256(text),
    source,
    groundingStatus: family.grounding.status,
    verificationStatus,
  });
}

export function retrieveEvidenceByBm25(input: {
  familyId: string;
  query: EvidenceQuery;
  corpus: EvidenceChunkCorpus;
  candidateLimit: number;
}): EvidenceBm25Run {
  const configuration = buildBm25Configuration(input.candidateLimit);
  const scoringConfiguration = {
    ...BM25_DEFAULT_SCORING_CONFIGURATION,
    tokenizer: {
      ...BM25_DEFAULT_SCORING_CONFIGURATION.tokenizer,
      stopWords: configuration.tokenizer.stopWords,
    },
  };
  const ranked = rankDocumentsByBm25Detailed(
    input.query.text,
    input.corpus.chunks,
    (chunk) => chunk.text,
    (chunk) => chunk.chunkId,
    input.candidateLimit,
    scoringConfiguration,
  );
  const candidates = ranked.map((entry) => ({
    chunkId: entry.document.chunkId,
    rawScore: entry.score,
    rank: entry.rank,
  }));
  const queryTerms = tokenizeBm25Text(input.query.text, scoringConfiguration);
  const corpusChunkIds = input.corpus.chunks.map((chunk) => chunk.chunkId);
  const rankingContentHash = canonicalSha256({ queryTerms, candidates });
  return evidenceBm25RunSchema.parse({
    bm25RunId: buildEvidenceBm25RunId({
      queryText: input.query.text,
      corpusId: input.corpus.corpusId,
      corpusChunkIds,
      configuration,
      rankingContentHash,
    }),
    familyId: input.familyId,
    queryId: input.query.queryId,
    queryText: input.query.text,
    queryTerms,
    corpusId: input.corpus.corpusId,
    corpusChunkIds,
    configuration,
    status: candidates.length > 0 ? "matched" : "no_lexical_matches",
    candidates,
    rankingContentHash,
  });
}

/**
 * Chunks whose character ranges overlap any Scope verified grounding span.
 * Deterministic pin set for final evidence selection.
 */
export function chunksOverlappingVerifiedSpans(
  family: ScopedFamily,
  corpus: EvidenceChunkCorpus,
): string[] {
  if (
    family.grounding.status !== "grounded" &&
    family.grounding.status !== "ambiguous"
  ) {
    return [];
  }
  const spans = family.grounding.evidenceSpans;
  if (spans.length === 0) return [];
  const overlapping = corpus.chunks.filter((chunk) =>
    spans.some(
      (span) =>
        chunk.charOffsetStart < span.charOffsetEnd &&
        chunk.charOffsetEnd > span.charOffsetStart,
    ),
  );
  return overlapping.map((chunk) => chunk.chunkId).sort(compareCodeUnits);
}

/**
 * Pin Scope-verified chunks first, then fill from BM25 order up to limit.
 */
export function selectEvidenceChunkIds(input: {
  family: ScopedFamily;
  corpus: EvidenceChunkCorpus;
  bm25Candidates: readonly { chunkId: string }[];
  selectionLimit: number;
}): {
  selectedChunkIds: string[];
  pinnedChunkIds: string[];
  rankingSource: "bm25" | "bm25_with_scope_pins";
} {
  const pinnedChunkIds = chunksOverlappingVerifiedSpans(
    input.family,
    input.corpus,
  ).slice(0, input.selectionLimit);
  if (pinnedChunkIds.length === 0) {
    return {
      selectedChunkIds: input.bm25Candidates
        .slice(0, input.selectionLimit)
        .map((candidate) => candidate.chunkId),
      pinnedChunkIds: [],
      rankingSource: "bm25",
    };
  }
  const selected: string[] = [...pinnedChunkIds];
  const selectedSet = new Set(selected);
  for (const candidate of input.bm25Candidates) {
    if (selected.length >= input.selectionLimit) break;
    if (selectedSet.has(candidate.chunkId)) continue;
    selected.push(candidate.chunkId);
    selectedSet.add(candidate.chunkId);
  }
  return {
    selectedChunkIds: selected,
    pinnedChunkIds,
    rankingSource: "bm25_with_scope_pins",
  };
}

export function unionBm25Candidates(
  runs: readonly EvidenceBm25Run[],
): EvidenceBm25Run["candidates"] {
  const bestByChunkId = new Map<string, number>();
  for (const run of runs) {
    for (const candidate of run.candidates) {
      const current = bestByChunkId.get(candidate.chunkId);
      if (current == null || candidate.rawScore > current) {
        bestByChunkId.set(candidate.chunkId, candidate.rawScore);
      }
    }
  }
  return [...bestByChunkId.entries()]
    .sort(
      ([leftId, leftScore], [rightId, rightScore]) =>
        rightScore - leftScore || compareCodeUnits(leftId, rightId),
    )
    .map(([chunkId, rawScore], index) => ({
      chunkId,
      rawScore,
      rank: index + 1,
    }));
}

function buildBm25Configuration(
  candidateLimit: number,
): EvidenceBm25Configuration {
  return {
    version: BM25_DEFAULT_SCORING_CONFIGURATION.version,
    k1: BM25_DEFAULT_SCORING_CONFIGURATION.k1,
    b: BM25_DEFAULT_SCORING_CONFIGURATION.b,
    tokenizer: {
      version: BM25_DEFAULT_SCORING_CONFIGURATION.tokenizer.version,
      tokenPattern: BM25_DEFAULT_SCORING_CONFIGURATION.tokenizer.tokenPattern,
      lowercase: true,
      stopWords: [...BM25_DEFAULT_SCORING_CONFIGURATION.tokenizer.stopWords],
    },
    candidateLimit,
    tieBreaker: "chunk-id-code-unit-ascending",
  };
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
