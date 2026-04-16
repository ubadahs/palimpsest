# Codebase Audit Summary

**Date:** 2026-04-16
**Scope:** Full codebase — architecture, domain logic, pipeline, LLM integration, storage, error handling, CLI, UI, testing, retrieval, external integrations, tech debt
**Reports:** 12 focused audit files in this directory

---

## Executive Assessment

The Palimpsest codebase is **well-engineered with strong fundamentals**: strict TypeScript (zero `any`, zero `@ts-ignore`), clean ESM compliance, consistent adapter patterns for DI, a well-defined `Result<T>` error type, and comprehensive LLM telemetry. The architecture is sound — module boundaries are clear, dependency flow is mostly correct, and the domain layer is almost purely functional.

The primary debt is in **resilience, documentation, and testing** — not in code quality itself.

---

## Critical Issues (fix before scaling)

These are the highest-impact items across all 12 audits. Each one risks silent data loss, incorrect results, or wasted compute at scale.

| # | Issue | Report | Impact |
|---|-------|--------|--------|
| 1 | **Domain imports pipeline types** (circular dependency) | [Architecture](01-architecture-and-design.md) | Prevents clean separation; blocks refactoring |
| 2 | **Storage imports UI contract** (dependency violation) | [Architecture](01-architecture-and-design.md) | UI changes force storage changes |
| 3 | **Discovery handoff lost on `--run-id` resume** | [Pipeline](03-pipeline-orchestration.md) | Re-runs expensive DOI resolution, OpenAlex, LLM grounding on every resume |
| 4 | **LLM cache key doesn't include output schema** | [LLM](04-llm-integration-and-prompts.md) | `generateObject()` can serve wrong cached data silently |
| 5 | **Fragile JSON extraction from LLM output** | [Error Handling](06-error-handling-and-resilience.md) | Returns entire text to `JSON.parse()` when no JSON found |
| 6 | **Hard-coded 600-char evidence truncation** | [Retrieval](10-retrieval-and-evidence.md) | Cuts mid-sentence; destroys evidence semantics for adjudicator |
| 7 | **Transient failures permanently deprioritize families** | [Error Handling](06-error-handling-and-resilience.md) | Temporary network blip = family never evaluated |
| 8 | **No artifact validation on pipeline resume** | [Pipeline](03-pipeline-orchestration.md) | Corrupted JSON can propagate downstream |
| 9 | **All 14 CLI commands untested** | [Testing](09-testing-and-quality.md) | User-facing orchestration has zero coverage |
| 10 | **UI test suite broken** (ESM/CJS conflict) | [UI](08-nextjs-ui.md) | 0% pass rate in UI tests |

---

## High Priority Issues (should fix soon)

| # | Issue | Report |
|---|-------|--------|
| 11 | No retry logic for transient LLM failures | [LLM](04-llm-integration-and-prompts.md) |
| 12 | No circuit breaker for OpenAlex/S2/GROBID APIs | [Error Handling](06-error-handling-and-resilience.md), [Integrations](11-external-integrations.md) |
| 13 | Adjudication prompts can overflow context window | [LLM](04-llm-integration-and-prompts.md) |
| 14 | Full-document manuscripts can exceed LLM context limits | [LLM](04-llm-integration-and-prompts.md) |
| 15 | `finish_reason === "length"` not handled (truncated LLM output) | [Error Handling](06-error-handling-and-resilience.md) |
| 16 | Cost double-counting in advisor adjudication telemetry | [LLM](04-llm-integration-and-prompts.md) |
| 17 | Prompt injection risk in grounding suffix and reranker | [LLM](04-llm-integration-and-prompts.md), [Retrieval](10-retrieval-and-evidence.md) |
| 18 | Claim discovery model undersized (Haiku for complex extraction) | [LLM](04-llm-integration-and-prompts.md) |
| 19 | Prompt caching not enabled for adjudication (20-40% cost savings missed) | [LLM](04-llm-integration-and-prompts.md) |
| 20 | S2 API key potentially exposed in logging | [Integrations](11-external-integrations.md) |
| 21 | Unbounded database growth — no retention policy | [Storage](05-storage-and-data-layer.md) |
| 22 | `.env.local` uses wrong env var name | [CLI](07-cli-and-developer-ux.md) |
| 23 | Doctor command outputs raw JSON only | [CLI](07-cli-and-developer-ux.md) |
| 24 | No `--help` per CLI command (30+ undocumented flags) | [CLI](07-cli-and-developer-ux.md) |
| 25 | No E2E tests or CI pipeline | [Testing](09-testing-and-quality.md) |
| 26 | Citation function extensibility not enforced at runtime | [Domain](02-domain-logic-and-taxonomy.md) |
| 27 | Waterfall data fetching on UI stage detail page | [UI](08-nextjs-ui.md) |
| 28 | 9 of 11 reporting modules untested | [Testing](09-testing-and-quality.md) |

