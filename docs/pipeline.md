# Pipeline Guide

This document describes the current operational workflow: what each stage is for, what it reads, what it writes, and what can block or downgrade it. For research intent and scope, see [concept-memo.md](./concept-memo.md) and [prd.md](./prd.md).

## At A Glance

Palimpsest has one canonical seven-stage pipeline:

1. `discover`
2. `screen`
3. `extract`
4. `classify`
5. `evidence`
6. `curate`
7. `adjudicate`

You can run that workflow end to end with `pipeline`, or run the stages individually against upstream artifacts.

| Stage | Command | Reads | Writes | Main decision |
|------|---------|-------|--------|---------------|
| Discover | `discover` | DOI input JSON | discovery results, report, shortlist | Which claims are promising enough to screen |
| Screen | `screen` | shortlist JSON | pre-screen results, report, grounding trace | Whether a claim family is viable and whether downstream analysis is blocked |
| Extract | `extract` | screen results + seed DOI | extraction results, report, inspection notes | Which citing contexts are usable for downstream grounding |
| Classify | `classify` | extraction results + screen results | classification results, report | Which extracted mentions become evaluation tasks |
| Evidence | `evidence` | classification results | evidence results, report | Whether usable cited-paper evidence can be attached to each task |
| Curate | `curate` | evidence results | calibration set, worksheet | Which evidence-backed tasks enter the adjudication sample |
| Adjudicate | `adjudicate` | calibration set | adjudicated calibration set, summary, optional agreement report | Final support-style verdicts and rationales for sampled tasks |

## Two Ways To Start A Run

### DOI-first run

Use this when discovery should run from a seed DOI list (default strategy is **attribution-first**: citing-side mentions and grounded families; **legacy** still extracts seed-side claim units and can rank by engagement).

- Entry command: `discover` or `pipeline --input path/to/dois.json`
- Input shape: a JSON object with a `dois` array
- Typical use: exploratory runs where the tracked claim is not fixed yet

This is the normal CLI-first path.

### Shortlist or manual-claim run

Use this when the tracked claim is already known and you want to start from screening.

- Entry command: `screen --input path/to/shortlist.json`
- Pipeline variant: `pipeline --shortlist path/to/shortlist.json`
- UI variant: if a manual tracked claim is provided when creating a run, the UI writes `inputs/shortlist.json` directly and marks `discover` as already satisfied

This is the shortest path when claim discovery is not the question.

## Stage Names And Artifact Names

Canonical stage names are the stage keys exposed in the CLI, UI, and SQLite state:

- `discover`
- `screen`
- `extract`
- `classify`
- `evidence`
- `curate`
- `adjudicate`

Some artifact filenames still preserve older prefixes:

- `screen` writes `_pre-screen-*`
- `extract` writes `_m2-extraction-*`

Those filenames are intentional compatibility details. Treat the stage key as the canonical name and the artifact suffix as the storage contract.

## Stage Details

### Discover

Purpose: turn one or more seed DOIs into concrete, screenable claim candidates by observing how the literature actually cites the seed paper.

Command: `discover`

Reads:

- DOI input JSON

Writes:

- `*_discovery-results.json`
- `*_discovery-report.md`
- `*_discovery-shortlist.json`
- sidecars: `*_discovery-neighborhood.json`, `*_discovery-probe.json`, `*_discovery-mentions.json`, `*_discovery-attributed-claims.json`, `*_discovery-family-candidates.json`, `*_discovery-grounding-trace.json`

What happens (attribution-first strategy, `--strategy attribution_first`):

- resolve the seed paper by DOI
- gather the citing neighborhood from OpenAlex
- select a bounded probe set of citing papers with accessible full text
- harvest in-text mentions of the seed paper from probe papers
- extract attributed claims from those mention contexts via LLM
- construct singleton family candidates (one per in-scope attributed claim)
- ground each family candidate back to quoted seed-paper spans
- score families by observable viability (mention count, auditable edges, grounding status)
- emit a shortlist ready for `screen`

The legacy strategy (`--strategy legacy`) is still available and follows the older seed-side claim extraction and ranking path.

Additional flags: `--probe-budget` (max probe papers, default 20), `--shortlist-cap` (max shortlisted families, default 10).

What can block it:

- unresolved DOI
- no usable full text for the seed paper
- missing `ANTHROPIC_API_KEY`
- no auditable citing papers in the probe set (attribution-first)

What the next stage consumes:

- the shortlist artifact

### Screen

Purpose: ground the tracked claim in the seed paper, gather the local citation family, and decide whether the family is worth pushing into the heavier stages.

Command: `screen`

Reads:

- shortlist JSON

Writes:

- `*_pre-screen-results.json`
- `*_pre-screen-report.md`
- `*_pre-screen-grounding-trace.json`

What happens:

- resolve the seed paper
- fetch and parse seed full text
- ground the tracked claim with the LLM and verify quoted spans
- gather citing papers around the seed
- deduplicate and filter the family to claim-relevant papers
- assess auditability and produce a greenlight or deprioritize decision

What can block or downgrade it:

