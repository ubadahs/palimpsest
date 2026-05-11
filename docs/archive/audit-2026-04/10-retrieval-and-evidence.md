# Retrieval & Evidence Audit

## Overall Assessment: Sound architecture with critical truncation issue and chunking gaps

Multi-stage BM25 -> local-rerank -> LLM-rerank pipeline with good separation. Critical issue: hard-coded 600-char truncation destroys evidence semantics. Chunking and bundle detection need refinement.

---

## Critical Issues

### 1. Hard-coded 600-character truncation of evidence spans
- **File:** `src/retrieval/evidence-retrieval.ts:213`
- Naive `substring(0, 600)` — cuts mid-sentence, mid-word, mid-unit
- Can remove critical qualifications: "does NOT bind to receptor..." -> "does "
- **Fix:** Replace with sentence-aware truncation using `SENTENCE_RE`. Keep sentences greedily up to ~600 chars; allow slight overage to avoid splitting. Append "..." if truncated.

### 2. Prompt injection vulnerability in LLM reranker
- **File:** `src/retrieval/llm-reranker.ts:104-157`
- Candidate block text and citing context interpolated directly into prompt without escaping
- Adversarial content in citation context could break JSON or inject instructions
- **Fix:** Use structured prompt format, escape JSON strings, or use tool/function call interface

---

## High Priority

### 3. Figure/table captions stored as monolithic blocks
- **File:** `src/retrieval/parsed-paper.ts:347-358`
- Entire caption = single chunk, even multi-sentence captions
- BM25 may match one sentence but LLM gets entire caption with irrelevant content
- **Fix:** Split captions by sentence before chunking

### 4. PDF extraction lacks citation marker coverage
- **File:** `src/retrieval/seed-mention-harvest.ts`
- Regex-based author-year matching on plain PDF text misses numeric citations ([42]), footnotes, bundled citations
- **Fix:** Document coverage limitations. Add `sourceQualityWarning` field. Consider refusing "success" status if <2 mentions from PDF source.

### 5. No max chunk size
- **File:** `src/retrieval/parsed-paper.ts:123-147`
- `appendBlock()` has minimum threshold (30 chars) but no maximum
- Very long paragraphs (Methods/Materials) become single 2000+ char chunks
- **Fix:** Add configurable `MAX_CHUNK_SIZE` (1000-1500 chars). Split on sentence boundaries.

---

## Medium Priority

### 6. BM25 index rebuilt per query (no caching)
- **File:** `src/retrieval/bm25.ts:114-163`
- `rankDocumentsByBm25()` rebuilds entire index from scratch on every call
- For 10 tasks against same 200 blocks, index rebuilt 10 times
- **Fix:** Export `buildIndex()` as public; build once per paper, reuse for all tasks

### 7. Stop word list missing domain-specific terms
- **File:** `src/retrieval/bm25.ts:8-62`
- Missing common scientific boilerplate: "results", "showed", "demonstrated", "methods", "data"
- **Fix:** Expand with domain-specific terms

### 8. Default topN=5 too low for bundled citations
- **File:** `src/retrieval/evidence-retrieval.ts:307`
- 5 references in one bundle -> only 1 span per cited paper
- **Fix:** Scale topN by bundle size, or increase default to 10 for bundled tasks

### 9. Hybrid fallback can create duplicate evidence
- **File:** `src/retrieval/evidence-retrieval.ts:202-205`
- Appends BM25 #1 if LLM dropped it, but no deduplication by blockId
- **Fix:** Deduplicate by blockId before returning; use LLM score when both sets contain same block

### 10. Multiple citation markers in one sentence not disambiguated
- **File:** `src/shared/citation-context-window.ts:134-157`
- `findMarkerPosition()` returns first match; may center window on wrong citation
- **Fix:** Accept `charOffsetStart` parameter and search only in window around it

### 11. Sentence splitting breaks on abbreviations
- **File:** `src/shared/citation-context-window.ts:8`
- `SENTENCE_RE = /[^.!?]*[.!?]+/g` fails on "e.g.", "i.e.", "Dr.", ellipses
- ▶◀ markers may surround partial sentences
- **Fix:** Use more robust sentence splitter that handles common abbreviations

### 12. Bundle detection uses fixed 80-character radius
- **File:** `src/retrieval/parsed-paper.ts:152` (CLUSTER_RADIUS = 80)
- Document-dependent; fixed radius misses legitimate bundles or incorrectly groups
- **Fix:** Make configurable or adaptive (e.g., `max(80, paragraph_length / 10)`)

### 13. Full-text fallback chain doesn't retry on transient errors
- **File:** `src/retrieval/fulltext-fetch.ts:1137-1183`
- Doesn't distinguish transient (timeout) from permanent (404) errors
- Transient blip on high-priority candidate causes immediate fallback
- **Fix:** Add `maxRetries: 1` for transient errors (5xx, timeout)

### 14. Abstract fragmented across paragraphs
- **File:** `src/retrieval/parsed-paper.ts:367-379`
- Each paragraph of multi-paragraph abstract becomes separate chunk
- BM25 may miss evidence split across chunks
- **Fix:** Concatenate all paragraphs within each abstract element before chunking

---

## Low Priority

### 15. No stemming or lemmatization in BM25
- "methods" and "method" treated as distinct tokens
- Acceptable given LLM reranking fallback

### 16. Limited Unicode handling in title normalization
- `normalizeTitle()` strips diacritics; "Bohm" != "Bohm"
- Low risk since DOI matching is tried first

### 17. LaTeX in titles/captions not preprocessed
- `\alpha` treated differently from "alpha" in BM25
- Low impact; only affects small fraction of papers

### 18. Bundle pattern detection doesn't handle numbered lists
- Only detects "semicolon_separated" and "parenthetical_group"
- Numeric citation bundles like "[1], [2], [3]" undetected
- **Fix:** Add "comma_separated" pattern detection

---

## Strengths (no action needed)

- Multi-strategy full-text acquisition: bioRxiv XML -> PMC XML -> PDF -> landing page -> proxy
- Deferred LLM reranking: BM25 (free) for all tasks, LLM only on curated subset (~80% cost savings)
- Evidence degrades gracefully to BM25 when LLM reranking fails
- ▶◀ citation scope annotation preserves paragraph context while disambiguating
- Acquisition record tracks all attempts with detailed provenance
- GROBID TEI and JATS XML both supported with structured parsing
- `blockKind` classification (abstract, figure_caption, table_caption, section) enables mode-specific retrieval
