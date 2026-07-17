# Pipeline Guide

The runnable operational workflow is the canonical six-stage pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

These six keys are the entire public CLI and UI vocabulary. The pipeline is DOI-first only; manual shortlist/tracked-claim starts are removed. There is no `curate` stage and no sampling.

## Start and resume

```bash
npm run dev -- pipeline --input path/to/dois.json
npm run dev -- pipeline --input path/to/dois.json --seed-pdf path/to/seed.pdf
npm run dev -- pipeline --input path/to/dois.json --stop-after evidence
npm run dev -- pipeline --run-id <uuid>
npm run dev -- pipeline --run-id <uuid> --rerun-from scope
```

The input is a JSON object with a nonempty DOI array:

```json
{ "dois": ["10.0000/example"] }
```

`--shortlist`, legacy strategy, target-size/advisor/vector flags, and legacy stage names are rejected. A resumed run loads and validates the saved canonical artifact chain before continuing.

## Stages

### Discover

Discover establishes a lossless, declared citing-neighborhood observation boundary. It preserves every returned citing-paper disposition, citation occurrence, extraction outcome, attributed claim, candidate membership, and cap disposition. It does not ground a claim or filter membership.

### Scope

Scope consumes verified Discover output, explicitly accounts for every candidate, freezes each selected family’s exact source-claim and citation-occurrence membership, and materializes immutable seed text once per seed. Grounding is an annotation: `not_found`, unavailable text, or a provider failure does not silently remove a frozen family.

### Prepare

Prepare consumes Scope and its exact Discover ancestor. It emits exactly one stable record for every family × citation-occurrence pair, preserving both the complete family ledger and the occurrence-local claim set. Classification failures and ambiguous roles remain typed records; they are not sampled away.

### Evidence

Evidence consumes Prepare and Scope. It retrieves only from immutable Scope seed text, emits one outcome per Prepare record, and can share family-level query/corpus/ranking work without collapsing records. BM25 uses only the declared Scope family claim. Optional relevance reranking is a separate immutable ranking, not a mutation of BM25.

### Adjudicate

Adjudicate consumes Evidence and Prepare. Deterministic gates produce typed `not_adjudicated` outcomes for unavailable evidence, retrieval failure, invalid context, unsuitable roles, and comparable operational conditions. Eligible records receive one categorical model request and yield `F`, `D`, `E`, or `U`; confidence never routes to another model or method.

This method is **uncalibrated**. A completed run is not a validated scientific result and must not be used for trust claims before blinded human calibration.

### Report

Report consumes and tamper-verifies the full five-artifact chain. It writes authoritative JSON funnel counts, rates, and per-record traces, then renders Markdown from that validated JSON. `F`/`D`/`E`/`U` rates use adjudicated records as their denominator; operational non-verdicts are not verdicts.

## Run behavior

Fresh and resumed runs create or use `data/runs/<runId>/`. Every succeeded stage is reloaded through its current-version schema and checked for content-hash and lineage consistency before a later stage runs. A failed stage blocks downstream stages.

Old SQLite rows and run directories from the former seven-stage executor are unsupported and may need deletion/recreation. Do not attempt to convert old shortlist, screening, extraction, classification, curation, or support-style adjudication artifacts into this pipeline. Temporary old modules may remain unreachable until deletion work completes.