- missing `ANTHROPIC_API_KEY`
- missing or unusable seed full text
- claim grounding that fails or blocks downstream analysis
- a family that is too thin or too unauditable to justify later stages

Important behavior:

- `screen` can succeed and still block later stages
- papers outside the grounded claim family remain visible in reports but are excluded from downstream analysis

What the next stage consumes:

- the screen results artifact, for one seed family at a time

### Extract

Purpose: find the claim-bearing citation contexts in the citing papers that survived screening.

Command: `extract`

Reads:

- screen results
- seed DOI selector

Writes:

- `*_m2-extraction-results.json`
- `*_m2-extraction-report.md`
- `*_m2-inspection.md`

What happens:

- select auditable citing papers
- fetch and parse citing-paper full text
- locate the in-text mentions that point back to the seed paper
- deduplicate redundant mentions
- keep only contexts that can support later evidence grounding

What can block or downgrade it:

- screen already marked the family as blocked downstream
- citing papers have no usable full text
- citations resolve but do not yield usable claim-bearing contexts

What the next stage consumes:

- the extraction results artifact

### Classify

Purpose: turn extracted citation contexts into evaluation packets that downstream retrieval and adjudication can use.

Command: `classify`

Reads:

- extraction results
- screen results

Writes:

- `*_classification-results.json`
- `*_classification-report.md`

What happens:

- classify citation roles from the extracted mentions
- derive the evaluation mode for each mention or edge
- build `EdgeEvaluationPacket` structures for downstream retrieval
- summarize the task load and any manual-review-heavy cases

What can block or downgrade it:

- no usable extracted mentions
- extracted contexts exist but do not yield any in-scope evaluation tasks

What the next stage consumes:

- the classification results artifact

### Evidence

Purpose: resolve the cited paper, retrieve candidate evidence from it, and attach grounded spans to each evaluation task.

Command: `evidence`

Reads:

- classification results

Writes:

- `*_evidence-results.json`
- `*_evidence-report.md`

What happens:

- resolve the cited paper
- fetch and parse cited-paper full text
- retrieve candidate evidence blocks with BM25
- optionally rerank those blocks with the LLM or a local reranker
- attach the best evidence spans to each task

What can block or downgrade it:

- unresolved cited paper
- cited full text unavailable
- no evidence matches
- abstract-only matches, which are treated as downgraded rather than ordinary retrieval success

Important behavior:

- BM25 always provides the baseline retrieval pass
- if Anthropic is configured and LLM reranking is enabled, the stage uses an LLM reranker by default
- if no Anthropic key is available, the stage can still run with a local reranker or plain BM25
- `--no-llm-rerank` forces the non-LLM path

What the next stage consumes:

- the evidence results artifact

### Curate

Purpose: build a balanced calibration set from the evidence-backed task pool.

Command: `curate`

Reads:

- evidence results

Writes:

- `*_calibration-set.json`
- `*_calibration-worksheet.md`

What happens:

- collect eligible tasks
- surface edge cases
- allocate a mode-balanced sample
- build adjudication-ready calibration records
- write the worksheet and sampling summary

What can block or downgrade it:

- no eligible evidence-backed tasks
- too little variety to build the requested sample cleanly

What the next stage consumes:

- the calibration set artifact

### Adjudicate

Purpose: run the sampled calibration records through the configured model and write final verdicts and rationales.

Command: `adjudicate`

Reads:

- calibration set

Writes:

- `*_llm-calibration.json`
- `*_llm-summary.md`
- optional `*_agreement-report.md`

What happens:

- load active calibration records
- adjudicate them with the configured model
- persist verdicts, rationales, confidence, and retrieval-quality judgments
- summarize the verdict distribution

What can block it:

- missing `ANTHROPIC_API_KEY`
- no active calibration records

What follows it:

- benchmark commands such as `benchmark:blind`, `benchmark:diff`, `benchmark:summary`, and `benchmark:apply`

## How The Pieces Fit Together

Some stages are batch-oriented and some are family-oriented.

- `discover` can start from multiple seed DOIs
- `screen` evaluates one or more shortlisted seed claims
- `extract`, `classify`, `evidence`, `curate`, and `adjudicate` operate per screened claim family; the full `pipeline` runs those stages for **all greenlit families**, with concurrency bounded by stored config `familyConcurrency` (CLI: `--family-concurrency`)

The `pipeline` command handles that handoff for you. The local UI spawns `pipeline --run-id …`, reuses the same artifact layout, and records **one SQLite stage row per `(stageKey, familyIndex)`** so parallel families do not overwrite each other’s status or paths.

When `pipeline` writes artifacts, it mirrors the canonical stage layout under the chosen output root (`00-discover/`, `01-screen/`, `02-extract/`, and so on) and preserves the same stage-specific filename suffixes used by the standalone commands.

## What To Update When The Workflow Changes

Update this document when any of the following change:

- stage order
- stage names
- stage inputs or outputs
- what a stage is responsible for deciding
- block, fallback, or downgrade behavior that matters to an operator

If only a model default or implementation detail changes, prefer updating [status.md](./status.md) instead.
