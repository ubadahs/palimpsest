# Artifact Workflow

This document describes the not-yet-replaced executor's current artifact layout: what files each stage emits, how runs are laid out on disk, and how the UI tracks the latest outputs. The lean six-stage artifact contracts replace these shapes as stage-specific implementations land. Canonical Discover, Scope, Prepare, and Evidence persistence now exist in isolation, but no CLI/executor path selects their output locations yet.

`data/` is generated output, not source of truth. Preserve only the smallest artifacts you actually need for tests or examples.

## Core Principles

- current-executor primary JSON artifacts remain authoritative only for the temporary executor
- primary JSON artifacts get adjacent manifest files
- Markdown companions are for inspection, not for machine integration
- diagnostic sidecars preserve provenance and debugging context, but most are not consumed by downstream stages
- artifact loading is schema-validated
- reruns are append-only; the newest successful artifact becomes the current pointer

## Canonical Discover Artifact

Canonical Discover writes one authoritative versioned JSON envelope validated by `discoverArtifactSchema`. Its payload contains the complete neighborhood, citing-paper disposition, citation-occurrence, extraction-outcome, attributed-claim, candidate-membership, and candidate-disposition ledgers. Scientific observations are not split into optional shortlist or diagnostic sidecars.

The application and persistence seams are:

- `runCanonicalDiscover` — builds the lossless payload, append-only decisions, and provenance inputs from dependency-injected adapters
- `buildCanonicalDiscoverArtifact` — binds the payload to stable content/artifact hashes and non-replayable external/model execution metadata
- `writeCanonicalDiscoverArtifact` — validates and writes only the current Discover envelope
- `loadCanonicalDiscoverArtifact` — validates the current envelope, including stable IDs and tamper hashes

Raw provider, full-text/parser, model-request, and model-response data remain separate immutable artifacts referenced from the envelope. Exact request/response content is referenceable; the envelope does not claim that external or model execution can be replayed. This writer does not emit current-executor result, shortlist, grounding-trace, handoff, or sidecar formats, and the loader does not read them.

## Canonical Scope Artifact

Canonical Scope reads exactly one current canonical Discover envelope and writes one authoritative versioned Scope envelope. The payload repeats the Discover artifact ID/content hash as immutable lineage and contains:

- one explicit `scoped` or `deferred_upstream` accounting record for every Discover candidate
- scoped families with all source candidate IDs, source claim-record IDs, and the exact sorted union of Discover citation-occurrence membership
- one seed materialization outcome per selected seed, including immutable parsed seed-text blocks and source artifacts when available
- grounding annotations that distinguish scientific `not_found` from `seed_text_unavailable`, `acquisition_failed`, typed `grounding_failed`, and malformed/quote-invalid `invalid_grounding_output`
- exact verified evidence locators (block, section, offsets, text, and source artifact) plus rejected model-quote details

The application and persistence seams are:

- `runCanonicalScope` — validates the Discover envelope, freezes exact membership, materializes each selected seed once, validates model output, and verifies quotes
- `buildCanonicalScopeArtifact` — binds Scope content to the exact Discover lineage and non-replayable external/model execution provenance
- `writeCanonicalScopeArtifact` — validates and writes only the current Scope envelope
- `loadCanonicalScopeArtifact` — validates the current envelope, including internal references, stable identities, and tamper hashes

Scope does not emit or consume shortlist, handoff, pre-screen, screen, or other temporary executor artifacts. Grounding never acts as an exclusion gate: `grounded`, `ambiguous`, `not_found`, seed-text failure, provider `grounding_failed`, and `invalid_grounding_output` outcomes retain the frozen occurrence membership. `not_found` carries no accepted evidence; provider failures retain typed code/reason rather than masquerading as malformed output.

## Canonical Prepare Artifact

Canonical Prepare reads one current Scope envelope and the exact current Discover ancestor referenced by Scope. It writes one authoritative Prepare envelope whose lineage names both artifact IDs/content hashes and whose payload contains:

- the complete preserved Scope family ledger used to verify exact pair accounting
- one `PreparedCitationInstance` for every family × included citation-occurrence pair, ordered by stable record ID
- the full Scope family and complete Discover source-candidate/source-claim ledger in each evaluation record
- exact nonempty occurrence-local candidate and source-claim subsets, preserving the attributed wording for this record's citation occurrence
- complete Discover seed, citing-paper, and citation-occurrence records
- exact verbatim source context separated from any derived context
- typed `classified`, `ambiguous`, or nonfatal `failed` classification, with deterministic/model/external execution provenance
- one append-only classification outcome decision per record and no sampling exclusions

The application and persistence seams are:

- `runCanonicalPrepare` — verifies both current ancestors before adapter calls, checks Scope against Discover, materializes every frozen pair, validates classifier output, and preserves failures
- `buildCanonicalPrepareArtifact` — binds exact Scope/Discover lineage, pair decisions, and classifier request/response provenance into the lean envelope
- `writeCanonicalPrepareArtifact` — validates and writes only the current Prepare envelope
- `loadCanonicalPrepareArtifact` — validates the current envelope, including exact pair accounting, stable identities, internal references, provenance, and tamper hashes

