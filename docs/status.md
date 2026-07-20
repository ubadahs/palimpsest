# Implementation status

**Last updated:** 2026-07-19

This document records shipped behavior. The runnable production workflow is the canonical six-stage pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

The public CLI, SQLite run registry, local UI, artifact layout, resume logic, and stage inspection use only these six stage keys. Fresh runs are DOI-first (`pipeline --input <dois.json>`). Manual shortlist/tracked-claim starts and the `screen`, `extract`, `classify`, and `curate` stage vocabulary have been removed. Legacy orchestration modules and their tests have been deleted; the source tree is canonical-only.

## Pipeline (CLI)

| Stage | Status | Notes |
|---|---|---|
| `discover` | Runnable | Paginates the citing neighborhood, stratifies probing, emits one seed occurrence per exact citation group, annotates candidates, and selects an adaptive 15–25 family portfolio under a prepared-record budget. Grounding is deferred. |
| `scope` | Runnable | Accounts for every Discover candidate, freezes exact family and occurrence membership, materializes seed text once per seed, and records verified grounding without excluding a family. |
| `prepare` | Runnable | Produces one stable record for every scoped family × citation occurrence with complete and occurrence-local claim membership plus typed classification. Ambiguous roles remain queued for manual review. |
| `evidence` | Runnable | Retrieves over immutable Scope seed text with occurrence-local BM25 queries (family-claim fallback), content-hash reuse, and optional immutable relevance-rerank versions. One outcome per Prepare record. |
| `adjudicate` | Runnable, uncalibrated | Applies deterministic gates and one categorical model call per eligible record; emits `F`/`D`/`E`/`U` or a typed non-verdict. Manual-review roles are not auto-broadened to the model. |
| `report` | Runnable, deterministic | Verifies the five upstream artifacts and writes authoritative JSON funnel/rate/trace accounting (including portfolio deferrals and manual-review splits) plus Markdown rendered from that JSON. |

Run with:

```bash
npm run dev -- pipeline --input path/to/dois.json
npm run dev -- pipeline --input path/to/dois.json --stop-after evidence
npm run dev -- pipeline --run-id <uuid>
npm run test:live-smoke   # optional; requires PALIMPSEST_LIVE_SMOKE=1 and credentials
```

`--shortlist`, legacy strategy and curation flags, and legacy stage names are rejected. `--stop-after` and `--rerun-from` accept only the six canonical keys.

Live smoke (`tests/live/`, `npm run test:live-smoke`) is manual/nightly and non-blocking for normal CI. The recorded VRN replay fixtures under `fixtures/pipeline/vrn-replay/` exercise paywall, bundled-reference, and repeated-marker cases without network calls.

## Scientific status

Canonical Adjudicate is **uncalibrated**. Successful execution does not validate its judgments, establish accuracy, or support trust claims. Blinded human calibration and separate evaluation reporting remain required.

There is no `curate` or sampling boundary: Scope, Prepare, Evidence, and Adjudicate retain complete record accounting.

## Compatibility and cleanup

Migration `0011_purge_pre_canonical_runs.sql` plus startup config validation purge unsupported `analysis_runs` / `analysis_run_stages` rows from the former seven-stage executor. Paper/LLM caches and on-disk `data/runs/` directories are preserved; those runs must not be resumed, converted, or bridged into canonical artifacts. Public benchmark CLI commands remain removed until a canonical blinded evaluation workflow exists.

The physical SQLite column `analysis_run_stages.family_index` remains because it is part of an immutable migration primary key. Canonical execution always writes `0` (one row per stage). UI/API surfaces no longer expose per-family query parameters.

## Local UI

`apps/ui` is a local-only launcher and inspector for the canonical pipeline. It creates DOI-first runs, launches `pipeline --run-id <uuid>`, presents the six canonical logical stages, and reads typed inspector payloads. It is not a hosted product.

## Cross-cutting implementation

- All external boundaries are Zod-validated.
- Canonical artifacts are current-version-only, content-hashed, lineage-bound envelopes.
- Resume reloads and verifies every succeeded ancestor; missing, invalid, tampered, or mismatched artifacts fail rather than silently recompute.
- PDF parsing uses GROBID after PDF validation; seed PDFs may be supplied with `--seed-pdf`.
- Report rates distinguish adjudicated `F`/`D`/`E`/`U` outcomes from operational non-verdicts.
- LLM purposes are limited to `attributed-claim-extraction`, `seed-grounding`, `evidence-rerank`, and `adjudication`.
