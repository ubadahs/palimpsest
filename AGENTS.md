# AGENTS.md

Keep this file in sync with [CLAUDE.md](./CLAUDE.md).

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What This Project Is

CLI-first tooling for auditing citation fidelity in scientific literature. It analyzes whether citing papers faithfully represent the claims of cited papers — domain-agnostic and not limited to any single citation function. Local SQLite storage. **CLI and JSON/Markdown artifacts are canonical; there is no hosted multi-user product. A local-only Next.js app in `apps/ui` may orchestrate CLI subprocesses and inspect artifacts.**

The project follows a milestone-based implementation plan in `docs/implementation-plan.md`. **What is actually built today** is summarized in `docs/status.md` (CLI-aligned; update when phases land). The canonical design documents live in `docs/` (PRD, build spec, evaluation protocol, concept memo). Do not build infrastructure for later milestones early.

## Commands

```bash
npm run build          # clears dist/, then tsc compile src/ only (tsconfig.build.json)
npm run typecheck      # tsc --noEmit (src + tests)
npm run lint           # eslint src tests (UI has its own lint in apps/ui)
npm run lint:all       # root lint + UI workspace lint
npm run format         # prettier --write
npm run format:check   # prettier --check
npm run test           # vitest run (root tests/**/*.ts only)
npx vitest run tests/domain/taxonomy.test.ts  # single test file
npm run dev            # run CLI: tsx src/cli/index.ts
npm run dev -- doctor  # check config and taxonomy
npm run dev -- db:migrate  # apply pending SQLite migrations
npm run dev -- discover --input dois.json      # attribution-first discovery: harvest citing mentions, extract attributed claims, ground to seed, emit shortlist (needs ANTHROPIC_API_KEY)
npm run dev -- discover --input dois.json --strategy legacy  # legacy seed-side claim extraction with optional ranking
npm run dev -- pipeline --input dois.json     # full e2e: discover → screen → … → adjudicate (tracked in DB, visible in UI)
npm run dev -- pipeline --shortlist shortlist.json  # e2e from existing shortlist (skip discover)
npm run dev -- screen --input shortlist.json  # pre-screen (needs ANTHROPIC_API_KEY; writes *_pre-screen-grounding-trace.json)
npm run ui:dev         # local Next.js UI (orchestration + inspection)
npm run ui:build
npm run ui:start
npm --workspace @palimpsest/ui run test   # UI workspace tests
```

## Architecture

```
apps/ui/      Local-only Next.js (App Router pages + Pages API); depends on root via workspace
src/
  cli/          Command entrypoints (index.ts dispatches to commands/)
  config/       Env loading (Zod-validated) and AppConfig construction
  domain/       Core taxonomy types and decision logic (pure)
  health/       Health checks shared by CLI (doctor) and UI
  integrations/ External provider adapters (bioRxiv, OpenAlex, Semantic Scholar); centralized LLM client (llm-client.ts)
  pipeline/     Claim discovery, pre-screen, and full-analysis orchestration
  retrieval/    Chunking, BM25 ranking, LLM reranking, cited-span selection
  reporting/    JSON and Markdown artifact generation
  storage/      SQLite schema, migrations (sequential .sql files), repositories
  shared/       Cross-cutting primitives
  contract/  Shared stage/run types; package exports: palimpsest/contract (+ /server)
tests/          Mirrors src/ structure
```

### Key Patterns

