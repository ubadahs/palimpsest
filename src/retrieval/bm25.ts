export type RankedDocument<TDocument> = {
  document: TDocument;
  score: number;
};

const TOKEN_RE = /\b[\p{L}\p{N}][\p{L}\p{N}-]{1,}\b/gu;

const STOP_WORDS = new Set([
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
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_RE) ?? [];
  return matches.filter((token) => !STOP_WORDS.has(token));
}

type IndexedDocument<TDocument> = {
  document: TDocument;
  termFrequencies: Map<string, number>;
  length: number;
};

function buildIndex<TDocument>(
  documents: TDocument[],
  getText: (document: TDocument) => string,
): {
  indexedDocuments: IndexedDocument<TDocument>[];
  documentFrequencies: Map<string, number>;
  averageLength: number;
} {
  const indexedDocuments: IndexedDocument<TDocument>[] = [];
  const documentFrequencies = new Map<string, number>();
  let totalLength = 0;

  for (const document of documents) {
    const tokens = tokenize(getText(document));
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
  if (documents.length === 0) {
    return [];
  }

  const { indexedDocuments, documentFrequencies, averageLength } = buildIndex(
    documents,
    getText,
  );
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return [];
  }

  const documentCount = indexedDocuments.length;
  const k1 = 1.2;
  const b = 0.75;

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
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return ranked;
}

export function buildRetrievalQuery(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}
