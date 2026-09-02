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

Unknown flags and stage names are ordinary invalid input (no legacy aliases). A resumed run loads and validates the saved canonical artifact chain before continuing.

## Stages

### Discover

Discover establishes a lossless, declared citing-neighborhood observation boundary. It paginates citation-index requests up to an exposed total `neighborhoodLimit`, records page provenance and complete/truncated coverage, and selects the probe set with a deterministic year-band × paper-type stratification when the probe budget is below the returned neighborhood.

It preserves every returned citing-paper disposition, citation occurrence, extraction outcome, attributed claim, and candidate. Seed occurrences are one per citation group whose exact `targetRefIds` include the seed; sibling refs remain bundle metadata only. Extraction is told the seed's resolved author-year label and any bundle it shares, and is instructed to extract only from the sentence carrying the seed's marker. Extracted claim `supportSpanText` values are exact-verified against the occurrence `rawContext` and persisted as offset-bound `supportSpan` objects when verification succeeds; mismatches leave the claim without a verified span. Extracted claims are then clustered once per seed by a model equivalence pass (`canonicalizeClaims`): claims that attribute the same underlying seed finding join one candidate even when they differ in wording, strength, or scope, so a family is one finding rather than one paraphrase and prevalence counts real cross-citer repetition. The candidate records how its members were judged equivalent (`equivalence.method` is `model`, with a `repairNote` when unknown, duplicate, or omitted claim references were repaired deterministically, or the `exact_normalized_text` fallback with a `fallbackReason` when the model call failed). Candidate selection uses an adaptive 15–25 family portfolio with deterministic prevalence/specificity/confidence/novelty annotations; the prepared-record budget and novelty floor only bind once the family minimum is met, and citation groups are keyed by source locator so groups in different paragraphs stay distinct. Lexical redundancy can still defer near-duplicate candidates. Grounding is intentionally deferred.

### Scope

Scope consumes verified Discover output, explicitly accounts for every candidate, freezes each selected family’s exact source-claim and citation-occurrence membership, and materializes immutable seed text once per seed. Each seed-text block records a coarse `sectionRole` (abstract, introduction, methods, results, discussion, figure, table, other) and the number of in-text citations the seed itself makes in that block, so later stages can tell the seed's own findings from its summary of prior work. Grounding is an annotation: `not_found`, unavailable text, or a provider failure does not silently remove a frozen family.

### Prepare

Prepare consumes Scope and its exact Discover ancestor. It emits exactly one stable record for every family × citation-occurrence pair, preserving both the complete family ledger and the occurrence-local claim set. Role classification is two-pass. The deterministic regex pass runs first: it prefers verified support-span text and takes the weakest per-claim extraction confidence as the occurrence confidence, so low-information citations reach `skip_low_information` rather than the manual-review queue. Occurrence-local claims missing a verified span are queued as `manual_review_extraction_limited` and never reach a model, because there is no verified text to show one. Every other `unclear` verdict — the deterministic classifier's largest single loss — goes to `prepare.roleClassifierModel` (Haiku by default) with the verified span, the marked sentences, and the section heading, and comes back as one of the same five roles; the record is then `classified` with a `model` execution. A model that is also unclear, or that fails or replies unusably, leaves the record `manual_review_role_ambiguous` with its call recorded. Classification failures and ambiguous roles remain typed records; they are not sampled away.

### Evidence

Evidence consumes Prepare and Scope. It retrieves only from immutable Scope seed text and emits one outcome per Prepare record. BM25 queries are built from occurrence-local atomic claims, with the Scope family claim as a declared fallback/secondary query. The two rankings are fused by reciprocal rank (raw BM25 scores are not comparable across queries) and capped at `bm25CandidateLimit`; relevance reranking (on by default) is a separate immutable ranking that sees each chunk's block kind, section role, and whether the block cites other work, but not BM25 scores or ranks. Scope grounding pins, when present, lead the selection in both the BM25 and reranked branches (`rankingSource` ends in `_with_scope_pins`), ordered by document position, so enabling reranking changes one variable, and content-hash reuse may share work across records without collapsing them. The tokenizer is Unicode-aware, keeps decimals and single-character numbers, and folds simple plurals. `bm25CandidateLimit` and `selectionLimit` are exposed in CLI/UI.

### Adjudicate

