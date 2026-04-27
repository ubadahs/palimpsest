# Artifact Workflow

This document defines the storage contract for Palimpsest artifacts: what files each stage emits, how runs are laid out on disk, and how the UI tracks the latest outputs.

`data/` is generated output, not source of truth. Preserve only the smallest artifacts you actually need for tests or examples.

## Core Principles

- JSON artifacts are the canonical machine outputs
- primary JSON artifacts get adjacent manifest files
- Markdown companions are for inspection, not for machine integration
- diagnostic sidecars preserve provenance and debugging context, but most are not consumed by downstream stages
- artifact loading is schema-validated
- reruns are append-only; the newest successful artifact becomes the current pointer

## Artifact Roles

Artifacts fall into four roles:

| Role | Meaning |
|------|---------|
| `primary` | Canonical machine output for a stage, or a machine handoff consumed by a later stage |
| `report` | Human-readable Markdown inspection output |
| `diagnostic` | Provenance, trace, debugging, or review-support output that is not the main downstream contract |
| `manifest` | Reproducibility metadata written beside each primary JSON artifact |

The simple operator model is:

```text
discover produces candidate families
screen produces qualified families
extract produces citation contexts
classify produces evaluation tasks
evidence produces evidence-backed tasks
curate produces audit records
adjudicate produces adjudicated records
```

The additional sidecars make those transitions inspectable; they do not add extra pipeline stages.

## Canonical Stage Outputs

Use the stage key as the canonical name. Some artifact suffixes intentionally preserve older prefixes for compatibility.

| Order | Stage key | CLI command | UI run directory | Primary machine output | Report | Companion artifacts |
|------|-----------|-------------|------------------|------------------------|--------|---------------------|
| 0 | `discover` | `discover` | `00-discover/` | `*_discovery-results.json`; `*_discovery-shortlist.json` is the downstream shortlist handoff | `*_discovery-report.md` | Diagnostic: `*_discovery-neighborhood.json`, `*_discovery-probe.json`, `*_discovery-mentions.json`, `*_discovery-attributed-claims.json`, `*_discovery-family-candidates.json`, `*_discovery-grounding-trace.json` |
| 1 | `screen` | `screen` | `01-screen/` | `*_pre-screen-results.json` | `*_pre-screen-report.md` | Diagnostic: `*_pre-screen-grounding-trace.json` |
| 2 | `extract` | `extract` | `02-extract/` | `*_m2-extraction-results.json` | `*_m2-extraction-report.md` | Diagnostic: `*_m2-inspection.md` |
| 3 | `classify` | `classify` | `03-classify/` | `*_classification-results.json` | `*_classification-report.md` | none |
| 4 | `evidence` | `evidence` | `04-evidence/` | `*_evidence-results.json` | `*_evidence-report.md` | none |
| 5 | `curate` | `curate` | `05-curate/` | `*_audit-sample.json` | `*_audit-sample-worksheet.md` | none |
| 6 | `adjudicate` | `adjudicate` | `06-adjudicate/` | `*_llm-audit-sample.json` | `*_llm-summary.md`; `*_agreement-report.md` when available | none |

Every primary JSON artifact also gets:

- `*_manifest.json`

The canonical program definition for stage keys, ordering, suffixes, and companion-artifact roles lives in [src/contract/stages.ts](../src/contract/stages.ts).

## Where Artifacts Are Written

### Stage commands

Each stage command writes timestamped files into its chosen output directory. The directory is append-only: reruns write new timestamped files instead of replacing older ones.

### `pipeline`

The `pipeline` command writes into one chosen output root, but it now mirrors the canonical per-stage layout used by UI runs:

- `00-discover/`
- `01-screen/`
- `02-extract/`
- `03-classify/`
- `04-evidence/`
- `05-curate/`
- `06-adjudicate/`

Within each stage directory, pipeline uses the same canonical filename suffixes as the standalone stage commands. Family-oriented stages write one artifact set per family inside that stage directory, for example `*_family-1_m2-extraction-results.json`.

