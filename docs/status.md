# Implementation status

**Last updated:** 2026-11-20

This document records shipped behavior. The runnable production workflow is the six-stage pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

The public CLI, SQLite run registry, local UI, artifact layout, resume logic, and stage inspection use only these six stage keys. Fresh runs are DOI-first (`pipeline --input <dois.json>`).

## Pipeline (CLI)

| Stage | Status |
|---|---|
| `discover` | Runnable |
| `scope` | Runnable |
| `prepare` | Runnable |
| `evidence` | Runnable |
| `adjudicate` | Runnable, uncalibrated |
| `report` | Runnable, deterministic |

What each stage ships today. [pipeline.md](./pipeline.md) has the full stage contracts.

### `discover`

- Enumerates the whole citing neighborhood (metadata only, safety cap 10,000). A malformed OpenAlex work is excluded individually. Page provenance records its row position, available ID and validation errors, and coverage uses the provider's original total.
- Stratifies the probe set over the whole neighborhood and records each stratum's inclusion probability.
- Harvests probed papers `fetchConcurrency` at a time.
- Emits one seed occurrence per exact citation group, carrying the parser's own `locationQuality`. JATS and GROBID bundle metadata joins adjacent reference markers across citation separators and stops at intervening prose.
- Records each citing paper's access channel and bibliography match method.
- Ranks full-text candidates by version and format. Acquisition provenance records the selected URL and the evidence for its version. Known arXiv identifiers supply direct PDF candidates, with separate cache entries for explicit revisions.
- Exact-verifies claim support spans into offset-bound `supportSpan` fields, and reattaches claims to a unique exact marker within their span before clustering. Original extraction lineage and explicit reattachment decisions are retained; downstream bundle metadata follows the corrected occurrence.
- At both citation hops, a quote that echoes the prompt's marker highlighting can be recovered when removing that exact pair yields a unique literal passage at the highlighted source position. The stored offsets and text come from the paper.
- Rejects known attachment URLs during acquisition and cache reuse. JATS bibliography identifiers also read `ext-link` targets when `pub-id` is absent.
- Clusters paraphrased claims across citers into one candidate per seed finding.
- Annotates candidates and selects an adaptive 15–25 family portfolio under a prepared-record budget.
- Grounding is deferred.

### `scope`

- Accounts for every Discover candidate.
- Freezes exact family and occurrence membership.
- Materializes seed text once per seed.
- Records verified grounding without excluding a family.
- Inventories central takeaways and detailed results from the seed's own work. It verifies supporting text and quoted qualifiers, links detailed results to takeaways, and records the source version. Every extracted citing claim gets a statement, including those outside the fidelity portfolio. Eligible statements get a separate assessment of what they retain or change.

### `prepare`

- Produces one stable record for every scoped family × citation occurrence, with complete and occurrence-local claim membership plus typed classification.
- Stores family, seed, candidate, claim, and citing-paper data once on the payload. Records refer to them by id.
- Runs a free deterministic regex pass first. Only its `unclear` verdict reaches `prepare.roleClassifierModel` (Haiku by default).
- Queues records for manual review when they lack a verified support span, or when neither pass can settle the role.

### `evidence`

- Retrieves over immutable Scope seed text with occurrence-local BM25 queries (family-claim fallback), reciprocal-rank fusion, and content-hash reuse.
- Reranks with an immutable relevance-rerank version. It is on by default and sees section role and third-party-citation flags.
- Grounding pins lead the selection.
- Skips reranking, with a typed reason, when pins fill every selected slot.
- Emits one outcome per Prepare record.

### `adjudicate`

- Applies deterministic gates, including broken citation-scope markers and missing verified spans.
- Makes one categorical model call per eligible record.
- Emits `F`/`D`/`E`/`U` or a typed non-verdict, plus evidence-sufficiency diagnostics.
- `D` outcomes also carry categorical `mutationKinds` and a `direction`.
- By default the model reads the whole seed text as a cached prompt prefix, and its verdict rests on quotes verified against that text.
- `selected_chunks`, or an over-long seed text, falls back to the chunks Evidence selected.
- Manual-review roles are not auto-broadened to the model.

### `report`

