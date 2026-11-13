/**
 * One version per prompt. It is recorded in every call's provenance and keys
 * the exact-result cache, so bump it whenever the prompt text, its output
 * schema, or how its answer is read changes.
 */
export const PROMPT_VERSIONS = {
  /** Attributed claim extraction from a citing-paper mention (Discover). */
  extraction: "2026-09-02-v4",
  /** Paraphrased claims clustered across citers, per seed (Discover). */
  canonicalization: "2026-09-02-v2",
  /** A family claim grounded in the seed text (Scope). */
  grounding: "2026-11-12-v3",
  /**
   * The seed codebook calls (Scope). Stored codebooks are keyed by this, so
   * bumping it regenerates them.
   */
  seedCodebook: "2026-11-12-v2",
  /** One citing claim tagged against its seed codebook (Scope). */
  codebookTagging: "2026-11-12-v1",
  /** Citation role for occurrences the regex pass leaves unclear (Prepare). */
  roleClassification: "2026-09-23-v2",
  /** Relevance reranking of BM25 candidates (Evidence). */
  rerank: "2026-09-02-v2",
  /** Adjudication from Evidence's selected chunks. */
  adjudication: "2026-09-23-v11",
  /** Adjudication from the whole seed text. */
  seedTextAdjudication: "2026-11-11-v1",
} as const;