Prepare does not read or write extract, classify, curate, shortlist, handoff, or other temporary-executor shapes. Record identity is versioned family ID + citation-occurrence ID only. Model or external classification makes execution explicitly non-replayable. Executor/CLI wiring is not implemented yet.

## Canonical Evidence Artifact

Canonical Evidence reads one current Prepare envelope and the exact current Scope ancestor referenced by Prepare. It reads no current-executor classification/evidence/curate artifact and never reacquires cited text. Its authoritative envelope contains:

- exact Prepare and Scope artifact ID/content-hash lineage plus a compact ledger of every Prepare record identity
- one honest family query per scoped family, including grounding-status/verification annotation that is excluded from query and BM25 identity
- deterministic chunk corpora built from immutable Scope blocks, with exact untruncated text, content hashes, source block/section/offsets, chunk configuration/overlap/order, seed-text artifact, and raw source artifacts
- immutable BM25 runs with exact query text/terms, tokenizer/scoring config, ordered corpus chunk IDs, raw scores, deterministic ranks/ties, and complete candidate IDs
- optional immutable relevance-rerank runs that reference one exact BM25 run/candidate set and carry strict result IDs, score/rank/rationale, prompt/model/request/response provenance, or a typed nonfatal failure
- explicit nonempty final selections naming either the BM25 version or the separate reranked version; no-match and unavailable/failure outcomes carry no selection
- exactly one retrieval outcome per Prepare record and three append-only decisions per record (retrieval, rerank, final selection), with no exclusions or sampling

Shared family query/corpus/ranking computations remain reconstructable even when multiple occurrence records reuse them. BM25 uses only the Scope family claim: citing context, local extracted claims, classification, adjudication labels, and Scope support spans cannot affect lexical scoring. Model/config changes can change rerank/artifact identity but cannot change Prepare-record, chunk, corpus, query, or BM25 identity when their semantic inputs are unchanged.

The application and persistence seams are:

- `runCanonicalEvidence` — verifies Prepare/Scope lineage, chunks exact Scope text, runs deterministic BM25, optionally invokes a dependency-injected relevance reranker, and emits complete record accounting
- `buildCanonicalEvidenceArtifact` — binds exact direct inputs, all shared runs/selections, decisions, and optional non-replayable model provenance into the lean envelope
- `writeCanonicalEvidenceArtifact` — validates and writes only the current Evidence envelope
- `loadCanonicalEvidenceArtifact` — validates current version, ranking/reference consistency, exact provenance, stable identities, and tamper hashes

Unavailable seed text, acquisition failure, zero lexical matches, deterministic retrieval failure, and rerank failure remain separate machine states. Disabled reranking has no model provenance; nonfatal failure preserves BM25 and remains explicit; fatal authentication/authorization/billing/quota errors produce no successful Evidence artifact.

## Artifact Roles

Artifacts fall into four roles:

| Role | Meaning |
|------|---------|
| `primary` | Authoritative machine output for a current-executor stage, or a machine handoff consumed by a later stage |
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

## Current Executor Outputs

The current executor uses the stage keys below. Artifact readers accept only the declared current suffixes.

| Order | Stage key | CLI command | UI run directory | Primary machine output | Report | Companion artifacts |
|------|-----------|-------------|------------------|------------------------|--------|---------------------|
| 0 | `discover` | `discover` | `00-discover/` | `*_discovery-results.json`; `*_discovery-shortlist.json` is the downstream shortlist handoff | `*_discovery-report.md` | Diagnostic: `*_discovery-neighborhood.json`, `*_discovery-probe.json`, `*_discovery-mentions.json`, `*_discovery-attributed-claims.json`, `*_discovery-family-candidates.json`, `*_discovery-grounding-trace.json` |
| 1 | `screen` | `screen` | `01-screen/` | `*_pre-screen-results.json` | `*_pre-screen-report.md` | Diagnostic: `*_pre-screen-grounding-trace.json` |
| 2 | `extract` | `extract` | `02-extract/` | `*_extraction-results.json` | `*_extraction-report.md` | Diagnostic: `*_extraction-inspection.md` |
| 3 | `classify` | `classify` | `03-classify/` | `*_classification-results.json` | `*_classification-report.md` | none |
| 4 | `evidence` | `evidence` | `04-evidence/` | `*_evidence-results.json` | `*_evidence-report.md` | none |
| 5 | `curate` | `curate` | `05-curate/` | `*_audit-sample.json` | `*_audit-sample-worksheet.md` | none |
| 6 | `adjudicate` | `adjudicate` | `06-adjudicate/` | `*_llm-audit-sample.json` | `*_llm-summary.md`; `*_agreement-report.md` when available | Optional in-record diagnostic: `fidelityVectorTrace` when enabled; opt-in vector-first provenance: `vectorRoutingDecision` |

Every primary JSON artifact also gets:

- `*_manifest.json`

The temporary executor registry for stage keys, ordering, suffixes, and companion-artifact roles lives in [src/contract/stages.ts](../src/contract/stages.ts). The canonical six-stage vocabulary and target artifact envelopes live in [src/contract/lean-stages.ts](../src/contract/lean-stages.ts) and [src/contract/lean-artifacts.ts](../src/contract/lean-artifacts.ts).

