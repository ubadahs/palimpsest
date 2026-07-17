# Artifact Workflow

Canonical runs write a validated, lineage-bound artifact chain:

```text
Discover → Scope → Prepare → Evidence → Adjudicate → Report
```

Each artifact is current-version-only, content-hashed, and reloaded after writing before it is used downstream. Old seven-stage-executor artifacts are unsupported and are never converted or used as compatibility inputs.

## Run layout

```text
data/runs/<runId>/
  inputs/
    dois.json
    run-config.json
  00-discover/
  01-scope/
  02-prepare/
  03-evidence/
  04-adjudicate/
  05-report/
  provenance/
  logs/
  cost-summary.json
```

Stage directories contain append-only, time-sortable attempts named `<timestamp>_<nonce>_<artifactId>_canonical-<stage>.json`; rerunning identical semantic work keeps the same artifact ID but writes a distinct attempt path. Report JSON and Markdown share the same attempt stem. Every primary JSON has a manifest, and the run registry points to the current JSON, manifest, and Report Markdown.

`inputs/run-config.json` is the current convenience copy. Every distinct canonical config is also stored immutably under `provenance/`, and each stage envelope binds the exact config artifact used for that attempt. Provenance filenames use semantic provenance artifact IDs, so identical bodies stored under different roles cannot overwrite each other.

## Artifact chain

| Stage | Primary output | Direct inputs |
|---|---|---|
| `discover` | Canonical Discover envelope | DOI input and recorded external/model provenance |
| `scope` | Canonical Scope envelope | Verified Discover |
| `prepare` | Canonical Prepare envelope | Verified Scope and exact Discover ancestor |
| `evidence` | Canonical Evidence envelope | Verified Prepare and exact Scope ancestor |
| `adjudicate` | Canonical Adjudicate envelope | Verified Evidence and exact Prepare ancestor |
| `report` | Canonical Report JSON and Markdown | Verified Discover, Scope, Prepare, Evidence, and Adjudicate |

Discover records a lossless source ledger; Scope freezes membership; Prepare preserves every family × occurrence record; Evidence preserves every retrieval outcome; Adjudicate preserves every gate/model outcome; Report reconciles the complete chain.

No stage reads or writes a shortlist, screen, extract, classify, curate, audit-sample, advisor, or vector-routing artifact. There is no sampling handoff.

## Validation and resume

Artifact readers validate JSON shape, stable IDs, internal references, content hashes, and direct lineage. Resume reloads the already-succeeded prefix and refuses missing, malformed, tampered, cross-run, or mismatched inputs rather than silently recomputing them.

## Data compatibility

Old local SQLite rows and `data/runs/` directories created by the seven-stage executor are unsupported. Delete or recreate them before running the canonical pipeline. Keep scientific raw inputs and provenance where useful, but do not bridge old operational artifact formats into the canonical chain.

## Interpretation

Canonical Report is the authoritative accounting artifact. Canonical Adjudicate is runnable but **uncalibrated**: its `F`/`D`/`E`/`U` outputs require blinded human calibration before they support validation or trust claims.
