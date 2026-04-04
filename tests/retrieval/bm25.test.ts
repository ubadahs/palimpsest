import { describe, expect, it } from "vitest";

import {
  buildRetrievalQuery,
  rankDocumentsByBm25,
} from "../../src/retrieval/bm25.js";

type TestDocument = {
  id: string;
  text: string;
};

const LEGACY_STOP_WORDS = new Set([
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
  "fig",
  "figure",
  "table",
  "as",
  "such",
]);

function legacyExtractKeyTerms(text: string): string[] {
  const words = text.toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) ?? [];
  return [
    ...new Set(words.filter((word) => !LEGACY_STOP_WORDS.has(word))),
  ].slice(0, 30);
}

function legacyExtractEntities(text: string): string[] {
  const entities: string[] = [];

  const geneProtein = text.match(
    /\b(?:Rab\d+|ACAP\d*|Par\d+[a-z]?|HNF4[αα]|Sox\d+|MARK\d+|Rab35|ICAM-\d+)\b/gi,
  );
  if (geneProtein) {
    entities.push(...geneProtein.map((entity) => entity.toLowerCase()));
  }

  const structures = text.match(
    /\b(?:bile\s+canalicul[ia]|apical\s+bulkhead|lumen|cyst|hepatocyte|hepatoblast|epithelial|polarity)\b/gi,
  );
  if (structures) {
    entities.push(...structures.map((entity) => entity.toLowerCase()));
  }

  return [...new Set(entities)];
}

function legacyHeuristicScore(query: string, text: string): number {
  const keyTerms = legacyExtractKeyTerms(query);
  const entities = legacyExtractEntities(query);
  const textLower = text.toLowerCase();

  let entityHits = 0;
  for (const entity of entities) {
    if (textLower.includes(entity)) {
      entityHits++;
    }
  }

  let keywordHits = 0;
  for (const keyTerm of keyTerms) {
    if (textLower.includes(keyTerm)) {
      keywordHits++;
    }
  }

  if (entityHits >= 2 && keywordHits >= 3) {
    return entityHits * 3 + keywordHits;
  }
  if (keywordHits >= 4) {
    return keywordHits;
  }
  if (entityHits >= 1 && keywordHits >= 2) {
    return entityHits * 2 + keywordHits;
  }

  return 0;
}

describe("rankDocumentsByBm25", () => {
  it("beats the old entity-gated heuristic on a paraphrase-style fixture", () => {
    const query = buildRetrievalQuery([
      "junction failure altered tubular anisotropy",
    ]);
    const documents: TestDocument[] = [
      {
        id: "legacy-top",
        text: "General discussion of imaging controls and collagen concentration.",
      },
      {
        id: "bm25-top",
        text: "Collapse of epithelial bridges altered anisotropy in developing ducts.",
      },
      {
        id: "weak",
        text: "Anisotropy measurements were reported for several tissues.",
      },
    ];

    const legacyTop = [...documents].sort(
      (left, right) =>
        legacyHeuristicScore(query, right.text) -
        legacyHeuristicScore(query, left.text),
    )[0];
    const bm25Top = rankDocumentsByBm25(
      query,
      documents,
      (document) => document.text,
      3,
    )[0];

    expect(legacyTop?.id).toBe("legacy-top");
    expect(bm25Top?.document.id).toBe("bm25-top");
  });
});