---

## Cross-Cutting Themes

### Theme 1: Resilience gaps at system boundaries
The codebase handles the happy path well but lacks defensive patterns at boundaries:
- LLM responses: no truncation detection, fragile JSON extraction, no retry
- External APIs: no circuit breaker, blind backoff, transient errors treated as permanent
- Pipeline resume: handoff state lost, artifacts not validated

**Recommendation:** Implement a resilience layer: circuit breakers for external APIs, retry with backoff for LLM calls, and structured error classification (transient vs. permanent) throughout.

### Theme 2: Testing concentrated in middle layers, missing at edges
Domain logic and retrieval algorithms are well-tested. But the user-facing edges (CLI commands, reporting, UI) and system boundaries (LLM output parsing, HTTP retries, error cascades) have minimal coverage.

**Recommendation:** Prioritize testing at the boundaries: CLI argument parsing, LLM response parsing (especially malformed JSON), E2E pipeline runs, and error propagation paths.

### Theme 3: Documentation and developer experience debt
The code itself is clean (zero TODOs, zero dead code, strong types), but the _surrounding_ documentation is thin:
- Large files (1000+ LOC) with <2% comment density
- CLI flags undocumented; no getting-started guide
- No architecture diagram; no troubleshooting doc
- No CI pipeline to enforce quality gates

**Recommendation:** Write `CONTRIBUTING.md`, `docs/cli-flags.md`, `docs/troubleshooting.md`. Add JSDoc to the 6 largest files. Set up GitHub Actions for test/lint/typecheck.

### Theme 4: Cost optimization opportunities left on the table
- Adjudication (Opus, most expensive stage) doesn't use ephemeral prompt caching — potential 20-40% savings
- Claim discovery defaults to Haiku for a task that needs Sonnet — cheaper per-call but higher error rate = more retries
- Discovery handoff lost on resume means expensive stages re-run unnecessarily

**Recommendation:** Enable prompt caching for adjudication. Upgrade claim-discovery default to Sonnet. Serialize handoffs for resume.

### Theme 5: LLM cache safety
The exact-result cache is a powerful optimization but has two safety gaps:
- Cache key doesn't include output schema (wrong data for `generateObject()`)
- Manual version bumping is fragile (stale prompts served from cache)

**Recommendation:** Include schema in cache key. Consider content-addressable prompt hashing.

---

## Remediation Roadmap

### Phase 1: Critical Fixes (1-2 days)
- [x] Move `FamilyGroundingTrace` to domain layer (architecture fix)
- [x] ~~Extract stage definitions from ui-contract to shared location~~ (not a real issue: ui-contract IS the shared contract layer per CLAUDE.md)
- [x] Include output schema in LLM cache key
- [x] Fix JSON extraction to validate extracted content before returning
- [x] Replace 600-char truncation with sentence-aware truncation
- [x] ~~Distinguish transient vs. permanent failures in pre-screen~~ (HTTP client already retries 3x; deferred to Phase 2 resilience work)
- [x] Fix `.env.local` env var name mismatch

### Phase 2: Resilience & Cost (3-5 days)
- [x] Serialize discovery handoffs to disk for resume
- [x] Add artifact validation on pipeline resume (file existence + empty check)
- [x] Add retry logic for transient LLM failures (2 retries with exponential backoff + jitter)
- [ ] ~~Implement circuit breaker for external APIs~~ (deferred — HTTP client already retries 3x; circuit breaker adds complexity for a CLI tool)
- [x] Handle `finish_reason === "length"` (truncated flag, warning log, skip caching truncated responses)
- [x] Enable ephemeral prompt caching for adjudication and evidence-rerank
- [x] Add prompt size assertion before LLM calls (adjudicator warns >100K chars)
- [x] Upgrade claim-discovery default model to Sonnet
- [x] ~~Fix cost double-counting in advisor adjudication~~ (not a real issue: both passes correctly aggregated, each call counted once)