- **Boundary validation**: All external data (API responses, env vars, LLM outputs, XML) is Zod-validated before entering the domain layer. Types are inferred from Zod schemas (`z.infer<typeof schema>`).
- **Domain taxonomy**: Core enums (CitationFunction, AuditabilityStatus, FidelityTopLabel, DistortionSubtype, ErrorSubtype, EvidenceVsInterpretation, ConfidenceLevel) live in `src/domain/taxonomy.ts`. Each has a `values` const array, a Zod schema, and an inferred type.
- **Typed error handling**: Expected failures (unresolved citation, no open-access text, invalid LLM JSON) use `Result<T>` return values (`{ ok: true; data: T } | { ok: false; error: string }`), not thrown exceptions. Throw only for programmer errors.
- **Centralized LLM client**: All Anthropic API calls (claim-discovery, seed-grounding, claim-family-filter, evidence-reranking, adjudication, family-consolidation) go through `src/integrations/llm-client.ts`. Every call is tagged with a `purpose` and returns `LLMCallRecord` telemetry; `getLedger()` aggregates per-run cost by purpose. Call sites can opt into persistent exact-result caching via `exactCache: { keyVersion }` — identical requests return cached responses without hitting the provider.
- **In-memory discovery handoff** (`attribution_first` only): `runDiscoveryStage` produces a `DiscoveryHandoffMap` (`src/domain/discovery-handoff.ts`) that carries resolved papers, citing-paper lists, pre-harvested mentions, and per-family grounding traces from discover → screen → extract within a single pipeline run — eliminating redundant resolution, OpenAlex fetches, LLM grounding, and full-text fetches. Not serialized; never reconstructed on `--run-id` resume (stages fall back to full paths). Key entry points: `runPreScreenFromHandoff` (`pre-screen.ts`), `extractEdgeContextFromMentions` (`citation-context.ts`).
- **Adjudication advisor mode** (enabled by default): Two-pass strategy — Sonnet+thinking first pass on all records, Opus+thinking only on `judgeConfidence === "low"` or `cannot_determine` escalations. Bundled citations also escalate on `medium` confidence (multi-reference contexts are harder to adjudicate). Saves ~50-70% of adjudication cost on well-grounded families. Disable with `adjudicateAdvisor: false` or `--no-advisor` on CLI.
- **Deferred evidence reranking**: Evidence retrieval runs BM25 (free) for all evaluation tasks, curate samples the audit set, then LLM reranking runs only on the curated records before adjudication. This avoids paying for LLM reranking on the ~80% of tasks that are never adjudicated. Saves ~80% of evidence reranking cost on well-cited papers.
- **Citation scope annotation**: The adjudicator prompt wraps sentences attributed to the seed paper with `▶ ... ◀` markers, preserving the full paragraph context while disambiguating which claims to evaluate. The `seedRefLabel` (e.g. "Mets and Meyer, 2009") is populated at mention-harvest time from the matched bibliography entry's `authorSurnames` + `year`, propagated through the pipeline, and used for both window centering and sentence annotation. This eliminates false not-supported verdicts from multi-reference paragraphs where different sentences cite different papers.
- **Family consolidation**: After attribution-first discovery shortlists N families, a single Opus `generateText` call with extended thinking clusters semantically equivalent tracked claims and picks the most specific representative from each cluster. Domain-agnostic prompt (no field-specific examples). Full provenance of every merge decision logged and available in the consolidation artifact. Runs automatically when there are >1 seeds; cost tracked under `"family-consolidation"` purpose in `byPurpose` and under the `"discover"` stage in `byStage`. Typical reduction: 10 near-duplicate families → 2-3 distinct families with ~70% cost savings on downstream stages.
- **Local seed PDF**: `--seed-pdf <path>` on `pipeline` bypasses open-access lookup for the cited (seed) paper, reads the local PDF, and sends it to GROBID. The UI new-run form has an optional PDF upload field. The path is persisted in `seedPdfPath` in the run config so `--run-id` resume works.
- **Institutional proxy** (`INSTITUTIONAL_PROXY_URL`): When set (e.g. `https://libproxy.mit.edu/login?url=`), the full-text acquisition layer tries open-access candidates first; if all fail, it retries landing-page and PDF URLs through the proxy as fallback. Successful proxy acquisitions are tagged `accessChannel: "institutional_proxy"` in the acquisition metadata. Configured via `.env` / `.env.local`.
- **Dependency injection**: Pipeline orchestration accepts adapter interfaces so integration tests can use mocked adapters without network calls.
- **Migrations**: Sequential `.sql` files in `src/storage/migrations/` named `NNNN_description.sql`. Applied via `schema_migrations` table. Never modify existing migration files.
- **ESM modules**: The project uses `"type": "module"` with NodeNext resolution. All local imports must use `.js` extensions.
- **Type imports**: ESLint enforces `import type` for type-only imports (`@typescript-eslint/consistent-type-imports`).
- **UI inspector contract**: Stage detail UIs should consume the typed payloads from `src/contract/inspector-payloads.ts` via `buildStageInspectorPayload()`, not raw artifacts or `unknown` casts. When stage artifact shapes change, update the payload builder and keep the contract tests passing.

### Domain Model

Fidelity labels are `F` (faithful), `D` (distortion), `E` (error), `U` (uncertain). Auditability gates (`auditable`, `partially_auditable`, `not_auditable`) must pass before fidelity scoring. The current implementation focuses on `empirical_attribution` but the taxonomy is designed to extend to other citation functions.

## TypeScript Strictness

The tsconfig enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and all strict flags. `no-explicit-any` is enforced in src/ but relaxed in tests/.