- Verifies the five upstream artifacts.
- Writes authoritative JSON containing:
  - `familyMutations`: each seed finding with its citing restatements in order, verdicts, and mutation kinds;
  - funnel, rate, and trace accounting:
    - unique claim units and per-unique-unit verdict rates;
    - F/D/E/U rates weighted over the sampling frame by inverse probe inclusion probability, beside the unweighted sample rates;
    - probe strata with frame sizes and inclusion probabilities;
    - the provider-reported neighborhood total and its coverage;
    - access channel, materialization and harvest loss reasons, and bibliography match method;
    - verdicts by evidence regime, support-span coverage, and evidence-sufficiency diagnostics;
    - portfolio deferrals and manual-review splits;
  - `selectionAudit`: per-candidate portfolio scores;
  - per-record citation-role signals.
- Renders Markdown from that JSON.

Run with:

```bash
npm run dev -- pipeline --input path/to/dois.json
npm run dev -- pipeline --input path/to/dois.json --stop-after evidence
npm run dev -- pipeline --run-id <uuid>
npm run dev -- runs:gc --dry-run   # superseded stage attempts + unreferenced provenance
npm run test:live-smoke   # optional; requires PALIMPSEST_LIVE_SMOKE=1 and credentials
```

Unknown CLI flags and stage names are ordinary invalid input. `--stop-after` and `--rerun-from` accept only the six stage keys.

Live smoke (`tests/live/`, `npm run test:live-smoke`) is manual/nightly and non-blocking for normal CI. The recorded replay fixtures under `fixtures/pipeline/replay/` exercise paywall, bundled-reference, and repeated-marker cases without network calls.

## Landed, still unmeasured

- **Citation-role model fallback.**
  - The deterministic regex pass runs first, and only its `unclear` verdict reaches `prepare.roleClassifierModel` (Haiku).
  - When a specific finding also motivates a method or framing, the fallback rubric prefers substantive attribution.
  - The loss this pass targets has not been re-measured.
- **Structured outputs.**
  - Every model call uses provider-enforced structured output.
  - The provider receives a constraint-free copy of the schema (Anthropic rejects bounds, `oneOf`, and defaults), and the reply is validated locally against the full Zod schema.
  - A reply that fails the schema or is cut off at the token cap is not retried. Its tokens are still recorded in the ledger and its raw text lands in the failure record.
  - Open questions, each needing one seed re-run: whether Opus adjudicates as well under native structured output, and whether `adjudicate.effort: medium` agrees with `high`.
- **Durable centralized telemetry.**
  - One append-only trace journal captures stage/tool operations, every HTTP attempt, Anthropic retries and cache hits, and Jev requests. Starts, raw responses and usage are flushed immediately; prompts and response payloads are content-addressed beside the journal.
  - Anthropic records preserve requested/served models, provider ids, raw usage, cache TTL details and versioned estimated pricing. New exact-cache entries link to their original call (migration 0017).
  - Cost summaries and the UI read this journal. `trace --root <run-or-experiment-directory> --calls` audits saved work offline, including unknown costs, unpriced external calls, incomplete operations and torn appends. Summary-only historical runs require a fresh run for audited work.
  - Mock-network tests cover the real SDK path, retries, paid invalid outputs, cache provenance and shared batch replies. A SIGKILL test verifies that starts and received-response checkpoints survive process death. No paid run is required for these checks.
  - `--max-cost` uses the known subtotal, including earlier attempts. Missing provider usage and work already in flight mean it remains approximate.
- **Side-by-side model calls.**
  - Extraction, grounding, reranking, and adjudication run `modelConcurrency` requests at once (default 6, `--model-concurrency`).
  - Artifacts are identical at any concurrency; only wall time changes.

## Scaling to heavily cited seeds (November 2026)

- **Whole-neighborhood sampling.**
  - Discover lists every citing work before probing. Listing a few thousand citers takes about 15 metadata requests at 200 per page.
  - The probe set is drawn from all of them instead of from the provider's first 200, which skewed old.
  - Sampling covers the frame of works not marked closed or abstract-only, stratified by year band × type group (article, review, other).
  - Each probe goes to the stratum where a probed work stands for the most frame works, so a 100-probe sample tracks the frame's year mix closely and the large strata end up with similar inclusion probabilities.
  - Report's `weightedRates` estimate F/D/E/U over the frame with 1/π weights. The unweighted rates remain the observed sample.
