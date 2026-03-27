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

## Benchmark Workflow

The benchmark workflow is intentionally append-only and artifact-driven.

### 1. Create a blind benchmark export

Use:

```bash
npm run dev -- benchmark:blind --input path/to/calibration.json
```

This removes adjudication outcome fields from records while preserving record order and task identity.

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

### 4. Apply approved deltas

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