Every canonical model call uses provider-enforced structured output (`generateObject`) against the adapter's own response schema. The provider only sees the shape (Anthropic rejects bounds, `oneOf`, and defaults), so the reply is validated locally against the full Zod schema; a reply that still fails, or a completion cut off at the token cap, is a non-retried `invalid_output`, as is a candidate number that names no chunk. Each request body stores its prompt text once, so any call can be reproduced from the artifact alone.

Adjudicate consumes Evidence and Prepare. Deterministic gates produce typed `not_adjudicated` outcomes for unavailable evidence, retrieval failure, invalid context, unsuitable roles, broken citation-scope markers, missing verified support spans, and comparable operational conditions. Ambiguous citation roles stay in the manual-review queue (`manual_review_role_ambiguous` / `manual_review_extraction_limited`) and are not auto-routed to the model. Eligible packets show each seed chunk with its section role and a flag when the block cites other work, and instruct the model that only results, figure, table, or abstract text can establish the seed's own finding. They bind verified claim spans into the citing context (`▶…◀` must wrap claim-bearing text; a window whose every sentence is attributed to the seed is wrapped whole and stays eligible) and receive one categorical model request yielding `F`, `D`, `E`, or `U`; confidence never routes to another model or method. `adjudicate.effort` sets adaptive thinking effort (`high` by default) and is exposed on the CLI as `--adjudicate-effort` and in the UI form. Each adjudicated outcome also records the model's `citingAssertion` and `sourceStatement`, and for `D` verdicts one to three categorical `mutationKinds` (scope, population, certainty, causality, conditions, endpoint, generality, entity, magnitude, temporality) plus a `direction` (`strengthened`, `weakened`, `shifted`; `none` on non-`D` verdicts); these describe the mutation and never route the verdict. The occurrence-local claim set is bound from Prepare, not echoed by the model. Adjudicated outcomes also record deterministic `evidenceSufficiency` / optional `evidenceLimitation` diagnostics (for example figure-only support) without inventing a new verdict mode.

This method is **uncalibrated**. A completed run is not a validated scientific result and must not be used for trust claims before blinded human calibration.

### Report

Report consumes and tamper-verifies the full five-artifact chain. It writes authoritative JSON with the scientific content first: `familyMutations`, one entry per scoped family carrying the seed finding, its verified grounding spans, and every citing restatement in publication order with verdict, mutation kinds, and the adjudicator's citing/source statements. It also writes funnel counts, rates, and per-record traces, then renders Markdown from that validated JSON with the families section leading. Rates are reported both per record and per unique family × citing-paper × claim unit (`verdict_*_unique_rate`), and the Discover funnel records the probe sampling design per year-band × paper-type stratum. Verdict counts are also split by evidence regime (`verdictCountsByRankingSource`) so scope-pinned and unpinned records can be compared before pooling. Funnel accounting includes unique citing-paper/group coverage, verified vs missing claim support spans, unique family × citing-paper × claim units, packet-quality and evidence-sufficiency diagnostics, adaptive portfolio deferral reasons (family cap, record budget, lexical novelty), manual-review queue splits, and gate-code counts. `F`/`D`/`E`/`U` rates use adjudicated records as their denominator; operational non-verdicts are not verdicts.

## Run behavior

Within a stage, model calls run side by side: `modelConcurrency` (default 6, `--model-concurrency <n>`) bounds how many extraction, grounding, rerank, or adjudication requests are in flight. Results are appended in input order, so an artifact is byte-identical at any concurrency and the setting never enters identity. Scope sends the seed text as a cached prompt prefix, so its first grounding call per seed runs alone and the rest fan out once the cache is written; identical rerank requests issued at the same time share one call. Provider fetches and GROBID parsing stay sequential. A fatal provider error stops new dispatch, so it costs at most `modelConcurrency` calls.

Fresh and resumed runs create or use `data/runs/<runId>/`. Every succeeded stage is reloaded through its current-version schema and checked for content-hash and lineage consistency before a later stage runs. A failed stage blocks downstream stages.

Old SQLite rows and run directories from the former seven-stage executor are unsupported and may need deletion/recreation. Do not attempt to convert old shortlist, screening, extraction, classification, curation, or support-style adjudication artifacts into this pipeline. Legacy orchestration modules have been deleted from the source tree.