- **Prepare stores family data once.**
  - Candidates, claims, and the Scope family sit once on the payload, and records refer to them by id.
  - A seed with large families therefore does not multiply family size by record count.
- **Parallel harvest.**
  - Citing papers are fetched and parsed `discover.fetchConcurrency` at a time (default 6, `--fetch-concurrency`).
  - The artifact is byte-identical at any value.
- **Batch transport.**
  - `pipeline --batch` sends model requests through the Message Batches API at half price, as a `fetch` under the provider, so requests, validation, and artifacts are unchanged.
  - Submitted requests are recorded (migration 0014), so a crash or resume takes a pending batch's result instead of paying twice.
  - `--max-cost` reserves an expected cost per queued request (about 2.3 times real cost on whole-paper adjudication).
  - Shared prefixes use the 1-hour cache TTL.
  - `db:gc` prunes request rows past the 29-day results retention.
  - Tested against a mocked API only; no real batched run yet.
- **Census runs.**
  - `--census` probes every enumerated citer (`probeBudget: "all"`).
  - It keeps every candidate as a family (`candidateSelection.mode: "all"`, every disposition still in the ledger with its reason).
  - The UI new-run form offers both.
- **Blocked claim clustering.**
  - A seed whose claims exceed one request (150) is clustered in two levels: exact-text units, BM25-similar blocks of at most 150 clustered side by side, and merge rounds over one representative per cluster.
  - Candidates record `equivalence.method: "blocked_model"` with every block and merge request that judged them.
  - On 4,000 synthetic claims over 300 findings it took 31 requests (28 blocks of 81–150 units, one merge round of 3) and gave identical families at concurrency 1 and 8.
  - Not yet run against real claims at that size.
- **Summarized report.**
  - Above 200 records the Markdown summarizes each family with two examples per verdict and points to the JSON.
  - A synthetic 3,000-record, 120-family report is about 4,400 lines instead of about 16,000.
  - The Report inspector's families now refer to rows by id instead of copying them. That payload went from about 24 MB to 16 MB, and the families part from 8.3 MB to 0.3 MB.
  - The inspector renders restatements 50 at a time.
- **Census-scale fixes.**
  - Prepare's role classifier runs `modelConcurrency` at a time.
  - GROBID parses at most `GROBID_CONCURRENCY` PDFs at once (default 2).
  - Adjudicate's artifact check matched each record against every provenance entry, which made building and loading a 3,000-record chain take minutes. It now indexes them.
- **Blinded review.**
  - The Review tab opens with machine judgment hidden, the reviewer records their own label, and agreement is derived at export time.
  - The CSV export collapses to claim units.
  - Local labels do not calibrate Adjudicate, so `calibrationStatus` stays `uncalibrated`.
  - Author review: `author-review:export` writes one offline HTML file asking the seed's author to judge every flagged restatement and a few faithful ones, blind until each answer; `author-review:import` stores the returned answers beside the report.
- **Citation targeting and pin-filled packets.**
  - Markers are anchored to exact verified support spans and the occurrence's own marker position before the window is cut; only an occurrence the parser could not locate exactly falls back to the resolved reference.
  - An unverified target stays unmarked and is gated to manual review.
  - When verified grounding pins fill every selected slot, Evidence skips the reranker, keeps that pin-only packet, and Report counts the skip.
  - A descriptive findings section after Methods is treated as results when the parser omitted the parent heading.

### Evaluation harness

- A local evaluation harness freezes a finished report into cases under `data/evaluations/`, imports that report's review history and its seed author's answers as labels, and runs blind annotation plus resumable provider comparisons.
- Datasets, trials, and scores stay on disk.
- The UI grades one case at a time from the keyboard.
- `eval request` saves a named set of cases that shows up in the UI as waiting until each has a final label.
- See [evaluation.md](./evaluation.md).

Built for evaluation:

- **Constructed cases** (`eval dataset --mutations`). They edit restatements a human labelled `F` so the expected verdict is known: distortions count missed distortions, and wording-only controls count false alarms.
- **A repeat-agreement figure** for run-to-run noise.
- **Whole-paper adjudication** (`adjudicationEvidence: "seed_text"`). It gives the adjudicator the seed's full text as a cached prefix and verifies the quotes it relies on.

