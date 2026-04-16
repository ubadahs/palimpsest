# Testing & Quality Audit

## Overall Assessment: Moderate coverage with critical gaps in CLI, E2E, and error paths

47 test files with 357+ test cases. Solid testing in domain logic and retrieval. Major gaps in CLI commands, reporting, LLM output parsing, and no CI pipeline.

---

## Critical Issues

### 1. All 14 CLI command files are untested
- **Directory:** `src/cli/commands/` (14 files)
- User-facing orchestration entrypoints with complex argument parsing and stage coordination
- **Fix:** Add tests for argument parsing, error handling, and orchestration logic for at minimum: `pipeline`, `discover`, `screen`, `adjudicate`, `classify`

### 2. No E2E tests
- No tests that invoke CLI or exercise the full pipeline with fixture data
- Can't detect breaking changes in artifact flow or database persistence
- **Fix:** Add 2-3 E2E tests using fixture DOIs through `discover` and `pipeline` commands

### 3. No CI pipeline configured
- No `.github/workflows/`, `.gitlab-ci.yml`, or equivalent
- Tests not enforced on commits; regressions can merge to main
- **Fix:** Add GitHub Actions workflow for test, lint, typecheck on push/PR

---

## High Priority

### 4. 9 of 11 reporting modules untested
- Only `discovery-report.ts` and `pre-screen-report.ts` have 1 test each (smoke level)
- Report output regressions undetectable
- **Fix:** Add tests for all report generators; use snapshot tests for Markdown/JSON output

### 5. LLM output parsing untested
- No tests for invalid JSON responses, truncated responses, or schema mismatches
- **Files needing coverage:** `llm-client.ts` (generateObject), `llm-adjudicator.ts`, `llm-reranker.ts`
- **Fix:** Add tests for malformed JSON, partial JSON, wrong enum values

### 6. HTTP client retry logic untested
- **File:** `src/integrations/http-client.ts`
- Retry logic (429, 5xx), timeout handling, schema validation — zero coverage
- **Fix:** Add tests for retry scenarios, timeout edge cases

### 7. Adjudication prompt building untested
- **File:** `src/adjudication/llm-adjudicator.ts`
- `buildPrompt()` not tested — prompt construction bugs go undetected
- **Fix:** Add prompt construction tests with known good examples

### 8. UI test suite broken
- All `apps/ui/tests/` fail due to ESM/CJS conflict in jsdom
- **Fix:** Resolve vitest + jsdom ESM compatibility

---

## Medium Priority

### 9. Mock drift risk in pre-screen tests
- **File:** `tests/pipeline/pre-screen.test.ts`
- Mock manually replicates grounding logic; can diverge from real implementation
- **Fix:** Document mock contract; add periodic integration tests behind env flag

### 10. No snapshot/golden tests
- Zero snapshot tests in entire suite
- Breaking changes to artifact formats (JSON, Markdown) undetected
- **Fix:** Add snapshots for report output, stage artifact shapes, stage inspector payloads

### 11. No shared test utilities
- Each test file defines its own factories (`makePaper()`, `mention()`, etc.)
- **Fix:** Create `tests/fixtures.ts` with shared factory functions

### 12. Vitest config missing coverage thresholds
- **File:** `vitest.config.mjs`
- No coverage thresholds, no timeout limits, no environment config
- **Fix:** Add `coverage: { lines: 60, functions: 60 }`, `testTimeout: 10000`

### 13. Incomplete ESLint rules
- Missing: `no-console` (catches debug logs), `@typescript-eslint/no-floating-promises`, `prefer-const`
- **Fix:** Add these rules to catch common issues

---

## Coverage Gaps by Module

| Module | Test Files | Source Files | Coverage | Priority |
|--------|-----------|--------------|----------|----------|
| cli/commands | 0 | 14 | 0% | CRITICAL |
| reporting | 2 | 11 | 18% | HIGH |
| config | 1 | 3 | 33% | MEDIUM |
| domain | 5 | 16 | 31% | MEDIUM |
| contract | 3 | 8 | 38% | MEDIUM |
| adjudication | 1 | 2 | 50% | HIGH |
| pipeline | 8 | 14 | 57% | MEDIUM |
| storage | 4 | 6 | 67% | LOW |
| retrieval | 8 | 11 | 73% | LOW |
| integrations | 4 | 5 | 80% | LOW |

---

## Strengths (no action needed)

- **Well-structured fixtures:** Factory functions with sensible defaults and easy overrides
- **Meaningful assertions:** Tests verify behavior, not just code execution
- **Proper mock isolation:** `vi.mock()` with explicit reset between tests
- **In-memory SQLite:** Storage tests use `:memory:` databases for speed and isolation
- **TypeScript strictness in tests:** Tests type-checked and linted at equal rigor
- **Zero `@ts-ignore`/`@ts-expect-error`** in source code
- **Strong ESLint config:** `no-explicit-any` error in src/, `consistent-type-imports` enforced
- **Cache key version tests:** `llm-result-cache.test.ts` properly tests version invalidation
- **Adapter interface tests:** Pipeline tests verify adapter contracts