Pipeline runs also emit a top-level `*_run-cost.json` file. This is a centralized run-level telemetry summary for all Anthropic calls in the run, including discovery, screen grounding/filtering, evidence reranking, and adjudication. The summary includes attempted, successful, failed, and billable call counts plus per-stage rollups. It also includes `byPurpose` per-purpose breakdowns (token counts, cost, and `exactCacheHits`) and `totalExactCacheHits` at the top level.

### UI runs

The local UI stores run-scoped data under:

- `data/runs/<runId>/inputs/`
- `data/runs/<runId>/00-discover/`
- `data/runs/<runId>/01-screen/`
- `data/runs/<runId>/02-extract/`
- `data/runs/<runId>/03-classify/`
- `data/runs/<runId>/04-evidence/`
- `data/runs/<runId>/05-curate/`
- `data/runs/<runId>/06-adjudicate/`
- `data/runs/<runId>/logs/`

The `inputs/` directory contains the run entry artifact:

- `dois.json` for DOI-first runs
- `shortlist.json` for manual-claim runs or runs that already have a shortlist

The UI does not rename or reshape canonical artifact filenames. It points each stage row at the latest successful primary, report, and manifest artifact already emitted by the CLI.

Per-stage log files live under `data/runs/<runId>/logs/` with the stage slug as the filename.

## Stage Pointer Semantics

- reruns append new files in the same stage directory
- prior artifacts are retained in place
- the stage registry row points at the latest attempt only
- when an upstream stage reruns successfully, downstream `succeeded` stages are marked `stale`
- stale downstream stages clear their current artifact pointers so the UI does not present them as current output

Manual-claim UI runs are a special case:

- `discover` is pre-marked as satisfied
- the run starts from `screen`
- `inputs/shortlist.json` is written up front

## Manifest Files

Manifest files record reproducibility metadata without changing the main payload shape.

Each manifest contains:

- `artifactType`
- `artifactVersion`
- `generatedAt`
- `generator`
- `sourceArtifacts`
- best-effort `gitCommit`
- optional `model`
- optional `relatedArtifacts`

`sourceArtifacts` include file paths and best-effort SHA-256 checksums when the source files are readable.

## Validation Rules

Artifact inputs are loaded through shared validation:

- JSON must parse successfully
- the parsed payload must satisfy the stage schema
- failures report the artifact path and the first invalid field path

This validation applies to:

- `discover` DOI input
- `screen` shortlist input
- upstream JSON artifacts passed into `extract`, `classify`, `evidence`, `curate`, and `adjudicate`
- benchmark delta and compare inputs

Historical artifacts remain loadable as long as their payload shape is still compatible with the current schema.

This includes:

- legacy pre-screen grounding traces keyed by DOI
- older discovery summaries without dedupe metadata
- older run-cost files that only recorded total cost and call count

## Parsing And Evidence Metadata

The `extract` and `evidence` artifacts carry structured parsing and retrieval metadata.

### Parsed full text

New runs normalize JATS XML and GROBID TEI into one internal parsed-document shape with:

- `parserKind`
- `fullTextFormat`
- `blocks`
- `references`
- `mentions`

Historical artifacts that still reference legacy `pdf_text` remain loadable. New PDF-backed runs should emit `grobid_tei_xml`.

### Full-text acquisition provenance

Artifacts that depend on fetched paper content now also carry acquisition provenance alongside the parsed document or paper source record.

The shared provenance shape includes:

- `materializationSource` (`network`, `raw_cache`, `parsed_cache`)
- `selectedMethod` (`biorxiv_xml`, `pmc_xml`, `landing_page_xml`, `direct_pdf_grobid`)
- `selectedLocatorKind` (`pmcid_metadata`, `pmcid_derived_url`, `doi_input`, `doi_resolved`, `direct_pdf_url`, `meta_pdf_url`, `meta_xml_url`)
- `selectedUrl`
- `fullTextFormat`
- ordered `attempts[]` with probe classification, URL, HTTP status, and failure reason when relevant

This provenance is the canonical answer to "how did we get this parsed paper?" and should be preferred over legacy cache fetch-status fields.

### Evidence spans

Evidence spans include retrieval metadata needed for auditability and debugging:

- `blockKind`
- `bm25Score`
- optional `rerankScore`
- `matchMethod`

