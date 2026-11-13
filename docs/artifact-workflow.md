# Artifact Workflow

Runs write a validated, lineage-bound artifact chain:

```text
Discover → Scope → Prepare → Evidence → Adjudicate → Report
```

Each artifact is content-hashed and reloaded after writing before it is used downstream. An artifact written by an earlier version of the code is not read.

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

Stage directories contain append-only, time-sortable attempts named `<timestamp>_<nonce>_<artifactId>_<stage>.json`; rerunning identical semantic work keeps the same artifact ID but writes a distinct attempt path. Report JSON and Markdown share the same attempt stem. Every primary JSON has a manifest, and the run registry points to the current JSON, manifest, and Report Markdown.

`inputs/run-config.json` is the current convenience copy. Every distinct config is also stored immutably under `provenance/`, and each stage envelope binds the exact config artifact used for that attempt. Provenance filenames use semantic provenance artifact IDs, so identical bodies stored under different roles cannot overwrite each other.

## Artifact chain

| Stage | Primary output | Direct inputs |
|---|---|---|
| `discover` | Discover envelope | DOI input and recorded external/model provenance |
| `scope` | Scope envelope | Verified Discover |
| `prepare` | Prepare envelope | Verified Scope and exact Discover ancestor |
| `evidence` | Evidence envelope | Verified Prepare and exact Scope ancestor |
| `adjudicate` | Adjudicate envelope | Verified Evidence and exact Prepare ancestor |
| `report` | Report JSON and Markdown | Verified Discover, Scope, Prepare, Evidence, and Adjudicate |

Discover records a lossless source ledger; Scope freezes membership; Prepare preserves every family × occurrence record; Evidence preserves every retrieval outcome; Adjudicate preserves every gate/model outcome; Report reconciles the complete chain.

## Validation and resume

Artifact readers validate JSON shape, stable IDs, internal references, content hashes, and direct lineage. Resume reloads the already-succeeded prefix and refuses missing, malformed, tampered, cross-run, or mismatched inputs rather than silently recomputing them.

## Human review sidecar

Human calibration labels are **not** a seventh pipeline stage and never overwrite machine artifacts. After Report succeeds, the local UI may append review events under:

```text
data/runs/<runId>/review/<reportArtifactId>/events.json
```

The event log is bound to the Report `artifactId` + `contentHash`. A rerun that produces a new Report artifact starts a new review lineage while preserving older review directories. Writes are atomic (temp file + rename) and reject stale concurrent heads via `expectedHeadEventId`. Exports (JSON bundle with event history, or flat CSV) include machine record snapshots plus current human labels.

## Interpretation

Report is the authoritative accounting artifact. Adjudicate is runnable but **uncalibrated**: its `F`/`D`/`E`/`U` outputs require blinded human calibration before they support validation or trust claims. Human review sidecars are the calibration input; they do not rewrite Report JSON.
