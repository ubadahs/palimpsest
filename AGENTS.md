# AGENTS.md

Keep this file in sync with [CLAUDE.md](./CLAUDE.md).

This file provides guidance to coding agents (e.g. Codex) when working with code in this repository.

## What This Project Is

CLI-first tooling for auditing citation fidelity in scientific literature. It analyzes whether citing papers faithfully represent the claims of cited papers — domain-agnostic and not limited to any single citation function. Local SQLite storage. **CLI and JSON/Markdown artifacts are canonical; there is no hosted multi-user product. A local-only Next.js app in `apps/ui` may orchestrate CLI subprocesses and inspect artifacts.**

**What is actually built today** is summarized in `docs/status.md` (CLI-aligned; update when phases land). Authoritative workflow docs are `docs/pipeline.md`, `docs/status.md`, and `docs/adjudication-rubric.md`. Historical shortlist/pre-screen conception docs live under `docs/archive/pre-canonical/` and are not build authority. Do not reintroduce legacy stages or compatibility bridges.

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
npm run dev -- db:gc [--days 90] [--dry-run]  # delete aged analysis-run + LLM-cache DB rows and expired batch request rows (not artifact dirs)
npm run dev -- runs:gc [--run-id <uuid>] [--dry-run]  # delete superseded run artifacts + unreferenced provenance
npm run dev -- pipeline --input dois.json     # DOI-first canonical e2e: discover → scope → prepare → evidence → adjudicate → report
npm run dev -- pipeline --input dois.json --seed-pdf paper.pdf  # e2e with local PDF for the seed paper (bypasses OA lookup)
npm run dev -- pipeline --input dois.json --stop-after evidence  # stop after a canonical stage
npm run dev -- pipeline --run-id <uuid>       # resume a canonical run
npm run dev -- pipeline --input dois.json --max-cost 4  # stop sending model requests once estimated spend reaches $4
npm run dev -- pipeline --input dois.json --batch  # send model requests through the Message Batches API at half price
npm run dev -- eval dataset --report <path> --name <name> [--mutations <path>]  # freeze cases from a report under data/evaluations; --mutations adds constructed cases
npm run dev -- eval validate --dataset <id>    # offline integrity and coverage check
npm run dev -- eval request --dataset <id> --title <title> --purpose <why> --cases <ids.json>  # save a set of cases for a reviewer to grade in the UI
npm run dev -- eval plan --dataset <id> --config <path>  # offline plan for an optimization config
npm run dev -- eval status --experiment <id>  # saved optimization progress, no provider calls
npm run dev -- eval run --dataset <id> --config <path>  # launch a provider comparison
npm run dev -- eval run --experiment <id>      # resume pending trials
npm run dev -- eval report --experiment <id>   # score saved trials against the annotation snapshot
npm run ui:dev         # local Next.js UI (orchestration + inspection)
npm run ui:build
npm run ui:start
npm --workspace @palimpsest/ui run test   # UI workspace tests (Vitest + happy-dom)
npx knip --reporter compact               # dead-code / deps check (knip is not a dependency; npx fetches it)
```

## Architecture

```
apps/ui/      Local-only Next.js (App Router pages + Pages API); depends on root via workspace
src/
  adjudication/ Canonical adjudicate packet builders; whole-seed-text adjudication prompt, quote verification, and seed text rebuilt from the Evidence corpus
  classification/ Deterministic citation-function and evaluation-mode helpers
  cli/          Command entrypoints (index.ts dispatches to commands/)
  config/       Env loading (Zod-validated) and AppConfig construction
  domain/       Core taxonomy types and decision logic (pure)
  health/       Health checks shared by CLI (doctor) and UI
  integrations/ External provider adapters (bioRxiv, OpenAlex, Semantic Scholar); centralized LLM client (llm-client.ts)
  pipeline/     Canonical six-stage orchestration and production adapters
  retrieval/    Full-text acquisition, parsing, BM25, canonical evidence retrieval
  reporting/    Canonical Report Markdown rendering
  review/       Append-only report-bound human review store (package export: palimpsest/review)
  evaluation/   Frozen-report comparisons and blind annotation (package exports: palimpsest/evaluation, palimpsest/evaluation/server)
  storage/      SQLite schema, migrations (sequential .sql files), repositories
  shared/       Cross-cutting primitives
  contract/     Shared stage/run types; artifacts/ holds per-stage artifact schemas and lineage checks; package exports: palimpsest/contract (+ /server)
