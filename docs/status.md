# Implementation status

**Last updated:** 2026-11-12

This document records shipped behavior. The runnable production workflow is the canonical six-stage pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

The public CLI, SQLite run registry, local UI, artifact layout, resume logic, and stage inspection use only these six stage keys. Fresh runs are DOI-first (`pipeline --input <dois.json>`). Manual shortlist/tracked-claim starts and the `screen`, `extract`, `classify`, and `curate` stage vocabulary have been removed. Legacy orchestration modules and their tests have been deleted; the source tree is canonical-only.

## Pipeline (CLI)

| Stage | Status | Notes |
|---|---|---|
| `discover` | Runnable | Enumerates the whole citing neighborhood (metadata only, safety cap 10,000), stratifies the probe set over all of it and records each stratum's inclusion probability, harvests probed papers `fetchConcurrency` at a time, emits one seed occurrence per exact citation group carrying the parser's own `locationQuality`, records each citing paper's access channel and bibliography match method, exact-verifies claim support spans into offset-bound `supportSpan` fields, clusters paraphrased claims across citers into one candidate per seed finding, annotates candidates, and selects an adaptive 15–25 family portfolio under a prepared-record budget. Grounding is deferred. |
| `scope` | Runnable | Accounts for every Discover candidate, freezes exact family and occurrence membership, materializes seed text once per seed, and records verified grounding without excluding a family. |
| `prepare` | Runnable | Produces one stable record for every scoped family × citation occurrence with complete and occurrence-local claim membership plus typed classification. Family, seed, candidate, claim, and citing-paper data are stored once on the payload and records refer to them by id. A free deterministic regex pass runs first; only its `unclear` verdict reaches `prepare.roleClassifierModel` (Haiku by default). Missing verified support spans, and roles neither pass can settle, remain queued for manual review. |
| `evidence` | Runnable | Retrieves over immutable Scope seed text with occurrence-local BM25 queries (family-claim fallback), reciprocal-rank fusion, content-hash reuse, and an immutable relevance-rerank version that is on by default and sees section role and third-party-citation flags. Grounding pins lead the selection; reranking is skipped with a typed reason when pins fill every selected slot. One outcome per Prepare record. |
| `adjudicate` | Runnable, uncalibrated | Applies deterministic gates (including broken citation-scope markers and missing verified spans) and one categorical model call per eligible record; emits `F`/`D`/`E`/`U` or a typed non-verdict plus evidence-sufficiency diagnostics; `D` outcomes also carry categorical `mutationKinds` and a `direction`. By default the model reads the whole seed text as a cached prompt prefix and its verdict rests on quotes verified against that text; `selected_chunks`, or an over-long seed text, falls back to the chunks Evidence selected. Manual-review roles are not auto-broadened to the model. |
| `report` | Runnable, deterministic | Verifies the five upstream artifacts and writes authoritative JSON: `familyMutations` (each seed finding with its citing restatements in order, verdicts, and mutation kinds), funnel/rate/trace accounting (including unique claim units and per-unique-unit verdict rates, F/D/E/U rates weighted over the sampling frame by inverse probe inclusion probability beside the unweighted sample rates, probe strata with frame sizes and inclusion probabilities, the provider-reported neighborhood total and its coverage, access channel, materialization and harvest loss reasons, bibliography match method, verdicts by evidence regime, support-span coverage, evidence-sufficiency diagnostics, portfolio deferrals, and manual-review splits), `selectionAudit` (per-candidate portfolio scores), per-record citation-role signals, plus Markdown rendered from that JSON. |

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

- **Citation-role model fallback.** The deterministic regex pass runs first and only its `unclear` verdict reaches `prepare.roleClassifierModel` (Haiku). When a specific finding also motivates a method or framing, the fallback rubric prefers substantive attribution. The loss this pass targets has not been re-measured.
- **Structured outputs.** Every canonical model call uses provider-enforced structured output. The provider receives a constraint-free copy of the schema (Anthropic rejects bounds, `oneOf`, and defaults) and the reply is validated locally against the full Zod schema. A reply that fails the schema or is cut off at the token cap is not retried; its tokens are still recorded in the ledger and its raw text lands in the failure record. Whether Opus adjudicates as well under native structured output, and whether `adjudicate.effort: medium` agrees with `high`, are open questions that need one seed re-run each.
- **Instrumented ledger.** `cost-summary.json` records cache reads and writes per stage and per purpose, and merges across resume attempts, so the prefix-cache claim can be checked rather than inferred. It is rewritten after every model call, so spend can be watched during a run (the run page shows it live), and `--max-cost` stops a run before it spends past a limit.
- **Side-by-side model calls.** Extraction, grounding, reranking, and adjudication run `modelConcurrency` requests at once (default 6, `--model-concurrency`). Artifacts are identical at any concurrency; only wall time changes.

## Scaling to heavily cited seeds (November 2026)