`matchMethod` distinguishes BM25-only retrieval from reranked retrieval.

### Retrieval statuses

Task-level evidence retrieval statuses distinguish:

- `retrieved`
- `no_matches`
- `abstract_only_matches`
- `no_fulltext`
- `unresolved_cited_paper`
- `not_attempted`

`abstract_only_matches` is deliberate. It means lexical matching surfaced only abstract material, so the task is treated as downgraded rather than silently upgraded to ordinary retrieval success.

## Discovery And Screen Metadata

### Attribution-first dedupe metadata

Attribution-first discovery now writes dedupe metadata into family candidates and shortlist entries:

- dedupe status (`unique`, `canonical_exact`, `canonical_near_duplicate`)
- a stable dedupe group id
- merged family ids and merged canonical claims when a family absorbed duplicates

This is intentional and should stay visible in artifacts so the heuristic can be revisited later.

Shortlist emission also applies a **diversity filter** on citing-paper overlap (high Jaccard similarity on `memberCitingPaperIds` vs an already selected family). Families that rank highly but are skipped for overlap carry an explicit `shortlistReason` distinguishing them from cap-only exclusions.

### Pre-screen grounding trace shape

New pre-screen grounding traces use:

- `records[]`
- each entry carries `seedDoiKey` plus the full trace record

This avoids the old lossy `recordsBySeedDoi` map, which could overwrite multiple tracked claims that shared the same DOI. Legacy DOI-keyed traces are still readable through the current loader.

## Run-Scoped Reuse

Pipeline execution can reuse expensive work across equivalent families within the same run:

- attribution-first `discover` writes `inputs/discovery-handoffs.json` so `screen` and `extract` can reuse resolved seed metadata, citing-paper neighborhoods, harvested mentions, and family grounding traces on fresh runs and on resume when the bundle is available
- `extract` reuses citation-context extraction for identical citing-paper neighborhoods
- `classify` reuses packet construction for the same effective neighborhood inputs

Artifacts remain canonical per family even when computation was reused. The discovery handoff bundle is a reusable provenance artifact, not a replacement for stage primary JSON outputs. The extract/classify cache is run-scoped only. A separate persistent exact-result LLM cache (`llm_result_cache` table) provides cross-run reuse for identical LLM requests — see [caching.md](./caching.md) for details.

## Benchmark Workflow

The benchmark workflow is append-only and artifact-driven.

### 1. Create a blind benchmark export

```bash
npm run dev -- benchmark:blind --input path/to/audit-sample.json
```

This removes adjudication outcome fields from active records while preserving record order and task identity.

Excluded records are carried through unchanged.

### 2. Collect an external or independent pass

Treat the blind artifact as immutable once handed off.

### 3. Diff two adjudication datasets

```bash
npm run dev -- benchmark:diff --base path/to/base.json --candidate path/to/candidate.json
```

This produces:

- a machine-readable diff JSON
- a Markdown summary keyed by `taskId`

The diff reports:

- verdict changes
- rationale changes
- retrieval-quality changes
- exclusion changes
- missing or extra records

Adjudication-field differences on excluded records are ignored in diff scoring. Exclusion-state changes are still reported.

### 4. Summarize multiple benchmark candidates

```bash
npm run dev -- benchmark:summary \
  --base path/to/base.json \
  --candidate opus-no-thinking=path/to/opus.json \
  --candidate sonnet-thinking=path/to/sonnet.json
```

This produces:

- a machine-readable benchmark summary JSON
- a Markdown ranking table plus per-candidate detail

The summary scores only active, non-excluded base records with adjudicated verdicts.

### 5. Apply approved deltas

```bash
npm run dev -- benchmark:apply --base path/to/base.json --delta path/to/delta.json
```

The delta file updates records by `taskId` only. It may not add, remove, or reorder records.

Excluded records remain unchanged unless the delta explicitly opts into excluded-record changes.

## Data Policy

- `data/` is generated output and should be disposable
- curated examples should not be mixed with live run directories
- if a run needs to be preserved for tests or documentation, copy the minimum required artifact into `fixtures/` or an explicit examples directory
