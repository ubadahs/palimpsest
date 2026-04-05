# Artifact Workflow

## Purpose

The CLI writes JSON artifacts as the canonical machine outputs for each stage. Those artifacts are now:

- schema-validated on load
- accompanied by adjacent manifest files
- suitable for benchmark blind/diff/apply workflows

`data/` should be treated as **generated run output**, not as source of truth. Curated examples and fixtures belong under `fixtures/` or a dedicated sample path.

## Primary Pipeline Artifacts

Each command writes a primary JSON artifact plus one or more human-readable companions:

- `pre-screen` → `*_pre-screen-results.json` + Markdown report
- `m2-extract` → `*_m2-extraction-results.json` + report + inspection artifact
- `m3-classify` → `*_classification-results.json` + report
- `m4-evidence` → `*_evidence-results.json` + report
- `m5-adjudicate` → `*_calibration-set.json` + worksheet
- `m6-llm-judge` → `*_llm-calibration.json` + summary, optionally agreement report

Each primary JSON artifact also gets:

- `*_manifest.json`

## UI Run Layout

The local UI stores run-scoped output under:

- `data/runs/<runId>/inputs/`
- `data/runs/<runId>/01-pre-screen/`
- `data/runs/<runId>/02-m2-extract/`
- `data/runs/<runId>/03-m3-classify/`
- `data/runs/<runId>/04-m4-evidence/`
- `data/runs/<runId>/05-m5-adjudicate/`
- `data/runs/<runId>/06-m6-llm-judge/`
- `data/runs/<runId>/logs/`

The UI does not rename or reshape canonical artifact filenames. It points each stage row at the latest successful primary/report/manifest artifact already emitted by the CLI.

## Stage Pointer Semantics

- reruns append new files in the same stage directory
- prior artifacts are retained in place
- the stage registry row points at the latest attempt only
- when an upstream stage reruns successfully, downstream `succeeded` stages are marked `stale`
- stale downstream stages clear their current artifact pointers so the UI does not present them as current output

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

Stage inputs are loaded through shared artifact validation:

- JSON must parse successfully
- the parsed payload must satisfy the stage schema
- failures report the artifact path and the first invalid field path

This validation applies to:

- pre-screen shortlist input
- M2/M3/M4/M5/M6 upstream JSON artifacts
- benchmark delta inputs
- benchmark compare inputs

Historical artifacts remain loadable as long as their payload shape is still compatible with the current schema.

## Parsing and Evidence Artifacts

The M2 and M4 artifacts now carry more structured parsing and retrieval metadata.

### Parsed full text

New runs normalize JATS XML and GROBID TEI into one internal parsed-document shape with:

- `parserKind`
- `fullTextFormat`
- `blocks`
- `references`
- `mentions`

Historical artifacts that still reference legacy `pdf_text` content remain loadable. New PDF-backed runs should emit `grobid_tei_xml`.

### Evidence spans

Evidence spans now include retrieval metadata needed for auditability and debugging:

- `blockKind`
- `bm25Score`
- optional `rerankScore`
- `matchMethod`

`matchMethod` distinguishes BM25-only retrieval from reranked retrieval.

### Retrieval statuses

Task-level evidence retrieval statuses now distinguish:

- `retrieved`
- `no_matches`
- `abstract_only_matches`
- `no_fulltext`
- `unresolved_cited_paper`
- `not_attempted`

`abstract_only_matches` is deliberate. It means lexical matching only surfaced abstract material, so the task is treated as ungrounded rather than silently upgraded to normal retrieved evidence.

## Benchmark Workflow

The benchmark workflow is intentionally append-only and artifact-driven.

### 1. Create a blind benchmark export

Use:

```bash
npm run dev -- benchmark:blind --input path/to/calibration.json
```

This removes adjudication outcome fields from active records while preserving record order and task identity.

Excluded records are carried through unchanged so benchmark exports do not erase existing exclusion decisions.

### 2. Collect an external or independent pass

The blind artifact should be treated as immutable once handed off.

### 3. Diff two adjudication datasets

Use:

```bash
npm run dev -- benchmark:diff --base path/to/base.json --candidate path/to/candidate.json
```

This produces:

- a machine-readable diff JSON
- a Markdown summary keyed by `taskId`

The diff compares:

- verdict changes
- rationale changes
- retrieval-quality changes
- exclusion changes
- missing or extra records

Adjudication-field differences on excluded records are ignored in diff scoring. Exclusion-state changes are still reported.

### 4. Summarize multiple benchmark candidates

Use:

```bash
npm run dev -- benchmark:summary \
  --base path/to/base.json \
  --candidate opus-no-thinking=path/to/opus.json \
  --candidate sonnet-thinking=path/to/sonnet.json
```

This produces:

- a machine-readable benchmark summary JSON
- a Markdown ranking table plus per-candidate detail

The summary scores only active, non-excluded base records with adjudicated verdicts. It reports:

- exact agreement
- adjacent agreement with `supported` and `partially_supported` collapsed
- verdict-change count
- changed task IDs
- missing task IDs

### 5. Apply approved deltas

Use:

```bash
npm run dev -- benchmark:apply --base path/to/base.json --delta path/to/delta.json
```

The delta file updates records by `taskId` only. It may not add, remove, or reorder records.

Excluded records remain unchanged unless the delta explicitly opts into excluded-record changes.

## Data Policy

- `data/` is generated output and should be disposable
- curated examples should not be mixed with live run directories
- if a run needs to be preserved for tests or documentation, copy the minimum required artifact into `fixtures/` or an explicit examples directory
