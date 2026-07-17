export type RankedDocument<TDocument> = {
  document: TDocument;
  score: number;
};

export type DetailedRankedDocument<TDocument> = RankedDocument<TDocument> & {
  rank: number;
};

export const BM25_TOKEN_PATTERN = String.raw`\b[\p{L}\p{N}][\p{L}\p{N}-]{1,}\b`;

export const BM25_STOP_WORDS = [
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
  "figure",
  "fig",
  "table",
] as const;

export type Bm25ScoringConfiguration = {
  version: "canonical-bm25-v1";
  k1: number;
  b: number;
  tokenizer: {
    version: "unicode-alphanumeric-hyphen-stopwords-v1";
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
    version: "unicode-alphanumeric-hyphen-stopwords-v1",
    tokenPattern: BM25_TOKEN_PATTERN,
    lowercase: true,
    stopWords: BM25_STOP_WORDS,
  },
  tieBreaker: "document-id-code-unit-ascending",
};

export function tokenizeBm25Text(
  text: string,
  configuration: Bm25ScoringConfiguration = BM25_DEFAULT_SCORING_CONFIGURATION,
): string[] {
  const tokenPattern = new RegExp(configuration.tokenizer.tokenPattern, "gu");
  const stopWords = new Set(configuration.tokenizer.stopWords);
  const matches = text.toLowerCase().match(tokenPattern) ?? [];
  return matches.filter((token) => !stopWords.has(token));
}

type IndexedDocument<TDocument> = {
  document: TDocument;
  termFrequencies: Map<string, number>;
  length: number;
};

function buildIndex<TDocument>(
  documents: readonly TDocument[],
  getText: (document: TDocument) => string,
  configuration: Bm25ScoringConfiguration,
): {
  indexedDocuments: IndexedDocument<TDocument>[];
  documentFrequencies: Map<string, number>;
  averageLength: number;
} {
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
  };
}

export function rankDocumentsByBm25<TDocument>(
  query: string,
  documents: TDocument[],
  getText: (document: TDocument) => string,
  limit: number,
): RankedDocument<TDocument>[] {
  const idsByDocument = new Map<TDocument, string>();
  documents.forEach((document, index) => {
    idsByDocument.set(document, String(index).padStart(12, "0"));
  });
  return rankDocumentsByBm25Detailed(
    query,
    documents,
    getText,
    (document) => idsByDocument.get(document)!,
    limit,
  ).map(({ document, score }) => ({ document, score }));
}

export function rankDocumentsByBm25Detailed<TDocument>(
  query: string,
  documents: readonly TDocument[],
  getText: (document: TDocument) => string,
  getDocumentId: (document: TDocument) => string,
  limit: number,
  configuration: Bm25ScoringConfiguration = BM25_DEFAULT_SCORING_CONFIGURATION,
): DetailedRankedDocument<TDocument>[] {
  if (documents.length === 0) {
    return [];
  }

  const { indexedDocuments, documentFrequencies, averageLength } = buildIndex(
    documents,
    getText,
    configuration,
  );
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

export function buildRetrievalQuery(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