## Where Artifacts Are Written

### Stage commands

Each stage command writes timestamped files into its chosen output directory. The directory is append-only: reruns write new timestamped files instead of replacing older ones.

### `pipeline`

The current `pipeline` command writes into one chosen output root and mirrors the temporary executor layout used by UI runs:

- `00-discover/`
- `01-screen/`
- `02-extract/`
- `03-classify/`
- `04-evidence/`
- `05-curate/`
- `06-adjudicate/`

Within each stage directory, pipeline uses the same declared current-executor filename suffixes as the standalone stage commands. Family-oriented stages write one artifact set per family inside that stage directory, for example `*_family-1_extraction-results.json`.

Pipeline runs also emit a top-level `*_run-cost.json` file. This is a centralized run-level telemetry summary for all Anthropic calls in the run, including discovery, screen grounding/filtering, evidence reranking, adjudication, and optional fidelity vector tracing. The summary includes attempted, successful, failed, and billable call counts plus per-stage rollups. It also includes `byPurpose` per-purpose breakdowns (token counts, cost, and `exactCacheHits`) and `totalExactCacheHits` at the top level. Fidelity vector calls appear under the separate `"fidelity-vector"` purpose.

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

The UI does not rename or reshape current-executor artifact filenames. It points each stage row at the latest successful primary, report, and manifest artifact already emitted by the CLI.

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

Lean stage artifacts and discovery handoffs reject superseded shapes rather than converting them. Some temporary executor loaders still recognize their own prior formats; those readers are not part of the lean contracts and will be deleted with the corresponding executor stages. Scientific raw inputs and provenance are retained separately from software-contract compatibility.

## Parsing And Evidence Metadata

The `extract` and `evidence` artifacts carry structured parsing and retrieval metadata.

### Parsed full text

New runs normalize JATS XML and GROBID TEI into one internal parsed-document shape with:

- `parserKind`
- `fullTextFormat`
- `blocks`
- `references`
- `mentions`

The temporary executor still recognizes stored `pdf_text`; this reader is not part of the lean artifact contract. New PDF-backed runs emit `grobid_tei_xml`, and the old reader should be removed when parsing moves into the lean workflow.

### Full-text acquisition provenance

Artifacts that depend on fetched paper content now also carry acquisition provenance alongside the parsed document or paper source record.

The shared provenance shape includes:

- `materializationSource` (`network`, `raw_cache`, `parsed_cache`)
- `selectedMethod` (`biorxiv_xml`, `pmc_xml`, `landing_page_xml`, `direct_pdf_grobid`)
- `selectedLocatorKind` (`pmcid_metadata`, `pmcid_derived_url`, `doi_input`, `doi_resolved`, `direct_pdf_url`, `meta_pdf_url`, `meta_xml_url`)
- `selectedUrl`
- `fullTextFormat`
- ordered `attempts[]` with probe classification, URL, HTTP status, and failure reason when relevant

This provenance is the authoritative answer to "how did we get this parsed paper?" and should be preferred over superseded cache fetch-status fields.

### Evidence spans (temporary executor)

Evidence spans include retrieval metadata needed for auditability and debugging:

- `blockKind`
- `bm25Score`
- optional `rerankScore`
- `matchMethod`

`matchMethod` distinguishes BM25-only retrieval from reranked retrieval in the temporary task shape. Canonical Evidence does not overwrite or blend these fields: exact chunks, raw BM25 rankings, optional rerank rankings, and final selections are separate referenced collections.

### Retrieval statuses (temporary executor)

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

This avoids the lossy `recordsBySeedDoi` map, which could overwrite multiple tracked claims that shared the same DOI. The temporary executor still reads that prior shape; the lean contracts do not, and the reader should disappear with `screen`.

## Run-Scoped Reuse

Pipeline execution can reuse expensive work across equivalent families within the same run:

- attribution-first `discover` writes the required, versioned `inputs/discovery-handoffs.json` so `screen` and `extract` can reuse resolved seed metadata, citing-paper neighborhoods, harvested mentions, and family grounding traces on fresh runs and strict resume
- `extract` reuses citation-context extraction for identical citing-paper neighborhoods
- `classify` reuses packet construction for the same effective neighborhood inputs

Current-executor primary artifacts remain authoritative per family even when computation was reused. The discovery handoff bundle is a reusable provenance artifact, not a replacement for stage primary JSON outputs. The extract/classify cache is run-scoped only. A separate persistent exact-result LLM cache (`llm_result_cache` table) provides cross-run reuse for identical LLM requests — see [caching.md](./caching.md) for details.

## Benchmark Workflow

The benchmark workflow is append-only and artifact-driven.

### 1. Create a blind benchmark export

```bash
npm run dev -- benchmark:blind --input path/to/audit-sample.json
```

This removes adjudication outcome fields from active records while preserving record order and task identity. Optional `fidelityVectorTrace` values and vector-first `vectorRoutingDecision` provenance are stripped because they are adjudication outcome diagnostics.

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
