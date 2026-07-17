# CLAUDE.md

Keep this file in sync with [AGENTS.md](./AGENTS.md).

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
npm run dev -- discover --input dois.json      # attribution-first discovery: harvest citing mentions, extract attributed claims, ground to seed, emit shortlist (needs ANTHROPIC_API_KEY)
npm run dev -- discover --input dois.json --strategy legacy  # legacy seed-side claim extraction with optional ranking
npm run dev -- pipeline --input dois.json     # full e2e: discover → screen → … → adjudicate (tracked in DB, visible in UI)
npm run dev -- pipeline --input dois.json --seed-pdf paper.pdf  # e2e with local PDF for the seed paper (bypasses OA lookup)
npm run dev -- pipeline --shortlist shortlist.json  # e2e from existing shortlist (skip discover)
npm run dev -- screen --input shortlist.json  # pre-screen (needs ANTHROPIC_API_KEY; writes *_pre-screen-grounding-trace.json)
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
  adjudication/ Fidelity-vector scoring/calibration, LLM adjudicator, vector-first routing
  benchmark/    Blind benchmark harness (types + workflow)
  classification/ Citation-function and evaluation-mode classification into eval packets
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
- **Lean migration replacement rule**: Delete superseded stage/artifact aliases, compatibility readers, and old-run fallbacks; old runs need not remain readable. Preserve scientific raw inputs, provenance, and git history.
- **Canonical Discover (isolated, not executor-wired)**: `runCanonicalDiscover` (`src/pipeline/canonical-discover.ts`) writes a lossless ledger of the declared citing-neighborhood boundary, every citing-paper disposition, every citation occurrence, per-occurrence extraction outcomes/claims, non-destructive seed-isolated candidates, and cap dispositions. Grounding is forbidden here and belongs to Scope. `canonical-discover-artifact.ts` reads/writes only the current lean Discover envelope; do not bridge it to shortlist, handoff, or current-executor artifact shapes.
- **Canonical Scope (isolated, not executor-wired)**: `runCanonicalScope` (`src/pipeline/canonical-scope.ts`) consumes only a current verified Discover envelope, accounts for every candidate disposition, freezes selected candidate source-claim and citation-occurrence membership exactly, materializes seed text once per seed, and records grounding as a non-excluding annotation. Scientific `not_found` has no accepted evidence and is distinct from seed-text failure, typed provider `grounding_failed`, and malformed/quote-invalid `invalid_grounding_output`; model quotes are accepted only after exact block verification. `canonical-scope-artifact.ts` reads/writes only the current lean Scope envelope; do not bridge it to shortlist, handoff, pre-screen, screen, or current-executor artifacts.
- **Canonical Prepare (isolated, not executor-wired)**: `runCanonicalPrepare` (`src/pipeline/canonical-prepare.ts`) consumes a current verified Scope envelope plus its exact verified Discover ancestor and emits one complete record per scoped family × citation occurrence. Record identity is only the versioned `familyId + citationOccurrenceId`; classification, parser/model details, timestamps, and context formatting cannot change it. Prepare preserves both the complete family source ledger and exact occurrence-local candidate/claim subsets, plus the Scope family/grounding, Discover seed/citing-paper/occurrence, bundle metadata, source context, lineage, and typed classification outcome without sampling or dropping failures. `canonical-prepare-artifact.ts` reads/writes only the current lean Prepare envelope; do not bridge it to extract, classify, curate, or current-executor artifacts.
- **Canonical Evidence (isolated, not executor-wired)**: `runCanonicalEvidence` (`src/pipeline/canonical-evidence.ts`) consumes only a current verified Prepare envelope plus its exact verified Scope ancestor and retrieves over the immutable Scope seed-text blocks. It emits one outcome per Prepare record while safely reusing family-level query/corpus/ranking runs. Deterministic fixed-window chunks preserve exact text and source offsets; BM25 uses only the declared Scope family claim, never citing context, occurrence-local wording, classification, or Scope support spans. Optional relevance-only reranking is a separate immutable ranking with strict candidate IDs and full model provenance; disabled reranking is deterministic, nonfatal rerank failure remains explicit with unchanged BM25 fallback, and fatal provider failures stop the stage. `canonical-evidence-artifact.ts` reads/writes only the current lean Evidence envelope; do not bridge it to current-executor evidence/curate artifacts.
- **Canonical Adjudicate (isolated, not executor-wired, uncalibrated)**: `runCanonicalAdjudicate` (`src/pipeline/canonical-adjudicate.ts`) consumes only a current verified Evidence envelope plus its exact verified Prepare ancestor. It verifies run IDs and exact Prepare artifact ID/content hash before any model adapter executes, then emits exactly one outcome per Evidence record with no sampling or collapse. Deterministic gates block model calls for missing/unavailable seed text, acquisition/retrieval failure, `no_lexical_matches`, classification failure, invalid context, skip/low-information roles, and ambiguous/manual-review roles — these are `not_adjudicated` operational outcomes, never `U` or F/D/E. A fully gated run needs no model adapter and produces deterministic/replayable output with no model provenance; the adapter becomes mandatory only when an eligible record is reached. Evidence selection/chunk invariant violations are impossible after validation and throw boundary errors if internal map state is corrupted. Scope scientific `not_found` and operational `grounding_failed` are not gates when exact selected evidence exists and are absent from the model packet. One categorical uncalibrated method only (`canonical-categorical-adjudicate-v1`): one model request per eligible record; confidence is recorded but never routes another model or path; no advisor/vector/escalation. Adapter execution must match the exact prompt metadata/content and canonical hash of the complete request before it is accepted. Every modeled outcome evaluates the complete occurrence-local Prepare claim set; claim IDs and model-cited chunk IDs are canonicalized into Prepare/Evidence order. Validated model outputs use PRD `F`/`D`/`E`/`U`; nonfatal failure/malformed output are typed `adjudication_failed`/`invalid_output`; fatal auth/billing/quota failures stop the stage. Artifact validation binds every modeled outcome to exact prompt/model/request/response provenance and keeps fully gated artifacts free of model provenance. Contracts live in `src/contract/canonical-adjudicate.ts` (re-exported from lean-artifacts); shared envelope primitives live once in `src/contract/lean-artifact-primitives.ts`. `canonical-adjudicate-artifact.ts` reads/writes only the current lean Adjudicate envelope; do not bridge it to audit-sample/current-executor adjudicate artifacts. Blinded human calibration is still required before advisor/vector routing or trust claims.
- **Domain taxonomy**: Core enums (CitationFunction, AuditabilityStatus, FidelityTopLabel) live in `src/domain/taxonomy.ts`. Each has a `values` const array, a Zod schema, and an inferred type.
- **Typed error handling**: Expected failures (unresolved citation, no open-access text, invalid LLM JSON) use `Result<T>` return values (`{ ok: true; data: T } | { ok: false; error: string }`), not thrown exceptions. Throw only for programmer errors.
- **Centralized LLM client**: All Anthropic API calls (claim-discovery, seed-grounding, claim-family-filter, evidence-reranking, adjudication, family-consolidation) go through `src/integrations/llm-client.ts`. Every call is tagged with a `purpose` and returns `LLMCallRecord` telemetry; `getLedger()` aggregates per-run cost by purpose. Call sites can opt into persistent exact-result caching via `exactCache: { keyVersion }` — identical requests return cached responses without hitting the provider.
- **Discovery handoff bundle** (`attribution_first` only): `runDiscoveryStage` produces a `DiscoveryHandoffMap` (`src/domain/discovery-handoff.ts`) that carries resolved papers, citing-paper lists, pre-harvested mentions, and per-family grounding traces from discover → screen → extract — eliminating redundant resolution, OpenAlex fetches, LLM grounding, and full-text fetches. Fresh and resumed runs both consume the current versioned serialize/validate/deserialize boundary persisted at `inputs/discovery-handoffs.json`. Missing, unreadable, invalid, tampered, or shortlist-incomplete sidecars fail attribution-first resume. Key entry points: `runPreScreenFromHandoff` (`pre-screen.ts`), `extractEdgeContextFromMentions` (`citation-context.ts`).
- **Current-executor adjudication advisor mode** (temporary executor only; enabled by default there): Two-pass strategy — Sonnet+thinking first pass on all audit records, Opus+thinking only on `judgeConfidence === "low"` or `cannot_determine` escalations. Bundled citations also escalate on `medium` confidence. This is not part of canonical Adjudicate and must not be restored there until calibrated against blinded human labels. Disable with `adjudicateAdvisor: false` or `--no-advisor` on CLI.
- **Current-executor deferred evidence reranking**: The temporary executor runs BM25 before `curate`, then LLM-reranks only sampled audit records. Canonical Evidence has no curation/sampling boundary: it accounts for every Prepare record and optionally reranks each shared family BM25 run as a separately versioned result.
- **Current-executor vector-first adjudicator** (temporary executor opt-in only): `adjudicationMode: "vector_first"` runs `fidelityVectorTrace` before categorical adjudication, adaptively adds simple borderline samples, accepts clear `axisDerivedVerdict` outputs as final axis-derived verdicts, and escalates risky records to the existing categorical adjudicator using original unmodified audit records. The default remains `adjudicationMode: "categorical"`. Canonical Adjudicate has no vector-first path.
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

Fidelity labels are `F` (faithful), `D` (distortion), `E` (error), `U` (uncertain). Auditability gates (`auditable_structured`, `auditable_pdf`, `partially_auditable`, `not_auditable`) must pass before fidelity scoring. The current implementation focuses on `empirical_attribution` but the taxonomy is designed to extend to other citation functions.

## TypeScript Strictness

The tsconfig enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and all strict flags. `no-explicit-any` is enforced in src/ but relaxed in tests/.
