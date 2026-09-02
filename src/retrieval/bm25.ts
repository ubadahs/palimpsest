import { compareCodeUnits } from "../shared/order.js";

export type RankedDocument<TDocument> = {
  document: TDocument;
  score: number;
};

export type DetailedRankedDocument<TDocument> = RankedDocument<TDocument> & {
  rank: number;
};

/**
 * Token = a run of letters/digits with internal hyphens, or a number with an
 * internal decimal point. Unicode-aware lookarounds replace `\b`, which is
 * ASCII-only in JavaScript and dropped Greek letters (β-catenin → catenin).
 * Single-character tokens are kept so "5 mM" and "day 7" retain their numbers.
 */
const BM25_TOKEN_PATTERN = String.raw`(?<![\p{L}\p{N}])(?:\p{N}+(?:\.\p{N}+)+|[\p{L}\p{N}]+)(?:-[\p{L}\p{N}]+)*(?![\p{L}\p{N}])`;

const BM25_STOP_WORDS = [
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "our",
  "they",
  "their",
  "not",
  "also",
  "et",
  "al",
] as const;

export type Bm25ScoringConfiguration = {
  version: "canonical-bm25-v1";
  k1: number;
  b: number;
  tokenizer: {
    version: "unicode-token-plural-fold-stopwords-v2";
    tokenPattern: string;
    lowercase: true;
    stopWords: readonly string[];
  };
  tieBreaker: "document-id-code-unit-ascending";
};

export const BM25_DEFAULT_SCORING_CONFIGURATION: Bm25ScoringConfiguration = {
  version: "canonical-bm25-v1",
  k1: 1.2,
  b: 0.75,
  tokenizer: {
    version: "unicode-token-plural-fold-stopwords-v2",
    tokenPattern: BM25_TOKEN_PATTERN,
    lowercase: true,
    stopWords: BM25_STOP_WORDS,
  },
  tieBreaker: "document-id-code-unit-ascending",
};

/**
 * Light plural folding so "neurons"/"neuron" and "cells"/"cell" share a term.
 * Deliberately conservative: only a trailing "s" on longer alphabetic tokens
 * that do not end in "ss", "us", or "is".
 */
function foldPlural(token: string): string {
  if (
    token.length > 3 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is") &&
    /^\p{L}+$/u.test(token)
  ) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenizeBm25Text(
  text: string,
  configuration: Bm25ScoringConfiguration = BM25_DEFAULT_SCORING_CONFIGURATION,
): string[] {
  const tokenPattern = new RegExp(configuration.tokenizer.tokenPattern, "gu");
  const stopWords = new Set(configuration.tokenizer.stopWords);
  const matches = text.toLowerCase().match(tokenPattern) ?? [];
  return matches.filter((token) => !stopWords.has(token)).map(foldPlural);
}

type IndexedDocument<TDocument> = {
  document: TDocument;
  termFrequencies: Map<string, number>;
  length: number;
};

export type Bm25Index<TDocument> = {
  indexedDocuments: IndexedDocument<TDocument>[];
  documentFrequencies: Map<string, number>;
  averageLength: number;
  configuration: Bm25ScoringConfiguration;
};

/**
 * Tokenize and index a corpus once so many queries can be ranked against it
 * without re-tokenizing every document per query.
 */
export function buildBm25Index<TDocument>(
  documents: readonly TDocument[],
  getText: (document: TDocument) => string,
  configuration: Bm25ScoringConfiguration = BM25_DEFAULT_SCORING_CONFIGURATION,
): Bm25Index<TDocument> {
  const indexedDocuments: IndexedDocument<TDocument>[] = [];
  const documentFrequencies = new Map<string, number>();
  let totalLength = 0;

  for (const document of documents) {
    const tokens = tokenizeBm25Text(getText(document), configuration);
    const termFrequencies = new Map<string, number>();
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }

    for (const token of new Set(tokens)) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }

    indexedDocuments.push({
      document,
      termFrequencies,
      length: tokens.length,
    });
    totalLength += tokens.length;
  }

  return {
    indexedDocuments,
    documentFrequencies,
    averageLength:
      indexedDocuments.length > 0 ? totalLength / indexedDocuments.length : 0,
    configuration,
  };
}

export function rankDocumentsByBm25Detailed<TDocument>(
  query: string,
  documents: readonly TDocument[],
  getText: (document: TDocument) => string,
  getDocumentId: (document: TDocument) => string,
  limit: number,
  configuration: Bm25ScoringConfiguration = BM25_DEFAULT_SCORING_CONFIGURATION,
): DetailedRankedDocument<TDocument>[] {
  return rankBm25Index(
    buildBm25Index(documents, getText, configuration),
    query,
    getDocumentId,
    limit,
  );
}

export function rankBm25Index<TDocument>(
  index: Bm25Index<TDocument>,
  query: string,
  getDocumentId: (document: TDocument) => string,
  limit: number,
): DetailedRankedDocument<TDocument>[] {
  const {
    indexedDocuments,
    documentFrequencies,
    averageLength,
    configuration,
  } = index;
  if (indexedDocuments.length === 0) {
    return [];
  }
  const queryTerms = tokenizeBm25Text(query, configuration);
  if (queryTerms.length === 0) {
    return [];
  }

  const documentCount = indexedDocuments.length;
  const { k1, b } = configuration;

  const ranked = indexedDocuments
    .map((indexed) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = indexed.termFrequencies.get(term) ?? 0;
        if (tf === 0) {
          continue;
        }

        const df = documentFrequencies.get(term) ?? 0;
        const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
        const denominator =
          tf + k1 * (1 - b + b * (indexed.length / (averageLength || 1)));
        score += idf * ((tf * (k1 + 1)) / denominator);
      }

      return {
        document: indexed.document,
        score,
      };
    })
    .filter((rankedDocument) => rankedDocument.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCodeUnits(
          getDocumentId(left.document),
          getDocumentId(right.document),
        ),
    )
    .slice(0, limit)
    .map((rankedDocument, index) => ({
      ...rankedDocument,
      rank: index + 1,
    }));

  return ranked;
}
