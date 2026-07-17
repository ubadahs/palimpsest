# AGENTS.md

Keep this file in sync with [CLAUDE.md](./CLAUDE.md).

This file provides guidance to coding agents (e.g. Codex) when working with code in this repository.

## What This Project Is

CLI-first tooling for auditing citation fidelity in scientific literature. It analyzes whether citing papers faithfully represent the claims of cited papers — domain-agnostic and not limited to any single citation function. Local SQLite storage. **CLI and JSON/Markdown artifacts are canonical; there is no hosted multi-user product. A local-only Next.js app in `apps/ui` may orchestrate CLI subprocesses and inspect artifacts.**

The project follows a milestone-based implementation plan in [`docs/conception/implementation-plan.md`](docs/conception/implementation-plan.md). **What is actually built today** is summarized in `docs/status.md` (CLI-aligned; update when phases land). The canonical PRD/build spec live under `docs/conception/`; companion docs (`evaluation-protocol`, `concept memo`, etc.) sit alongside them in `docs/`. Do not build infrastructure for later milestones early.

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
npm run dev -- pipeline --input dois.json     # DOI-first canonical e2e: discover → scope → prepare → evidence → adjudicate → report
npm run dev -- pipeline --input dois.json --seed-pdf paper.pdf  # e2e with local PDF for the seed paper (bypasses OA lookup)
npm run dev -- pipeline --input dois.json --stop-after evidence  # stop after a canonical stage
npm run dev -- pipeline --run-id <uuid>       # resume a canonical run
npm run ui:dev         # local Next.js UI (orchestration + inspection)
npm run ui:build
npm run ui:start
npm --workspace @palimpsest/ui run test   # UI workspace tests (Vitest + happy-dom)
npx knip --reporter compact               # optional dead-code / deps (see repo knip.json)
```

## Architecture

```
apps/ui/      Local-only Next.js (App Router pages + Pages API); depends on root via workspace
src/
  adjudication/ Fidelity scoring, calibration, and LLM adjudicator
  benchmark/    Blind benchmark harness (types + workflow)
  classification/ Citation-function and evaluation-mode classification into eval packets
  cli/          Command entrypoints (index.ts dispatches to commands/)
  config/       Env loading (Zod-validated) and AppConfig construction
  domain/       Core taxonomy types and decision logic (pure)
  health/       Health checks shared by CLI (doctor) and UI
  integrations/ External provider adapters (bioRxiv, OpenAlex, Semantic Scholar); centralized LLM client (llm-client.ts)
  pipeline/     Canonical six-stage orchestration and production adapters
  retrieval/    Chunking, BM25 ranking, LLM reranking, cited-span selection
  reporting/    JSON and Markdown artifact generation
  storage/      SQLite schema, migrations (sequential .sql files), repositories
  shared/       Cross-cutting primitives
  contract/  Shared stage/run types; package exports: palimpsest/contract (+ /server)