tests/          Mirrors src/ structure
```

### Key Patterns

- **Boundary validation**: All external data (API responses, env vars, LLM outputs, XML) is Zod-validated before entering the domain layer. Types are inferred from Zod schemas (`z.infer<typeof schema>`). Each stage builds its boundary parser from `createBoundaryParser` in `src/shared/boundary.ts`; deterministic ordering and deduplication come from `src/shared/order.ts`.
- **Artifact integrity, once**: `src/contract/lean-artifacts.ts` is a barrel over `src/contract/artifacts/{envelope,discover,scope,prepare,evidence,checks,seed-section-role}.ts`. Two checks apply to every artifact: its identity hash over payload + decisions, and that it names the exact inputs it was built from in canonical order (`validateStageInputLineage`). Per-stage lineage validators that re-derived what a builder had just written are gone; each stage keeps only its payload's internal-consistency ledger.
- **Lean migration replacement rule**: Delete superseded stage/artifact aliases, compatibility readers, and old-run fallbacks; old runs need not remain readable. Preserve scientific raw inputs, provenance, and git history.
- **Canonical production pipeline**: The public CLI, run registry, UI, and artifact layout execute only `discover → scope → prepare → evidence → adjudicate → report`. Fresh runs are DOI-first (`pipeline --input <dois.json>`); there is no manual shortlist or tracked-claim bridge. Public stage vocabulary is exactly these six keys.
- **Canonical Discover and Scope**: Discover enumerates the whole citing neighborhood (metadata only; OpenAlex `page=` paging sorted by publication date, `neighborhoodLimit` default 10,000 is a safety cap and coverage says `truncated` past it), samples the probe set from the frame of works not marked closed or abstract-only (`isInSamplingFrame`), stratified by year band × type group (article/review/other), with `allocateProbes` giving each probe to the stratum whose probed works stand for the most frame works, and records each stratum's inclusion probability π = probed frame works / frame works, harvests probed papers `discover.fetchConcurrency` at a time (non-scientific, excluded from the resume conflict check; output keeps neighborhood order), emits one seed occurrence per exact citation group, clusters paraphrased claims across citers into one candidate per seed finding (model equivalence with an exact-text fallback), annotates candidates, and selects an adaptive 15–25 family portfolio under a prepared-record budget without grounding. Scope consumes its verified envelope, accounts for every candidate, freezes exact family/occurrence membership, materializes seed text once per seed, and records verified grounding as a non-excluding annotation. No shortlist, handoff, or legacy stage artifact is read.
- **Canonical Prepare and Evidence**: Prepare emits one complete stable record per scoped family × citation occurrence, preserving complete and occurrence-local claim membership with typed classification. Family-level data (Scope families, seeds, candidates, claims, citing papers) is stored once on the payload; records keep only their occurrence, the ids of their occurrence-local candidates and claims, and their classification. Consumers join with `resolvePreparedRecords`. Role classification is two-pass: a free deterministic regex pass, then `prepare.roleClassifierModel` for its `unclear` verdicts only. Records without a verified support span never reach the model and stay `manual_review_extraction_limited`. Evidence emits one outcome per Prepare record over immutable Scope seed text; BM25 queries occurrence-local claims with the Scope family claim as fallback (fused by reciprocal rank), and relevance reranking (on by default) is an immutable separate version that sees each chunk's section role and whether the seed block cites other work. Grounding pins apply in both branches. When verified pins fill the selected packet, Evidence skips the reranker with a typed status and Report counts the skip. There is no sampling or `curate` stage.
- **Canonical Adjudicate (uncalibrated)**: Adjudicate emits one categorical `F`/`D`/`E`/`U` result or typed operational non-verdict per Evidence record, using deterministic gates and one model request per eligible record. By default (`adjudicate.evidence: "seed_text"`) the model reads the whole seed text, rebuilt from the Evidence corpus so the stage needs no extra input: the seed text is a prompt prefix cached across a seed's records, the first request per seed writes the cache alone, and the verdict rests on quotes exact-verified against the seed blocks (`seedQuotes`; `modelCitedChunkIds` are the corpus chunks holding them, selected by Evidence or not). An unverifiable quote is dropped and counted, an `F`/`D`/`U` left with none is `invalid_output`, and an `E` may quote nothing. `selected_chunks`, or a seed text over `SEED_TEXT_MAX_CHARACTERS`, reads only Evidence's selected chunks. Gates are identical in both modes. Ambiguous/manual-review roles stay gated and are not auto-broadened to the model. Confidence never routes a different model or path; advisor/vector modes are not product behavior. It is runnable but **uncalibrated**: blinded human calibration is required before trust claims.
- **Local evaluation**: `eval` freezes a finished report into cases under gitignored `data/evaluations/`. It is not a seventh pipeline stage and does not rewrite canonical artifacts. Cases are rebuilt with the current code over the run's frozen inputs: records today's packet gate would hold back are left out, and seed section roles are inferred again. A dataset also stores each seed's full text, so an Anthropic provider with `adjudicationEvidence: "seed_text"` can adjudicate from the whole paper (cached prefix, exact-verified quotes) instead of the selected chunks. `--mutations` adds constructed cases, edits of restatements a human labelled `F` whose expected verdict is known: distortions (expected `D`/`E`) measure missed distortions, and wording-only controls (expected `F`) measure false alarms. They are scored apart from human labels, and chunk and whole-paper providers are compared only on cases whose evidence grounding pins fix.
- **Canonical Report**: Report tamper-verifies the full preceding chain and deterministically writes authoritative JSON funnel/rate/trace accounting plus Markdown rendered only from that JSON. Funnel accounting includes unique citation-group coverage, the provider-reported neighborhood total and its coverage (so the sampling denominator is stated), probe strata with inclusion probabilities, full-text access channel, materialization and harvest loss reasons, bibliography match method, adaptive portfolio deferrals, and manual-review queue splits. `selectionAudit` carries each candidate's portfolio component scores and each record trace carries its citation-role signals. F/D/E/U rates use the adjudicated-record denominator; operational non-verdicts are excluded. `weightedRates` add F/D/E/U rates with each adjudicated record from a frame work weighted 1/π of its stratum, estimating rates over the sampling frame (records from works outside it are left out); the unweighted rates stay as the observed sample counts.
- **Clean break for old runs**: Migration `0011_purge_pre_canonical_runs.sql` plus startup config validation delete unsupported analysis-run registry rows. Migration `0012_drop_orphan_papers_citations.sql` drops unused `papers`/`citations` tables, and `0013_drop_write_only_columns.sql` drops `derived_artifacts` plus every column that was written and never read back (`analysis_runs.tracked_claim`, `analysis_run_stages.input_artifact_path`/`exit_code`, the `paper_cache` metadata columns, `paper_parsed.sections_json`, and `llm_result_cache.purpose`/`model`/`key_version`). `analysis_run_stages.family_index` stays because it is part of an immutable primary key. Paper/LLM caches and on-disk `data/runs/` files are preserved; old runs are not resumed or bridged. `db:gc` deletes aged analysis-run and LLM-cache SQLite rows, plus `llm_batch_requests` rows past the 29-day batch results retention (not artifact directories); `runs:gc` deletes superseded stage attempts a `--rerun-from` left on disk plus the provenance blobs only those attempts referenced.
- **Canonical run-config defaults**: `CANONICAL_RUN_CONFIG_DEFAULTS` in `src/contract/run-types.ts` is the single source for nested discover/scope/prepare/evidence/adjudicate defaults (schema, CLI empty parse, UI form).
- **Domain taxonomy**: Core enums (CitationFunction, AuditabilityStatus, FidelityTopLabel) live in `src/domain/taxonomy.ts`. Each has a `values` const array, a Zod schema, and an inferred type.
- **Typed error handling**: Expected failures (unresolved citation, no open-access text, invalid LLM JSON) use `Result<T>` return values (`{ ok: true; data: T } | { ok: false; error: string }`), not thrown exceptions. Throw only for programmer errors.
- **Centralized LLM client**: Canonical Anthropic calls (attributed-claim extraction, claim canonicalization, citation-role classification, seed grounding, evidence reranking, adjudication) go through `src/integrations/llm-client.ts` and all use `generateObject` with provider-enforced structured output against the adapter's response schema. Every call is tagged with a `purpose` and returns `LLMCallRecord` telemetry; `getLedger()` aggregates per-run cost by purpose. The executor's `createRunCostTracker` rewrites `cost-summary.json` after every call (earlier attempts read once as a baseline) and backs `--max-cost`, which the client checks before each request; a `spend_limit` error aborts the stage rather than gating records. `--batch` (not run config, like `--max-cost`) swaps the provider's `fetch` for `src/integrations/batch-transport.ts`: stages get unbounded concurrency, quiet queues of five or more requests go out as one Message Batch (smaller ones direct), and each caller gets a synthetic `Response` from its batch result, so validation, retries, and classification are unchanged. Batched records carry `transport: "batch"` and half-price `estimatedCostUsd`; under `--max-cost` each queued request reserves an expected cost (cache-read prefix, 2,000-token output floor or twice the observed mean), so the limit is approximate. Batched shared prefixes use the 1-hour cache TTL. Submitted `custom_id`s (hash of body and headers) live in `llm_batch_requests` so a resume takes a pending batch's result instead of paying twice. Call sites can opt into persistent exact-result caching via `exactCache: { keyVersion }` — identical requests return cached responses without hitting the provider. Run-config defaults name the current models (`claude-haiku-5-5`; `claude-sonnet-5-5`, which also adjudicates). Provider prompt caching applies only to a request that names a shared prefix (seed grounding, whole-seed-text adjudication). Sonnet/Opus 4.6+ and every model from 5 on use adaptive thinking with explicit effort; older models keep fixed-budget thinking when enabled. Models from 5 on think by default and some cannot be told to stop, so a call site with thinking off sends them the lowest effort instead of nothing (`resolveThinkingConfig`).
- **Citation scope annotation**: The adjudicator prompt wraps sentences attributed to the seed paper with `▶ ... ◀` markers, using exact-verified support-span offsets and the resolved reference identity before windowing. Sentence splitting protects abbreviations such as `et al.`. Unverified targets and markers that lack claim-bearing text gate to `manual_review_extraction_limited`. The `seedRefLabel` (e.g. "Adeyemi and Okonkwo, 2009") is populated at mention-harvest time from the matched bibliography entry's `authorSurnames` + `year` and propagated through the pipeline.
- **Verified claim support spans**: Discover exact-verifies extraction `supportSpanText` against occurrence `rawContext` and persists offset-bound `supportSpan` objects. Prepare/Adjudicate fail closed when occurrence-local claims lack a verified span (`manual_review_extraction_limited`). Deterministic role classification prefers verified span text over marker-local verb windows.
- **Local seed PDF**: `--seed-pdf <path>` on a single-DOI `pipeline` run bypasses open-access lookup for that seed paper, reads the local PDF, and sends it to GROBID. The UI new-run form has an optional PDF upload field. The path is persisted only as `scope.seedPdfPath`; multi-DOI runs reject a single shared PDF.
- **Institutional proxy** (`INSTITUTIONAL_PROXY_URL`): When set (e.g. `https://libproxy.mit.edu/login?url=`), the full-text acquisition layer tries open-access candidates first; if all fail, it retries landing-page and PDF URLs through the proxy as fallback. Successful proxy acquisitions are tagged `accessChannel: "institutional_proxy"` in the acquisition metadata. Configured via `.env` / `.env.local`.
- **Dependency injection**: Pipeline orchestration accepts adapter interfaces so integration tests can use mocked adapters without network calls.
- **Migrations**: Sequential `.sql` files in `src/storage/migrations/` named `NNNN_description.sql`. Applied via `schema_migrations` table. Never modify existing migration files.
- **ESM modules**: The project uses `"type": "module"` with NodeNext resolution. All local imports must use `.js` extensions.
- **Type imports**: ESLint enforces `import type` for type-only imports (`@typescript-eslint/consistent-type-imports`).
- **UI inspector contract**: Stage detail UIs should consume the typed payloads from `src/contract/inspector-payloads.ts` via `buildStageInspectorPayload()` in `src/contract/selectors.ts`, not raw artifacts or `unknown` casts. When stage artifact shapes change, update the payload builder and keep the contract tests passing. Report Families read the canonical `familyMutations` section of the Report artifact (`buildReportInspectorFamilies` joins inspector rows onto it; it is not a second producer); human review is an append-only sidecar under `palimpsest/review` / `data/runs/<runId>/review/<reportArtifactId>/`, never a seventh stage and never a rewrite of canonical machine artifacts. The review workspace opens blinded, the reviewer records their own `F`/`D`/`E`/`U`/`not_adjudicable` label plus mutation kinds, and agreement is derived at export time; the CSV export collapses records to `family × citing-paper × claim` units via `buildClaimUnitKey`, the same rule the Report counts with.

### Domain Model

Fidelity labels are `F` (faithful), `D` (distortion), `E` (error), `U` (uncertain). Auditability taxonomy values remain in `src/domain/taxonomy.ts` for doctor/reporting vocabulary. The current implementation focuses on `empirical_attribution` but the taxonomy is designed to extend to other citation functions.

## TypeScript Strictness

The tsconfig enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and all strict flags. `no-explicit-any` is enforced in src/ but relaxed in tests/.