### Phase 3: Testing & CI (1 week)
- [ ] Fix UI test suite (ESM/CJS conflict)
- [ ] Add tests for CLI argument parsing (top 5 commands)
- [ ] Add LLM output parsing tests (malformed JSON, schema mismatch)
- [ ] Add E2E test with fixture data
- [ ] Set up GitHub Actions for test/lint/typecheck
- [ ] Add coverage thresholds to vitest config

### Phase 4: UX & Documentation (1 week)
- [ ] Add per-command `--help` with flag descriptions
- [ ] Add human-readable doctor output
- [ ] Create `CONTRIBUTING.md` with setup guide
- [ ] Create `docs/cli-flags.md`
- [ ] Add JSDoc to 6 largest files
- [ ] Create `docs/troubleshooting.md`
- [ ] Centralize constants and version strings

### Phase 5: Polish (ongoing)
- [ ] Add data retention policy for DB
- [ ] Replace `.passthrough()` with `.strict()` on Zod schemas
- [ ] Split monolithic files (pipeline.ts, fulltext-fetch.ts, pre-screen.ts)
- [ ] Add snapshot tests for report output
- [ ] Add dark mode / accessibility polish to UI
- [ ] Document proxy strategy configuration

---

## Strengths to Preserve

These are things the codebase does well that should be maintained as the project evolves:

1. **TypeScript strictness** — `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, zero `any`
2. **Adapter pattern for DI** — Clean interfaces on all pipeline stages enable testing and swappability
3. **Result<T> for expected failures** — Consistent, explicit error handling without exception soup
4. **Centralized LLM client** — Single source of truth with comprehensive telemetry and cost tracking
5. **ESM compliance** — All `.js` extensions, `verbatimModuleSyntax`, clean NodeNext resolution
6. **Deferred LLM reranking** — BM25 for all, LLM only on curated subset (~80% cost savings)
7. **Advisor adjudication** — Two-pass Sonnet/Opus strategy (~50-70% cost savings)
8. **Artifact immutability** — Timestamped, SHA256 manifests, reproducible lineage
9. **Zero dead code** — 416 exports all in use, no TODOs or debug statements
10. **Family consolidation** — Opus+thinking clustering with full merge provenance

---

## Detailed Reports

| # | Report | Focus |
|---|--------|-------|
| 1 | [Architecture & Design](01-architecture-and-design.md) | Module boundaries, dependency flow, coupling |
| 2 | [Domain Logic & Taxonomy](02-domain-logic-and-taxonomy.md) | Enums, schemas, decision logic, extensibility |
| 3 | [Pipeline Orchestration](03-pipeline-orchestration.md) | Stage sequencing, handoff, resume, cost tracking |
| 4 | [LLM Integration & Prompts](04-llm-integration-and-prompts.md) | Prompt quality, model selection, caching, parsing |
| 5 | [Storage & Data Layer](05-storage-and-data-layer.md) | SQLite schema, migrations, repositories |
| 6 | [Error Handling & Resilience](06-error-handling-and-resilience.md) | Result types, exceptions, degradation |
| 7 | [CLI & Developer UX](07-cli-and-developer-ux.md) | Commands, args, output, config, onboarding |
| 8 | [Next.js UI](08-nextjs-ui.md) | Components, API routes, state, testing |
| 9 | [Testing & Quality](09-testing-and-quality.md) | Coverage gaps, test quality, CI |
| 10 | [Retrieval & Evidence](10-retrieval-and-evidence.md) | Chunking, BM25, reranking, span selection |
| 11 | [External Integrations](11-external-integrations.md) | OpenAlex, S2, GROBID, proxy, rate limits |
| 12 | [Tech Debt & Code Smells](12-tech-debt-and-code-smells.md) | Documentation, complexity, constants, naming |