A comparison of three models on one seed used all three:

- One seed with one reviewer calibrates nothing.
- On that comparison, production Adjudicate now reads the whole seed text with `claude-sonnet-5-5` at `high` effort.
- The Report counts whole-paper verdicts, those quoting a passage Evidence did not select, and those where a quote failed verification.
- The client and price table now know `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`.
- The run-config defaults now name the current models: `claude-haiku-5-5` for extraction, role classification and reranking, and `claude-sonnet-5-5` for clustering, grounding and adjudication at `high` effort.

## Scientific status

Adjudicate is **uncalibrated**. Successful execution does not validate its judgments, establish accuracy, or support trust claims. Blinded human calibration and separate evaluation reporting remain required.

The DOI-first pipeline supports single-hop statement tracking and an optional second hop through `pipeline --history --max-cost <usd>`. The standalone `citation-history` command starts with a verified Report. History extracts each use of the intermediate paper independently of the original finding. It assesses the documented route, the downstream wording against the original, and citation fidelity against the immediate source. The model sees exact marker positions and bibliography entries for the first-hop paragraph, so an intermediate author’s synthesis can be traced to separately credited premises. Results retain exact evidence, co-citation, access and budget outcomes, and model provenance.

The current citation-history implementation recovered both registered paths in two consecutive fresh runs of a fixed two-hop benchmark. Sensitivity across unfamiliar seeds and broader citation neighborhoods remains unmeasured.

Scope, Prepare, Evidence, and Adjudicate retain complete record accounting: every record a stage receives has an outcome.

## Storage and cleanup

Paper storage is `paper_cache` / `paper_parsed`. `db:gc --days <n> [--dry-run]` deletes aged analysis-run registry rows and stale LLM exact-result cache rows from SQLite; it does not delete artifact directories. `runs:gc [--run-id <uuid>] [--dry-run]` handles the on-disk side: superseded stage attempts the run registry no longer points at, and the provenance blobs only those attempts referenced. Evaluation commands operate on separate frozen datasets under `data/evaluations/`.

The SQLite column `analysis_run_stages.family_index` is part of an immutable migration primary key; execution always writes `0` (one row per stage).

## Local UI

`apps/ui` is a local-only launcher and inspector for the pipeline. It creates DOI-first runs, launches `pipeline --run-id <uuid>`, presents the six logical stages, and reads typed inspector payloads. It is not a hosted product.

The Report explorer has Overview, Families, Statements, Citation history, Records, Review, and Audit trail views. Statements show the source finding beside the exact citing wording and citation credit. Citation history opens verified sidecars bound to the active Report. The explorer shows the uncalibrated interpretation warning and uses adjudicated records as the fidelity-rate denominator.

Human review is a post-report sidecar, not a seventh stage. Reviews append under `data/runs/<runId>/review/<reportArtifactId>/events.json`, bound to the current Report artifact ID/content hash, and never overwrite machine artifacts. The Review tab exports JSON/CSV calibration datasets from that lineage.

## Cross-cutting implementation

- All external boundaries are Zod-validated.
- Artifacts are content-hashed, lineage-bound envelopes; one written by an earlier version of the code is not read.
- Resume reloads and verifies every succeeded ancestor; missing, invalid, tampered, or mismatched artifacts fail rather than silently recompute.
- PDF parsing uses GROBID after PDF validation. HTTP 500 and missing body text can trigger one traced retry using a text layer rebuilt with Poppler and Tesseract. If the PDF has embedded text, the retry can restore a damaged numeric suffix where the surrounding words and leading digits agree. Legible numbers and citation markers are preserved. Seed PDFs may be supplied with `--seed-pdf`.
- Report rates distinguish adjudicated `F`/`D`/`E`/`U` outcomes from operational non-verdicts.
- The own-finding inventory has its own prompt version under `seed-grounding`. The shared statement matcher records `seed-claim-matching` for Scope and `chain-claim-matching` for history.

Run retention: `runs:keep --run-id <uuid> [--reason <text>]` exempts a run from both `runs:gc` and `db:gc`; `--release` removes that exemption. History-bound Reports, their input artifacts and their referenced provenance survive collection of superseded stage attempts.