- **Whole-neighborhood sampling.** Discover lists every citing work before probing (listing a few thousand citers takes about 15 metadata requests at 200 per page) and draws the probe set from all of them instead of from the provider's first 200, which skewed old. Sampling covers the frame of works not marked closed or abstract-only, stratified by year band × type group (article, review, other). Each probe goes to the stratum where a probed work stands for the most frame works, so a 100-probe sample tracks the frame's year mix closely and the large strata end up with similar inclusion probabilities. Report's `weightedRates` estimate F/D/E/U over the frame with 1/π weights; the unweighted rates remain the observed sample.
- **Lean Prepare.** Prepare records no longer copy their family's candidates, claims, and Scope family; a seed with large families no longer multiplies family size by record count.
- **Parallel harvest.** Citing papers are fetched and parsed `discover.fetchConcurrency` at a time (default 6, `--fetch-concurrency`); the artifact is byte-identical at any value.
- **Batch transport.** `pipeline --batch` sends model requests through the Message Batches API at half price, as a `fetch` under the provider, so requests, validation, and artifacts are unchanged. Submitted requests are recorded (migration 0014) so a crash or resume takes a pending batch's result instead of paying twice, `--max-cost` reserves an expected cost per queued request (about 2.3 times real cost on whole-paper adjudication), shared prefixes use the 1-hour cache TTL, and `db:gc` prunes request rows past the 29-day results retention. Tested against a mocked API only; no real batched run yet.
- **Census runs.** `--census` probes every enumerated citer (`probeBudget: "all"`) and keeps every candidate as a family (`candidateSelection.mode: "all"`, every disposition still in the ledger with its reason). The UI new-run form offers both.
- **Blocked claim clustering.** A seed whose claims exceed one request (150) is clustered in two levels: exact-text units, BM25-similar blocks of at most 150 clustered side by side, and merge rounds over one representative per cluster. Candidates record `equivalence.method: "blocked_model"` with every block and merge request that judged them. On 4,000 synthetic claims over 300 findings it took 31 requests (28 blocks of 81–150 units, one merge round of 3) and gave identical families at concurrency 1 and 8. Not yet run against real claims at that size.
- **Summarized report.** Above 200 records the Markdown summarizes each family with two examples per verdict and points to the JSON; a synthetic 3,000-record, 120-family report is about 4,400 lines instead of about 16,000. The Report inspector's families now refer to rows by id instead of copying them (that payload went from about 24 MB to 16 MB, the families part from 8.3 MB to 0.3 MB) and render restatements 50 at a time.
- **Census-scale fixes.** Prepare's role classifier runs `modelConcurrency` at a time; GROBID parses at most `GROBID_CONCURRENCY` PDFs at once (default 2); and Adjudicate's artifact check matched each record against every provenance entry, which made building and loading a 3,000-record chain take minutes, so it now indexes them.
- **Repeat runs.** A repeated run of one seed was compared offline. The write-up stays outside the repository.
- **Blinded review.** The Review tab opens with machine judgment hidden, the reviewer records their own label, and agreement is derived at export time; the CSV export collapses to claim units. Local labels do not calibrate Adjudicate, so `calibrationStatus` stays `uncalibrated`.
- **Citation targeting and pin-filled packets.** Markers are anchored to exact verified support spans and the resolved reference before the window is cut. An unverified target stays unmarked and is gated to manual review. When verified grounding pins fill every selected slot, Evidence skips the reranker, keeps that pin-only packet, and Report counts the skip. A descriptive findings section after Methods is treated as results when the parser omitted the parent heading.

A local evaluation harness freezes a finished report into cases under `data/evaluations/`, imports that report's review history, and runs blind annotation plus resumable provider comparisons. Datasets, trials, and scores stay on disk. The UI grades one case at a time from the keyboard, and `eval request` saves a named set of cases that shows up there as waiting until each has a final label. See [evaluation.md](./evaluation.md).

Built for evaluation: constructed cases (`eval dataset --mutations`), which edit restatements a human labelled `F` so the expected verdict is known, as distortions that count missed distortions and wording-only controls that count false alarms; a repeat-agreement figure for run-to-run noise; and whole-paper adjudication (`adjudicationEvidence: "seed_text"`), which gives the adjudicator the seed's full text as a cached prefix and verifies the quotes it relies on. A comparison of three models on one seed used all three. Its write-up stays outside the repository, and one seed with one reviewer calibrates nothing. On that comparison, production Adjudicate now reads the whole seed text with `claude-sonnet-5-5` at `high` effort; the Report counts whole-paper verdicts, those quoting a passage Evidence did not select, and those where a quote failed verification. The client and price table now know `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`. The canonical run-config defaults now name the current models: `claude-haiku-5-5` for extraction, role classification and reranking, and `claude-sonnet-5-5` for clustering, grounding and adjudication at `high` effort. No canonical run has used them, or whole-paper adjudication, yet, so cost and behaviour of the current defaults are unmeasured.

Still open from that plan: a second seed (step 0), the blinded re-review (step 3's "then use it"), the effort experiment (step 5), the four decisions in its "Decisions only you can make" section, and hop two (step 7, deliberately unstarted until hop one is calibrated).

## Scientific status

Canonical Adjudicate is **uncalibrated**. Successful execution does not validate its judgments, establish accuracy, or support trust claims. Blinded human calibration and separate evaluation reporting remain required.

There is no `curate` or sampling boundary: Scope, Prepare, Evidence, and Adjudicate retain complete record accounting.

## Compatibility and cleanup

Migration `0011_purge_pre_canonical_runs.sql` plus startup config validation purge unsupported `analysis_runs` / `analysis_run_stages` rows from the former seven-stage executor. Migration `0012_drop_orphan_papers_citations.sql` drops unused `papers` / `citations` tables (paper storage is `paper_cache` / `paper_parsed` only). Paper/LLM caches and on-disk `data/runs/` directories are preserved; those runs must not be resumed, converted, or bridged into canonical artifacts. `db:gc --days <n> [--dry-run]` deletes aged analysis-run registry rows and stale LLM exact-result cache rows from SQLite; it does not delete artifact directories. `runs:gc [--run-id <uuid>] [--dry-run]` handles the on-disk side: superseded stage attempts the run registry no longer points at, and the provenance blobs only those attempts referenced. Migration `0013_drop_write_only_columns.sql` drops `derived_artifacts` and every column that was written and never read back. Evaluation commands operate on separate frozen datasets under `data/evaluations/`.

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
