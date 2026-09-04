# Implementation status

**Last updated:** 2026-09-02

This document records shipped behavior. The runnable production workflow is the canonical six-stage pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

The public CLI, SQLite run registry, local UI, artifact layout, resume logic, and stage inspection use only these six stage keys. Fresh runs are DOI-first (`pipeline --input <dois.json>`). Manual shortlist/tracked-claim starts and the `screen`, `extract`, `classify`, and `curate` stage vocabulary have been removed. Legacy orchestration modules and their tests have been deleted; the source tree is canonical-only.

## Pipeline (CLI)

| Stage | Status | Notes |
|---|---|---|
| `discover` | Runnable | Paginates the citing neighborhood, stratifies probing, emits one seed occurrence per exact citation group carrying the parser's own `locationQuality`, records each citing paper's access channel and bibliography match method, exact-verifies claim support spans into offset-bound `supportSpan` fields, clusters paraphrased claims across citers into one candidate per seed finding, annotates candidates, and selects an adaptive 15–25 family portfolio under a prepared-record budget. Grounding is deferred. |
| `scope` | Runnable | Accounts for every Discover candidate, freezes exact family and occurrence membership, materializes seed text once per seed, and records verified grounding without excluding a family. |
| `prepare` | Runnable | Produces one stable record for every scoped family × citation occurrence with complete and occurrence-local claim membership plus typed classification. A free deterministic regex pass runs first; only its `unclear` verdict reaches `prepare.roleClassifierModel` (Haiku by default). Missing verified support spans, and roles neither pass can settle, remain queued for manual review. |
| `evidence` | Runnable | Retrieves over immutable Scope seed text with occurrence-local BM25 queries (family-claim fallback), reciprocal-rank fusion, content-hash reuse, and an immutable relevance-rerank version that is on by default and sees section role and third-party-citation flags. Grounding pins lead the selection in both branches. One outcome per Prepare record. |
| `adjudicate` | Runnable, uncalibrated | Applies deterministic gates (including broken citation-scope markers and missing verified spans) and one categorical model call per eligible record; emits `F`/`D`/`E`/`U` or a typed non-verdict plus evidence-sufficiency diagnostics; `D` outcomes also carry categorical `mutationKinds` and a `direction`. Manual-review roles are not auto-broadened to the model. |
| `report` | Runnable, deterministic | Verifies the five upstream artifacts and writes authoritative JSON: `familyMutations` (each seed finding with its citing restatements in order, verdicts, and mutation kinds), funnel/rate/trace accounting (including unique claim units and per-unique-unit verdict rates, probe strata, the provider-reported neighborhood total and its coverage, access channel, materialization and harvest loss reasons, bibliography match method, verdicts by evidence regime, support-span coverage, evidence-sufficiency diagnostics, portfolio deferrals, and manual-review splits), `selectionAudit` (per-candidate portfolio scores), per-record citation-role signals, plus Markdown rendered from that JSON. |

Run with:

```bash
npm run dev -- pipeline --input path/to/dois.json
npm run dev -- pipeline --input path/to/dois.json --stop-after evidence
npm run dev -- pipeline --run-id <uuid>
npm run dev -- runs:gc --dry-run   # superseded stage attempts + unreferenced provenance
npm run test:live-smoke   # optional; requires PALIMPSEST_LIVE_SMOKE=1 and credentials
```

Unknown CLI flags and stage names are ordinary invalid input. `--stop-after` and `--rerun-from` accept only the six canonical keys.

Live smoke (`tests/live/`, `npm run test:live-smoke`) is manual/nightly and non-blocking for normal CI. The recorded replay fixtures under `fixtures/pipeline/replay/` exercise paywall, bundled-reference, and repeated-marker cases without network calls.

## From the September 2026 plan

Landed as code, still unmeasured:

- **Citation-role model fallback.** The deterministic regex pass runs first and only its `unclear` verdict reaches `prepare.roleClassifierModel` (Haiku). The measured loss it targets — 28 records gated `manual_review_role_ambiguous` in the 2026-09-02 replay — has not been re-measured.
- **Structured outputs.** Every canonical model call uses provider-enforced structured output. The provider receives a constraint-free copy of the schema (Anthropic rejects bounds, `oneOf`, and defaults) and the reply is validated locally against the full Zod schema. A reply that fails the schema or is cut off at the token cap is not retried; its tokens are still recorded in the ledger and its raw text lands in the failure record. Whether Opus adjudicates as well under native structured output, and whether `adjudicate.effort: medium` agrees with `high`, are open questions that need one seed re-run each.
- **Instrumented ledger.** `cost-summary.json` now records cache reads and writes per stage and per purpose, and merges across resume attempts, so the prefix-cache claim can be checked rather than inferred.
- **Side-by-side model calls, measured.** Extraction, grounding, reranking, and adjudication run `modelConcurrency` requests at once (default 6, `--model-concurrency`). The same seed took 68 minutes sequentially and 14 minutes six-wide, with no rate limits and a single prompt-cache write for the seed text. Artifacts are identical at any concurrency; only wall time changes.
- **Self-agreement, measured once.** Two cache-bypassed runs of the same seed agreed on 29 of 32 matched adjudicated records (F 24/24, D 4/6). Mutation kinds overlapped but never matched exactly; direction always matched. Candidate clustering varied more than verdicts (25 to 38 candidates from the same 120 claims). Evaluation write-ups are kept outside the repository.
- **Blinded review.** The Review tab opens with machine judgment hidden, the reviewer records their own label, and agreement is derived at export time; the CSV export collapses to claim units. No blinded labels exist yet, so `calibrationStatus` stays `uncalibrated`.

Still open from that plan: a second seed (step 0), the blinded re-review (step 3's "then use it"), the effort experiment (step 5), the four decisions in its "Decisions only you can make" section, and hop two (step 7, deliberately unstarted until hop one is calibrated).

## Scientific status

Canonical Adjudicate is **uncalibrated**. Successful execution does not validate its judgments, establish accuracy, or support trust claims. Blinded human calibration and separate evaluation reporting remain required.

There is no `curate` or sampling boundary: Scope, Prepare, Evidence, and Adjudicate retain complete record accounting.

## Compatibility and cleanup

Migration `0011_purge_pre_canonical_runs.sql` plus startup config validation purge unsupported `analysis_runs` / `analysis_run_stages` rows from the former seven-stage executor. Migration `0012_drop_orphan_papers_citations.sql` drops unused `papers` / `citations` tables (paper storage is `paper_cache` / `paper_parsed` only). Paper/LLM caches and on-disk `data/runs/` directories are preserved; those runs must not be resumed, converted, or bridged into canonical artifacts. `db:gc --days <n> [--dry-run]` deletes aged analysis-run registry rows and stale LLM exact-result cache rows from SQLite; it does not delete artifact directories. `runs:gc [--run-id <uuid>] [--dry-run]` handles the on-disk side: superseded stage attempts the run registry no longer points at, and the provenance blobs only those attempts referenced. Migration `0013_drop_write_only_columns.sql` drops `derived_artifacts` and every column that was written and never read back. Public benchmark CLI commands remain removed until a canonical blinded evaluation workflow exists.

The physical SQLite column `analysis_run_stages.family_index` remains because it is part of an immutable migration primary key. Canonical execution always writes `0` (one row per stage). UI/API surfaces no longer expose per-family query parameters.

## Local UI

`apps/ui` is a local-only launcher and inspector for the canonical pipeline. It creates DOI-first runs, launches `pipeline --run-id <uuid>`, presents the six canonical logical stages, and reads typed inspector payloads. It is not a hosted product.

The Report stage explorer joins Prepare/Evidence/Adjudicate onto the canonical report spine for Overview, Families (mutation view), Records, Review, and Audit trail browsing. It surfaces the uncalibrated interpretation warning and keeps F/D/E/U rates on the adjudicated-record denominator; it does not present completed runs as calibrated faithfulness evidence.

Human review is a post-report sidecar, not a seventh stage. Reviews append under `data/runs/<runId>/review/<reportArtifactId>/events.json`, bound to the current Report artifact ID/content hash, and never overwrite canonical machine artifacts. The Review tab exports JSON/CSV calibration datasets from that lineage.

## Cross-cutting implementation

- All external boundaries are Zod-validated.
- Canonical artifacts are current-version-only, content-hashed, lineage-bound envelopes.
- Resume reloads and verifies every succeeded ancestor; missing, invalid, tampered, or mismatched artifacts fail rather than silently recompute.
- PDF parsing uses GROBID after PDF validation; seed PDFs may be supplied with `--seed-pdf`.
- Report rates distinguish adjudicated `F`/`D`/`E`/`U` outcomes from operational non-verdicts.
- LLM purposes are limited to `attributed-claim-extraction`, `claim-canonicalization`, `seed-grounding`, `evidence-rerank`, `citation-role-classification`, and `adjudication`.