tests/          Mirrors src/ structure
```

### Key Patterns

- **Boundary validation**: All external data (API responses, env vars, LLM outputs, XML) is Zod-validated before entering the domain layer. Types are inferred from Zod schemas (`z.infer<typeof schema>`).
- **Lean migration replacement rule**: Delete superseded stage/artifact aliases, compatibility readers, and old-run fallbacks; old runs need not remain readable. Preserve scientific raw inputs, provenance, and git history.
- **Canonical production pipeline**: The public CLI, run registry, UI, and artifact layout execute only `discover → scope → prepare → evidence → adjudicate → report`. Fresh runs are DOI-first (`pipeline --input <dois.json>`); there is no manual shortlist or tracked-claim bridge. Public stage vocabulary is exactly these six keys.
- **Canonical Discover and Scope**: Discover writes a lossless citation-neighborhood and attributed-claim ledger without grounding. Scope consumes its verified envelope, accounts for every candidate, freezes exact family/occurrence membership, materializes seed text once per seed, and records verified grounding as a non-excluding annotation. No shortlist, handoff, or legacy stage artifact is read.
- **Canonical Prepare and Evidence**: Prepare emits one complete stable record per scoped family × citation occurrence, preserving complete and occurrence-local claim membership with typed classification. Evidence emits one outcome per Prepare record over immutable Scope seed text; BM25 uses only the Scope family claim, and optional relevance reranking is an immutable separate version. There is no sampling or `curate` stage.
- **Canonical Adjudicate (uncalibrated)**: Adjudicate emits one categorical `F`/`D`/`E`/`U` result or typed operational non-verdict per Evidence record, using deterministic gates and one model request per eligible record. Confidence never routes a different model or path; advisor/vector modes are not product behavior. It is runnable but **uncalibrated**: blinded human calibration is required before trust claims.
- **Canonical Report**: Report tamper-verifies the full preceding chain and deterministically writes authoritative JSON funnel/rate/trace accounting plus Markdown rendered only from that JSON. F/D/E/U rates use the adjudicated-record denominator; operational non-verdicts are excluded.
- **Clean break for old runs**: Migration `0011_purge_pre_canonical_runs.sql` plus startup config validation delete unsupported analysis-run registry rows. Paper/LLM caches and on-disk `data/runs/` files are preserved; old runs are not resumed or bridged.
- **Domain taxonomy**: Core enums (CitationFunction, AuditabilityStatus, FidelityTopLabel) live in `src/domain/taxonomy.ts`. Each has a `values` const array, a Zod schema, and an inferred type.
- **Typed error handling**: Expected failures (unresolved citation, no open-access text, invalid LLM JSON) use `Result<T>` return values (`{ ok: true; data: T } | { ok: false; error: string }`), not thrown exceptions. Throw only for programmer errors.
- **Centralized LLM client**: Canonical Anthropic calls (attributed-claim extraction, seed grounding, evidence reranking, adjudication) go through `src/integrations/llm-client.ts`. Every call is tagged with a `purpose` and returns `LLMCallRecord` telemetry; `getLedger()` aggregates per-run cost by purpose. Call sites can opt into persistent exact-result caching via `exactCache: { keyVersion }` — identical requests return cached responses without hitting the provider. Sonnet/Opus 4.6+ use adaptive thinking with explicit effort; older models keep fixed-budget thinking when enabled.
- **Citation scope annotation**: The adjudicator prompt wraps sentences attributed to the seed paper with `▶ ... ◀` markers, preserving the full paragraph context while disambiguating which claims to evaluate. The `seedRefLabel` (e.g. "Mets and Meyer, 2009") is populated at mention-harvest time from the matched bibliography entry's `authorSurnames` + `year`, propagated through the pipeline, and used for both window centering and sentence annotation. This eliminates false not-supported verdicts from multi-reference paragraphs where different sentences cite different papers.
- **Local seed PDF**: `--seed-pdf <path>` on a single-DOI `pipeline` run bypasses open-access lookup for that seed paper, reads the local PDF, and sends it to GROBID. The UI new-run form has an optional PDF upload field. The path is persisted only as `scope.seedPdfPath`; multi-DOI runs reject a single shared PDF.
- **Institutional proxy** (`INSTITUTIONAL_PROXY_URL`): When set (e.g. `https://libproxy.mit.edu/login?url=`), the full-text acquisition layer tries open-access candidates first; if all fail, it retries landing-page and PDF URLs through the proxy as fallback. Successful proxy acquisitions are tagged `accessChannel: "institutional_proxy"` in the acquisition metadata. Configured via `.env` / `.env.local`.
- **Dependency injection**: Pipeline orchestration accepts adapter interfaces so integration tests can use mocked adapters without network calls.
- **Migrations**: Sequential `.sql` files in `src/storage/migrations/` named `NNNN_description.sql`. Applied via `schema_migrations` table. Never modify existing migration files.
- **ESM modules**: The project uses `"type": "module"` with NodeNext resolution. All local imports must use `.js` extensions.
- **Type imports**: ESLint enforces `import type` for type-only imports (`@typescript-eslint/consistent-type-imports`).
- **UI inspector contract**: Stage detail UIs should consume the typed payloads from `src/contract/inspector-payloads.ts` via `buildStageInspectorPayload()`, not raw artifacts or `unknown` casts. When stage artifact shapes change, update the payload builder and keep the contract tests passing.

### Domain Model

Fidelity labels are `F` (faithful), `D` (distortion), `E` (error), `U` (uncertain). Auditability gates (`auditable_structured`, `auditable_pdf`, `partially_auditable`, `not_auditable`) must pass before fidelity scoring. The current implementation focuses on `empirical_attribution` but the taxonomy is designed to extend to other citation functions.

## TypeScript Strictness

The tsconfig enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and all strict flags. `no-explicit-any` is enforced in src/ but relaxed in tests/.
