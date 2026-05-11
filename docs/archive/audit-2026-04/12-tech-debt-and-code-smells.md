# Tech Debt & Code Smells Audit

## Overall Assessment: Clean codebase with debt in documentation and organization, not code quality

Strong TypeScript strictness (zero `any`, zero `@ts-ignore`), no dead code or TODO comments. Main debt is in documentation density, monolithic files, scattered constants, and version string management.

---

## Critical Issues

### 1. Documentation debt in large complex files
- 6 files >300 LOC with <2% comment density
- Most impacted:
  - `src/retrieval/fulltext-fetch.ts` (1451 LOC, 0.76% comments) — multi-strategy acquisition
  - `src/contract/workflow.ts` (800 LOC, 0.12% comments) — 51 nesting levels of Zod schemas
  - `src/contract/selectors.ts` (547 LOC, 0.18% comments) — complex artifact reconstruction
  - `src/integrations/llm-client.ts` (929 LOC, 2.04% comments) — caching & telemetry core
  - `src/pipeline/pre-screen.ts` (1244 LOC, 2.73% comments) — main pipeline entry point
- **Fix:** Add module-level JSDoc explaining purpose, inputs, outputs. Document complex branching.

---

## High Priority

### 2. Monolithic command files
| File | LOC | Issue |
|------|-----|-------|
| `src/cli/commands/pipeline.ts` | 1726 | Single `run()` orchestrating entire e2e flow |
| `src/retrieval/fulltext-fetch.ts` | 1451 | 7 acquisition strategies lumped together |
| `src/pipeline/pre-screen.ts` | 1244 | resolve -> dedup -> filter -> ground -> audit in one file |

- **Fix pipeline.ts:** Extract per-stage orchestration into sub-modules
- **Fix fulltext-fetch.ts:** Extract strategy implementations into `src/retrieval/acquisition/` subdirectory
- **Fix pre-screen.ts:** Split into orchestrator + cite-dedup + claim-filter + grounding sub-files

---

## Medium Priority

### 3. Hardcoded version strings scattered through codebase
Found 8+ prompt template and cache key versions as magic strings:
- `ATTRIBUTED_CLAIM_PROMPT_TEMPLATE_VERSION = "2026-04-08-v1"` (attributed-claim-extraction.ts)
- `EXTRACTION_CACHE_KEY_VERSION = "extraction-2026-04-11-v1"` (attributed-claim-extraction.ts)
- `GROUNDING_CACHE_KEY_VERSION = "grounding-2026-04-11-v1"` (seed-claim-grounding-llm.ts)
- `ADJUDICATION_CACHE_KEY_VERSION = "adjudication-2026-04-14-v8"` (llm-adjudicator.ts)
- `RERANK_CACHE_KEY_VERSION = "rerank-2026-04-11-v1"` (llm-reranker.ts)

Both "prompt template version" and "cache key version" exist independently per module.
- **Fix:** Create central version registry in `src/config/llm-versions.ts`

### 4. Magic numbers for thresholds and limits
| Value | File | Context |
|-------|------|---------|
| `4096` | `claim-ranking.ts:67`, `llm-claim-family-filter.ts` | Thinking budget (duplicated) |
| `0.25` | `sample-audit.ts:192` | Audit sample proportion (undocumented) |
| `1024`, `512` | `fulltext-fetch.ts:165,181` | HTML snippet sizes |
| `800` | Multiple files | Citation context window chars |
| `0.22` | `pre-screen.ts` | BM25 relevance min fraction |

- **Fix:** Create `src/config/constants.ts` with named exports and rationale comments

### 5. Duplicate evidence filtering logic
- `evidence-retrieval.ts`, `llm-reranker.ts`, `pre-screen.ts` all implement variations of "find best spans matching query"
- **Fix:** Extract shared `EvidenceFilterStrategy` interface

### 6. Deep nesting in workflow schemas
- `src/contract/workflow.ts` — ~51 nesting levels of Zod schema definitions
- **Fix:** Use intermediate type definitions; split into separate files

---

## Low Priority

### 7. No custom error classes (except LLMProviderError)
- All errors are plain `Error` objects
- **Fix:** Consider `UnresolvedPaperError`, `FullTextAcquisitionError` for domain specificity

### 8. No structured logging library
- Relies on `console.error()` / `console.info()` throughout
- **Fix:** Consider Pino or Winston for structured logging (optional for CLI tool)

### 9. Acquisition / retrieval terminology inconsistency
- `FullTextAcquisition`, `FullTextContent`, "retrieval", "locator" vs "URL" — some overlap
- **Fix:** Low priority; documented in types but could be more consistent

---

## Positive Findings (maintain these)

- **Zero TODO/FIXME/HACK comments** — clean commit hygiene
- **Zero dead code** — 416 exports all in use
- **Zero `@ts-ignore`/`@ts-expect-error`** in source
- **Zero `any` in production code** — `no-explicit-any: error` enforced
- **Type assertions minimal and justified** — 6 uses of `as`, all immediately followed by validation
- **No debug statements** left in production code
- **Strong TypeScript config:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
- **Result<T> pattern consistently used** for expected failures
- **Barrel exports appropriate** for public API contracts (contract)
- **ESLint + Prettier well-configured** with type-checked rules
