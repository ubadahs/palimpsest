# Pipeline Guide

The runnable workflow is a six-stage pipeline. Every run starts from seed DOIs.

```text
discover → scope → prepare → evidence → adjudicate → report
```

| Stage | In one line |
|---|---|
| [Discover](#discover) | Lists the papers that cite the seed, reads a sample of them, and groups what they claim about the seed into candidate claim families. |
| [Scope](#scope) | Freezes which families and citation occurrences are evaluated, materializes the seed paper's text, and builds a codebook of the seed's statements. |
| [Prepare](#prepare) | Builds one record per family × citation occurrence and classifies the role each citation plays. |
| [Evidence](#evidence) | Retrieves passages of the seed paper for each record. |
| [Adjudicate](#adjudicate) | Gives each eligible record one verdict, `F`, `D`, `E`, or `U`, or a typed reason it was not judged. |
| [Report](#report) | Verifies the chain and writes the JSON and Markdown results. |

These six keys are the entire public CLI and UI vocabulary.

## Mental model

A DOI goes in. Discover finds the papers that cite it and extracts what each says about it, then clusters equivalent statements into claim families. Scope fixes which families will be judged. Prepare turns every family × citation occurrence into a record. Evidence retrieves seed-paper passages for each record. Adjudicate compares the citing statement with the seed text and labels it. Report counts everything and writes the results.

Terms used below ([pipeline-concepts.md](./pipeline-concepts.md) has the object-flow glossary):

- **Seed paper**: the cited paper being audited, named by the input DOI.
- **Citing neighborhood**: every work the provider lists as citing the seed.
- **Probe**: a citing work that is fetched, parsed, and read in full. Discover probes a sample of the neighborhood, or all of it with `--census`.
- **Citation occurrence**: one place where a citing paper cites the seed. Occurrences are grouped by **citation group**, one bundle of references cited together at one place.
- **Attributed claim**: a statement a citing paper attributes to the seed, extracted from an occurrence.
- **Candidate** and **claim family**: a candidate is a cluster of attributed claims that restate the same seed finding. A family is a candidate that Scope has frozen for evaluation.
- **Record**: one family × citation occurrence pair, the unit that Evidence and Adjudicate process.
- **Chunk**: a window of seed text that Evidence can retrieve.
- **Grounding pin**: a seed-text span that Scope grounding found for a family and exact-verified, which later leads the evidence selection.

`F`, `D`, `E`, and `U` are the fidelity labels: faithful, distortion, error, uncertain. [adjudication-rubric.md](./adjudication-rubric.md) defines them.

Adjudicate is **uncalibrated**. A completed run is not a validated scientific result and must not be used for trust claims before blinded human calibration.

## Running a pipeline

```bash
npm run dev -- pipeline --input path/to/dois.json
npm run dev -- pipeline --input path/to/dois.json --seed-pdf path/to/seed.pdf
npm run dev -- pipeline --input path/to/dois.json --stop-after evidence
npm run dev -- pipeline --run-id <uuid>
npm run dev -- pipeline --run-id <uuid> --rerun-from scope
npm run dev -- pipeline --input path/to/dois.json --max-cost 4
npm run dev -- pipeline --input path/to/dois.json --batch
npm run dev -- pipeline --input path/to/dois.json --census --max-cost 40
npm run dev -- pipeline --run-id <uuid> --rerun-from scope --regenerate-codebook
```

The input is a JSON object with a nonempty DOI array:

```json
{ "dois": ["10.0000/example"] }
```

Run-level flags:

- `--input <path>` starts a fresh run; `--run-id <uuid>` resumes one.
- `--stop-after <stage>` stops after a stage. `--rerun-from <stage>` reruns a stage and everything downstream.
- `--force-refresh` refreshes provider-derived inputs.
- `--model-concurrency`, `--max-cost`, `--batch`, and `--census` are described under [Cross-cutting behavior](#cross-cutting-behavior).

Run directories and resume:

- Fresh and resumed runs create or use `data/runs/<runId>/`.
- A resumed run loads and validates the saved artifact chain before continuing. Every succeeded stage is reloaded through its current-version schema and checked for content-hash and lineage consistency before a later stage runs.
- A failed stage blocks downstream stages.
- Unknown flags and stage names are invalid input.

## Stages

### Discover

Discover establishes a lossless, declared observation boundary around the seed's citing neighborhood. It preserves every returned citing-paper disposition, citation occurrence, extraction outcome, attributed claim, and candidate.

**Reads.** The seed DOIs, the citing-work listing from OpenAlex, and the full text of the probed citing papers.

**What it does**, in order:

1. **Enumerate the neighborhood** (metadata only).
   - OpenAlex pages of 200, sorted by publication date, using plain `page=` paging. It needs no API key and reaches 10,000 works. The provider's default order is skewed toward older citers and shifts between requests, so it is not used.
   - `neighborhoodLimit` (default 10,000) is only a safety cap. A neighborhood larger than it is recorded as `truncated`, as is one where a reordered page repeated a work.
   - Every enumerated work becomes a citing-paper record, and the probe set is drawn from all of them.
2. **Sample the probe set** (`probeBudget`, default 100).
   - Sampling covers a frame: the works the provider does not mark closed or abstract-only. The rest are mostly never read and could not be represented by a random draw.
   - Frame works are grouped into year-band × type-group strata. The type groups are article (which includes preprints), review, and other (the long tail of errata, editorials, chapters, and the like).
   - The budget goes to strata one probe at a time, each to the stratum where a probed work would otherwise stand for the most frame works. Every stratum gets one probe before any gets a second, and the weights end up as even as the budget allows.
   - Within a stratum, works are taken in a fixed pseudo-random order (the content-hash record ID), never the provider's.
   - Budget left once the whole frame is probed goes to works outside it, abstract-only first. They add records but no weight.
   - Each neighborhood records its `probeStrata`: per stratum, the enumerated, frame, probed, and probed-frame counts and the inclusion probability π = probed frame works / frame works (null for a stratum with no frame works). Report weights by π.
3. **Harvest the probed papers.** Papers are fetched, parsed, and harvested `discover.fetchConcurrency` at a time. Results are appended in neighborhood order, so the artifact is byte-identical at any value and a resume ignores the setting.
4. **Extract occurrences and claims.**
   - Seed occurrences are one per citation group whose exact `targetRefIds` include the seed. Sibling references stay bundle metadata only.
   - Extraction is told the seed's resolved author-year label and any bundle it shares, and is instructed to extract only from the sentence carrying the seed's marker.
   - Each extracted claim's `supportSpanText` is exact-verified against the occurrence `rawContext` and persisted as an offset-bound `supportSpan` object when verification succeeds. A mismatch leaves the claim without a verified span.
5. **Cluster claims into candidates** (`clusterClaims`, per seed). A model equivalence pass joins claims that attribute the same underlying seed finding into one candidate, even when they differ in wording, strength, or scope. A family is therefore one finding, not one paraphrase, and prevalence counts real cross-citer repetition.
6. **Annotate and select candidates.** See [Candidate selection](#candidate-selection).

Grounding is deferred to Scope.

**Writes.** The Discover artifact: neighborhoods with `probeStrata`, citing-paper records, occurrences, extraction outcomes, attributed claims, candidates with their annotations, and the selection ledger.

**Fails and gates.** Truncated neighborhoods are recorded as `truncated`. Claims without a verified span stay in the ledger without one. Later stages gate on that.

**Options.**

- Config: `discover.neighborhoodLimit`, `discover.probeBudget` (a number or `"all"`), `discover.fetchConcurrency`, `discover.fromYear`, `discover.toYear` (`fromYear` must not exceed `toYear`), `discover.extractionModel`, `discover.extractionThinking`, `discover.clusteringModel`, `discover.clusteringThinking`, `discover.neighborhoodProvider` (`openalex`), `discover.neighborhoodQuery` (`works-citing-seed`), and `discover.candidateSelection`.
- CLI: `--neighborhood-limit`, `--probe-budget <n|all>`, `--fetch-concurrency` (default 6), `--from-year`, `--to-year`, `--extraction-model`, `--extraction-thinking` / `--no-extraction-thinking`, `--min-families`, `--max-families`, `--max-prepared-records`, and `--census`.

#### Claim clustering

When a seed's claims fit one block (150 claims, about 20k input tokens), one request clusters them all. Otherwise clustering runs in two levels (`src/stages/discover/claim-clustering.ts`):

1. Claims with the same normalized text become one unit.
2. Units are split into blocks of at most 150 by BM25 similarity. Each block is seeded by the heaviest unassigned unit and filled with its unassigned neighbours whose score reaches a quarter of the seed's score against itself. Blocks under half full are packed together whole.
3. Each block is clustered by the same prompt, `modelConcurrency` at a time (so `--batch` batches them), listing one representative claim per unit.
4. The block clusters are merged by the same prompt over one representative claim per cluster. The merge is blocked the same way and repeated in rounds until one request holds every representative or a round joins nothing.

Determinism and cost:

- Every request's input is fixed by the claims and the previous round's replies, read in block order. Families are therefore identical at any concurrency and in any completion order.
- Every request goes through the exact-result cache, so a resume pays nothing for finished blocks.

Each candidate records how its members were judged equivalent in `equivalence.method`:

- `model`: one request. A `repairNote` is set when unknown, duplicate, or omitted claim references were repaired deterministically.
- `blocked_model`: the seed's `blockCount`, the block requests that clustered its claims, and the merge requests that saw them. Each request has its own `repairNote`. A request that failed carries a `fallbackReason` and fell back to exact text in the block, or to no joins in the merge. A one-claim block carries `single_claim`.
- `exact_normalized_text`: with a `fallbackReason` when the single request failed.

#### Candidate selection

Selection runs through one decision ledger. Each candidate carries deterministic prevalence, specificity, confidence, and novelty annotations, and a disposition with its reason.

- **Adaptive portfolio** (default, `candidateSelection.mode: "adaptive_portfolio"`): selects 15–25 families (`minFamilies`, `maxFamilies`).
  - The prepared-record budget (`maxPreparedRecords`, default 100) and the novelty floor (`minMarginalNovelty`, default 0.08) only bind once the family minimum is met.
  - Citation groups are keyed by source locator, so groups in different paragraphs stay distinct.
  - Lexical redundancy can still defer near-duplicate candidates.
- **All** (`candidateSelection.mode: "all"`): selects every candidate through the same ledger, each with its annotation and the reason, ranked by citing papers, citation groups, and claims that restate it. There is no family cap, record budget, or novelty floor.

### Scope

Scope fixes what the rest of the pipeline evaluates and gathers the seed-side text it needs.

**Reads.** The verified Discover artifact, and the seed paper's full text. A local PDF can stand in for the seed (`--seed-pdf`).

**What it does.**

- Explicitly accounts for every Discover candidate.
- Freezes each selected family's exact source-claim and citation-occurrence membership.
- Materializes immutable seed text once per seed. Each seed-text block records a coarse `sectionRole` (abstract, introduction, methods, results, discussion, figure, table, other) and the number of in-text citations the seed itself makes in that block. Later stages use these to tell the seed's own findings from its summary of prior work.
- Grounds each family: a model finds seed-text spans that state the family's finding, with exact-verified quotes. These are the grounding pins.
- Builds the seed codebook and tags every Discover claim with it. See [Seed codebook and tagging](#seed-codebook-and-tagging).

Grounding is an annotation: `not_found`, unavailable text, or a provider failure does not silently remove a frozen family.

**Writes.** The Scope artifact: frozen families, seed-text materializations, grounding results, `codebooks`, and `claimTags`.

**Fails and gates.** Scope accounts for every candidate, so nothing drops silently. A seed without usable text leaves its codebook `seed_text_unavailable`. See the codebook statuses below.

**Options.**

- Config: `scope.groundingModel`, `scope.groundingThinking`, `scope.codebookModel`, `scope.taggingModel`, `scope.seedPdfPath`.
- CLI: `--grounding-model`, `--grounding-thinking` / `--no-grounding-thinking`, `--seed-pdf`, `--regenerate-codebook`, `--force-refresh`.
- `--seed-pdf <path>` works only on a single-DOI run. It bypasses open-access lookup for the seed, reads the local PDF, and sends it to GROBID. The path is persisted only as `scope.seedPdfPath`. Multi-DOI runs reject a single shared PDF. The UI new-run form has an optional PDF upload field.

#### Seed codebook and tagging

Scope also builds a **seed codebook** and tags every Discover claim with it. Both are annotations: they change no family, candidate, record, or verdict, and nothing downstream of Scope reads them except Report.

Families are drawn by a clustering call over all claims, so the partition shifts whenever the citer list changes. Codebook entries are drawn from the seed paper itself, so they stay put and per-entry numbers can be compared between runs.

**Codebook procedure.**

- Three calls to `scope.codebookModel` (`claude-sonnet-5-5` by default, adaptive `medium` effort, purpose `seed-codebook`).
- All three use the seed text as the same cached prompt prefix and one shared response schema. The schema is sent ahead of the prompt, so a schema per step would break the cache. They run one after another so the first writes the cache.
- The steps:
  1. List the headline and the seed's own results, each with its interpretation folded in.
  2. List background the seed relays from prior work, and the methods, reagents, lines, and resources it can be cited for.
  3. Organise both lists into a few themes, each with specific entries, and deduplicate.
- The organise step is told that the headline theme is never empty (the steps of the main claim sit under it, so a general restatement and its parts roll up to one theme), that a result and its interpretation are one entry, that a restatement of the headline is the headline theme itself, and to compare every pair of entries, across themes too, and merge near-duplicates.
- Each entry has an id (`E01`…), a statement, a type (`result`, `background_prior_work`, `method_or_resource`), `attributedToOtherWork`, a parent theme (`T1`…, one marked `isHeadline`), and at least one quote.
- Every quote is exact-verified against a single seed-text block, as grounding spans are.
- Dropped and counted: an entry whose quotes all fail, and an entry whose theme is missing. A theme with neither a verified quote nor an entry is dropped. Ids are renumbered densely afterwards.
- A codebook with no verified entry, or a nonfatal provider failure, leaves the seed `failed` and its claims `not_tagged`.

**Frozen once per seed.**

- The verified codebook is stored in SQLite (`seed_codebooks`, migration 0015), keyed by seed id, a content hash of the seed-text blocks, and `SEED_CODEBOOK_PROCEDURE_VERSION`.
- Scope reuses the stored codebook whenever the key matches and generates one otherwise. A changed seed text or procedure regenerates; a changed `codebookModel` does not.
- `--force-refresh` does not regenerate it, because refreshing papers is a different intent.
- Only `pipeline --regenerate-codebook` asks the model again and replaces the stored row. It needs Scope to run in that invocation (`--rerun-from scope` on a resume).
- `db:gc` never deletes it.
- The Scope artifact's `codebooks` records each seed's codebook in full with `status`:
  - `generated`, with its three model executions
  - `reused`, with the run that generated it
  - `failed`
  - `seed_text_unavailable`

**Tags.**

- One request per claim to `scope.taggingModel` (`claude-haiku-5-5` by default, `low` effort, purpose `codebook-tagging`). The codebook is the shared cached prefix and only that claim's text is in the suffix.
- Claims of a seed with the same whitespace-normalized text share one request.
- The answer is 1 to 3 specific entries, or one theme alone when the claim is broader than any entry under it, or none, with a one-line reason. Topic decides, not accuracy: a claim that misstates an entry is still about it.
- A reply naming unknown ids, more than three entries, or a theme-only answer without a theme fails validation and is never cached.
- Requests run `modelConcurrency` at a time (so `--batch` batches them), the first per seed alone to write the cache, through the exact-result cache.
- A failed request is a typed `tagging_failed` outcome on its claims, never a stage failure (fatal provider errors and `--max-cost` excepted).
- `claimTags` holds one outcome per Discover claim, in or out of a selected family.

### Prepare

**Reads.** Scope and its exact Discover ancestor.

**What it does.** Emits exactly one stable record for every family × citation-occurrence pair, preserving both the complete family ledger and the occurrence-local claim set (the claims extracted at that one occurrence).

- **Stored once.** Family-level data is stored once on the payload: the Scope families, their Discover seeds, candidates, and claims, and the citing papers of the prepared occurrences. A record holds only its occurrence, the ids of the family candidates and claims that belong to that occurrence, and its classification, so its size does not grow with its family's. `resolvePreparedRecords` joins the references back for consumers. Record IDs are still the family × occurrence hash.
- **Role classification** is two-pass. Roles are `substantive_attribution`, `background_context`, `methods_materials`, `acknowledgment_or_low_information`, and `unclear`.
  1. The deterministic regex pass runs first. It prefers verified support-span text and takes the weakest per-claim extraction confidence as the occurrence confidence, so low-information citations reach `skip_low_information` rather than the manual-review queue.
  2. Every other `unclear` verdict, the deterministic classifier's largest single loss, goes to `prepare.roleClassifierModel` (Haiku by default). The model sees the verified span, the marked sentences, and the section heading, and comes back as one of the same five roles. The record is then `classified` with a `model` execution.
- Model requests run `modelConcurrency` at a time with results kept in input order, so `--batch` batches them and the artifact is identical at any concurrency.

**Writes.** The Prepare artifact: the shared family-level payload and the records with their typed classification.

**Fails and gates.**

- Occurrence-local claims missing a verified span are queued as `manual_review_extraction_limited` and never reach a model, because there is no verified text to show one.
- A model that is also unclear, or that fails or replies unusably, leaves the record `manual_review_role_ambiguous` with its call recorded.
- Classification failures and ambiguous roles remain typed records. They are not sampled away.

**Options.** `prepare.roleClassifierModel` (default `claude-haiku-5-5`). `prepare.classifier` is fixed at `deterministic`.

### Evidence

**Reads.** Prepare and Scope. Evidence retrieves only from immutable Scope seed text.

**What it does.** Emits one outcome per Prepare record.

- **Chunking.** Seed-text blocks are cut into fixed-character windows of 1,200 characters with 200 characters of overlap (`evidence-chunking-v1`).
- **BM25.** Queries are built from occurrence-local atomic claims, with the Scope family claim as a declared fallback or secondary query.
  - The tokenizer is Unicode-aware, keeps decimals and single-character numbers, and folds simple plurals.
  - The two rankings are fused by reciprocal rank (raw BM25 scores are not comparable across queries; the constant is 60) and capped at `bm25CandidateLimit`.
- **Reranking** (on by default) is a separate immutable ranking. It sees each chunk's block kind, section role, and whether the block cites other work, but not BM25 scores or ranks. Content-hash reuse may share work across records without collapsing them.
- **Grounding pins.** Scope grounding pins, when present, lead the selection in both the BM25 and reranked branches, ordered by document position. `rankingSource` ends in `_with_scope_pins`.
- **Skipping the reranker.** When verified pins fill `selectionLimit`, Evidence preserves that exact pin-only packet and records `skipped_pins_fill_selection` without calling the reranker. Report counts these skips separately.

**Writes.** The Evidence artifact: the chunk corpus, queries, BM25 runs, optional rerank rankings, and one outcome per record with its selected chunks.

**Fails and gates.** Retrieval failures and records with no lexical matches are typed outcomes (Adjudicate gates on them as `retrieval_failed` and `no_lexical_matches`).

**Options.**

- Config: `evidence.rerankEnabled` (default true), `evidence.rerankModel` (default `claude-haiku-5-5`), `evidence.rerankTopN` (default 5), `evidence.bm25CandidateLimit` (default 20), `evidence.selectionLimit` (default 5, must not exceed `bm25CandidateLimit`).
- CLI: `--rerank` / `--no-rerank`, `--rerank-model`, `--rerank-top-n`, `--bm25-candidate-limit`, `--evidence-selection-limit`. `bm25CandidateLimit` and `selectionLimit` are also in the UI.

### Adjudicate

**Reads.** Evidence and Prepare.

**What it does.** Emits one categorical `F`, `D`, `E`, or `U` result, or a typed operational non-verdict, per Evidence record.

1. **Deterministic gates** produce typed `not_adjudicated` outcomes. The codes are listed under Fails and gates below.
2. **Seed text shown to the model.**
   - By default (`adjudicate.evidence: seed_text`) the model reads the whole seed text, rebuilt block for block from the Evidence corpus, so Adjudicate takes no input beyond Evidence and Prepare.
   - The seed text is a prompt prefix shared by every record of a seed and cached by the provider. The citing side is the per-record suffix. The first request per seed writes the cache alone.
   - With `selected_chunks`, or for a seed text over 400,000 characters (`SEED_TEXT_MAX_CHARACTERS`), the model sees only the chunks Evidence selected and cites them by number.
   - In either mode each seed block or chunk is shown with its section role and a flag when it cites other work. The model is told that only results, figure, table, or abstract text can establish the seed's own finding.
3. **Citation-scope markers.** Sentences attributed to the seed paper are wrapped in `▶ ... ◀` markers.
   - Markers are anchored to exact verified support spans and the resolved reference identity. An unverified target remains unmarked and is gated to manual review, including in a single-sentence context.
   - The marked text is windowed only after targeting, so an unrelated citation with the same year cannot redirect it. A window whose every sentence is attributed to the seed is wrapped whole and stays eligible.
   - The `seedRefLabel` used in the prompt (for example "Adeyemi and Okonkwo, 2009") comes from the matched bibliography entry's author surnames and year, set when mentions are harvested.
4. **One model request** per eligible packet yields `F`, `D`, `E`, or `U`. Confidence never routes to another model or method.
5. **Quote verification** (whole-seed-text mode).
   - The model quotes the passages its verdict rests on, and each quote is verified as exact text of the block it names. A quote that is not exact is dropped and counted.
   - An `F`, `D`, or `U` left with no verified quote is `invalid_output`. An `E` may quote nothing, because the paper may say nothing on the point.
   - The outcome records the verified `seedQuotes` and, as `modelCitedChunkIds`, the corpus chunks that hold them, whether or not Evidence selected those chunks.

**Writes.** The Adjudicate artifact. Each adjudicated outcome records:

- the verdict, the model's `citingAssertion` and `sourceStatement`, and its rationale and confidence;
- for `D` verdicts, one to three categorical `mutationKinds` and a `direction`. These describe the mutation and never route the verdict;
  - `mutationKinds`: `scope_broadened`, `scope_narrowed`, `population_shifted`, `certainty_strengthened`, `certainty_weakened`, `correlation_to_causation`, `conditions_dropped`, `endpoint_substituted`, `generality_increased`, `entity_substituted`;
  - `direction`: `strengthened`, `weakened`, `shifted`, or `none` (always `none` on `F`, and `mutationKinds` is empty on every non-`D` verdict);
- the occurrence-local claim set, bound from Prepare rather than echoed by the model;
- deterministic `evidenceSufficiency` and optional `evidenceLimitation` diagnostics (for example figure-only support), without inventing a new verdict mode.

**Fails and gates.**

- Gate codes for `not_adjudicated`: `seed_text_unavailable`, `seed_acquisition_failed`, `retrieval_failed`, `no_lexical_matches`, `classification_failed`, `invalid_context`, `skip_low_information`, `manual_review_role_ambiguous`, `manual_review_extraction_limited`, `ambiguous_citation_role`. In prose: unavailable evidence, retrieval failure, invalid context, unsuitable roles, broken citation-scope markers, missing verified support spans, and comparable operational conditions.
- Ambiguous citation roles stay in the manual-review queue (`manual_review_role_ambiguous` / `manual_review_extraction_limited`) and are not auto-routed to the model.
- The gates are identical in both evidence modes, so a record Evidence could not retrieve for is still not adjudicated.
- A reply that fails the schema, a completion cut off at the token cap, or a candidate number that names no chunk is a non-retried `invalid_output`.

**Options.** `adjudicate.model` (default `claude-sonnet-5-5`), `adjudicate.thinking` (default on), `adjudicate.effort` (adaptive thinking effort, `high` by default), `adjudicate.evidence` (`seed_text` or `selected_chunks`). CLI: `--adjudicate-model`, `--adjudicate-thinking` / `--no-adjudicate-thinking`, `--adjudicate-effort low|medium|high|max`, `--adjudicate-evidence seed_text|selected_chunks`. The effort and evidence settings are also in the UI form.

### Report

**Reads.** The full five-artifact chain, which it tamper-verifies.

**What it does.** Deterministically writes authoritative JSON, then renders Markdown from that validated JSON. No model calls.

**Writes.** The JSON, in the order of its scientific content:

- **`familyMutations`**: one entry per scoped family, carrying the seed finding, its verified grounding spans, and every citing restatement in publication order with verdict, mutation kinds, and the adjudicator's citing and source statements.
- **Funnel counts, rates, and per-record traces** (`recordTraces`). The funnel covers:
  - unique citing-paper and citation-group coverage;
  - verified versus missing claim support spans;
  - unique family × citing-paper × claim units;
  - packet-quality and evidence-sufficiency diagnostics;
  - adaptive portfolio deferral reasons (family cap, record budget, lexical novelty);
  - manual-review queue splits and gate-code counts;
  - the probe sampling design per seed and year-band × type-group stratum, with each stratum's frame size and inclusion probability.
- **`seedCodebooks`**: the codebook view (below).
- **`selectionAudit`**: each candidate's portfolio component scores. Each record trace carries its citation-role signals.

**Rates.**

- `F`/`D`/`E`/`U` rates use adjudicated records as their denominator. Operational non-verdicts are not verdicts and are excluded.
- Rates are reported per record and per unique family × citing-paper × claim unit (`verdict_*_unique_rate`).
- `weightedRates` (`verdict_*_weighted_rate`) count each adjudicated record from a frame work 1/π of its stratum, so they estimate F/D/E/U rates over the sampling frame. This assumes full-text loss within a stratum is unrelated to fidelity and takes the families as selected from the probed sample. Records from works outside the frame are left out.
- Each weighted rate carries its weighted numerator and denominator beside its sample counts (the frame records it rests on). The unweighted `rates` keep the observed counts over every adjudicated record.
- Verdict counts are also split by evidence regime (`verdictCountsByRankingSource`), so scope-pinned and unpinned records can be compared before pooling.

**Markdown.** The families section leads.

- Up to 200 records (`MARKDOWN_RECORD_DETAIL_LIMIT`): lists every restatement and traces every record.
- Above 200: summarizes each family instead. Each summary has its counts, each verdict's share of its adjudicated records, one grounding span, and up to two restatements per verdict (D and E first, with the adjudicator's statements, then U and F, earliest citing papers first), then names where in the JSON the rest are. The per-record trace section points to `recordTraces`. Size then follows families, not records: about 4,400 lines for a synthetic 3,000-record, 120-family run, against about 16,000 listing every record. The JSON stays complete.
- The Markdown states what share of the enumerated works the sampling frame is.

**Seed codebook view.** Rendered after the families as "Seed codebook view", with one table per level. Tags join verdicts through each adjudicated outcome's `evaluatedClaimRecordIds`.

- Per entry: tagged claim units (distinct citing paper × normalized claim text), adjudicated records, and F/D/E/U. A record is counted under every entry it is tagged with.
- Per theme: the same, where a claim unit or record counts once if it carries the theme itself or any entry under it. This absorbs a tagger choosing the theme for one wording and an entry under it for another. The theme row also splits claim units tagged with the theme alone from those tagged with an entry under it.
- Also given: claims by tag kind, tagging failures, untagged claim units and adjudicated records, and entries no claim cites.
- The text states that entries come from the seed paper and are stable across runs of the same seed text, that tags are not verdicts, and that "none" does not mean the seed never said it.

**Fails and gates.** Report tamper-verifies the chain first, so a chain that does not verify produces no report.

**Options.** None.

## Cross-cutting behavior

### Model calls

- Every model call uses provider-enforced structured output (`generateObject`) against the adapter's own response schema.
- The provider only sees the shape (Anthropic rejects bounds, `oneOf`, and defaults), so the reply is validated locally against the full Zod schema.
- Each request body stores its prompt text once in the run's provenance directory, so any call can be reproduced from the artifact alone.
- Calls are routed through `src/integrations/llm-client.ts`. See [caching.md](./caching.md) for the exact-result cache and the seed codebook store.

### Concurrency

- **Model calls.** `modelConcurrency` (default 6, `--model-concurrency <n>`) bounds how many extraction, clustering, role-classification, codebook, grounding, tagging, rerank, or adjudication requests are in flight within a stage. A seed's three codebook calls always run one after another; seeds run side by side.
- **Determinism.** Results are appended in input order, so an artifact is byte-identical at any concurrency and the setting never enters identity.
- **Prompt-cache writes.** Scope sends the seed text as a cached prompt prefix, so its first grounding call per seed runs alone and the rest fan out once the cache is written. Identical rerank requests issued at the same time share one call.
- **Fetching.** Discover's citing-paper fetching and GROBID parsing have their own bound, `discover.fetchConcurrency` (default 6), one global limit across providers. The full-text fetcher has no per-provider spacing, and the HTTP client backs off on 429s.
- **GROBID.** PDFs reach GROBID at most `GROBID_CONCURRENCY` at a time (default 2). It is an environment setting, not run config, because a local container timed out parsing with six fetched side by side. A PDF waiting for a GROBID slot has not started its 30-second request timeout.
- **Fatal provider errors** stop new dispatch, so one costs at most `modelConcurrency` calls (or `fetchConcurrency` fetches).

### Cost limit (`--max-cost`)

- Estimated spend is in `cost-summary.json` at the run root, rewritten after every model call. Each stage logs its own cost and the run's total when it finishes.
- `--max-cost <usd>` stops sending model requests once the run's estimated spend, earlier attempts included, reaches the limit. The stage in progress fails, and the run can be resumed with a higher limit.
- Requests already in flight still finish, so a run can pass the limit by up to `modelConcurrency` requests.
- The limit is not part of the run config, so raising it on resume changes nothing scientific.

### Census (`--census`)

`--census` analyzes every citer instead of a sample. It is shorthand for two run-config settings, not a third:

- `discover.probeBudget: "all"` probes every enumerated citing work (still capped only by `neighborhoodLimit`).
- `discover.candidateSelection.mode: "all"` makes every candidate a family, with no family cap or record budget.

Related settings:

- `--probe-budget all` sets the first alone.
- The UI new-run form has a "Probe every citer" box and a candidate-selection menu.
- `--census` cannot be combined with `--probe-budget` or the portfolio flags (`--min-families`, `--max-families`, `--max-prepared-records`).
- A census of a seed with a few thousand citers is a large spend. Combine it with `--max-cost` and, for half price, `--batch`.

### Batch transport (`--batch`)

`--batch` sends model requests through Anthropic's Message Batches API, which bills input, output, and cache tokens at half the list price.

It changes only the transport under the provider (`src/integrations/batch-transport.ts`). Each request is built, validated, retried, cached, and classified exactly as a direct call, and prompts, settings, and artifacts are the same. Like `--max-cost` it is not part of the run config, so a resume can turn it on or off.

**How it works.**

- Each stage queues all its model requests at once. The stages are given unbounded concurrency for that attempt, and the saved `modelConcurrency` is untouched.
- The queue is submitted as one batch once no request has joined it for 2 seconds (or at 10,000 requests or 200 MB). It is then polled every 15 seconds, doubling to once a minute.
- Each caller gets back its own result. An errored item raises the error a direct call would, so a bad request still fails the stage and an overloaded one is retried. Expired and canceled items were never processed and are resent.

**Small queues go direct.** A queue that goes quiet with fewer than five requests is sent as direct requests at list price, so a lone clustering call, a retry, or a handful of prompt-cache writes does not wait minutes for a batch.

**Latency.**

- Each round of requests waits for its batch: usually minutes, at most 24 hours. A stage that sends in rounds waits once per round.
- Scope grounding and whole-paper adjudication send each seed's first request alone so it writes the prompt cache, then the rest. Under `--batch` that costs one extra round per stage, sent direct when the run has fewer than five seeds.

**Cost and `--max-cost`.**

- A call answered through a batch carries `transport: "batch"` on its call record and is priced at half. `cost-summary.json` counts these per stage (`batchCalls`) and the stage cost log says how many there were.
- `--max-cost` still holds, approximately. A whole stage is queued before anything is billed, so each batched request reserves an expected cost when it is queued and releases it once its real cost is recorded. A request that would take billed plus reserved spend past the limit is refused with `spend_limit`.
- The reservation prices:
  - a cached shared prefix as a cache read (as a cache write for the first request seen with that prefix);
  - the rest of the prompt as uncached input, at about four characters per token plus 300 tokens;
  - output at twice the mean of this attempt's completed calls with the same purpose and model, never under 2,000 tokens nor over the request's cap;
  - all at batch price.
- Measured outputs average 345–540 tokens, so the 2,000-token floor dominates. A 2,500-record whole-paper adjudication stage that really costs about $14 reserves about $32 at its peak, so it needs a limit of about 2.3 times its real cost.
- The limit is not a hard cap. If real outputs average well above the reservation, spend can pass it by the difference across everything already queued.

**Prompt caching.**

- Batch savings on whole-paper adjudication and seed grounding depend on cache hits inside the batch.
- Batched shared prefixes are written with the 1-hour cache TTL rather than 5 minutes, because a batch can wait longer than five minutes after the seed's first request wrote the cache. A 1-hour write costs twice the input price instead of 1.25 times, paid once per seed.
- If the cache is missed, each record pays full input for the seed text (about 22k tokens, about $0.022 per record at Sonnet batch price), which makes a batched record cost about 2.4 times a direct one.
- `cacheReadTokens` in `cost-summary.json` shows whether the hits happened.

**Resume and crashes.**

- A submitted batch is billed even if the process dies before reading it.
- Every submitted request's `custom_id` (a SHA-256 of its exact body, `anthropic-version`, and `anthropic-beta`) is recorded with its batch id in the `llm_batch_requests` table.
- When a later run or resume sends the identical request, it waits on that batch, or takes a result already stored, instead of paying again. A resume whose settings changed sends different requests, which are new.
- Rows are deleted once their result reaches a caller. Rows older than 29 days (the API's results retention) are resubmitted.
- The one gap is a crash between the API accepting a batch and the database recording it.
