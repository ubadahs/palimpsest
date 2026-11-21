/**
 * One version per prompt. It is recorded in every call's provenance and keys
 * the exact-result cache, so bump it whenever the prompt text, its output
 * schema, or how its answer is read changes.
 */
export const PROMPT_VERSIONS = {
  /** Attributed claim extraction from a citing-paper mention (Discover). */
  extraction: "2026-11-18-v5",
  /** Paraphrased claims clustered across citers, per seed (Discover). */
  clustering: "2026-09-02-v2",
  /** A family claim grounded in the seed text (Scope). */
  grounding: "2026-11-18-v4",
  /** The cited paper's own findings, verified against exact source quotes. */
  seedInventory: "2026-11-20-v4",
  /** Relationships of exact citation statements to the grounded inventory. */
  seedStatementMatching: "2026-11-20-v2",
  /** Version-bound route and direct content comparison at the later citation. */
  historyAssessment: "2026-11-20-v8",
  /** Citation role for occurrences the regex pass leaves unclear (Prepare). */
  roleClassification: "2026-09-23-v2",
  /** Relevance reranking of BM25 candidates (Evidence). */
  rerank: "2026-09-02-v2",
  /** Adjudication from Evidence's selected chunks. */
  adjudication: "2026-11-14-v13",
  /** Adjudication from the whole seed text. */
  seedTextAdjudication: "2026-11-14-v3",
} as const;
