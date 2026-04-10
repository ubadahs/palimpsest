# Palimpsest

## Build Spec

**Date:** March 2026  
**Status:** Draft  
**Purpose:** Define the minimum implementation required to satisfy the [PRD](./prd.md).

## Canonical Reference

The [PRD](./prd.md) is the source of truth for:

- scope
- inclusion and exclusion rules
- taxonomy
- required outputs
- non-goals
- success criteria

## Build Goal

Given a shortlist of candidate seed papers, first pre-screen local claim families for auditability and drift potential, then analyze eligible empirical-attribution citations, compare each citing claim against text from the cited paper, and output structured judgments plus a human-readable report.

## Non-Goals

This build does not include:

- a hosted or multi-user web application (product-facing UI or SaaS)
- large-scale orchestration
- review-article handling
- citation-chain inference beyond the selected local cluster
- automatic scoring of all papers in a corpus

**In-scope exception:** a **local-only** orchestration UI (for example Next.js under `apps/ui`) that runs the same CLI, reads/writes the same SQLite database and artifact layout, and does not replace CLI or artifact semantics. See [ui-architecture.md](./ui-architecture.md).

## System Boundary

The system is allowed to:

- pre-screen candidate claim families for auditability
- fetch open-access paper text
- parse references and in-text citations
- retrieve candidate passages from cited papers
- ask an LLM to extract, compare, and classify
- record auditability status as an output
- store results locally in SQLite

The system is not allowed to:

- classify citations without grounding spans
- infer claims from inaccessible cited papers
- treat abstract-only access as sufficient for full fidelity scoring
- conflate publishing opacity with citation distortion
- silently fall back from missing evidence to confident labels

## Design Principle

Failure to access or ground a citation must be kept separate from failure of the citation itself. Publishing opacity is a property of the literature, not evidence of citation distortion.

## Claim-Family Pre-Screen

This phase exists to identify which candidate claim families are both interesting and auditable enough to support a meaningful POC.

It can be implemented with a simple script plus light manual review. It does not require the full fidelity-classification pipeline.

### Inputs

- a semi-manual shortlist of 5 to 10 candidate seed papers

### Workflow

For each seed paper:

1. identify one concrete claim to track
2. gather a small set of downstream citing papers around that claim
3. resolve cited papers and check access status using OA-oriented sources
4. attempt lightweight full-text retrieval
5. assign each relevant citation edge an auditability status
6. compute auditable-edge coverage, rough drift-risk, and local graph size

### Output

For each candidate family, record:

- seed paper
- concrete seed claim
- local citation network size
- auditable-edge coverage
- notes on why drift seems plausible
- greenlight or deprioritize decision

Prefer specific, paraphraseable claims with likely certainty or scope drift. Deprioritize seeds whose local networks are mostly paywalled or abstract-only.

## Full Analysis Pipeline

### 1. Fetch and parse the citing paper

- Input: one bioRxiv DOI or URL
- Preferred source: bioRxiv JATS XML
- Fallback: validated direct PDF -> GROBID TEI only if structured XML is unavailable
- Extract:
  - paper metadata
  - sectioned full text
  - reference list
  - in-text citation markers

### 2. Extract citation contexts

For each in-text citation:

- capture the local passage around the citation
- identify the exact citing span that contains the attributed claim
- map the citation marker to a reference entry

Store all candidates before filtering.

### 3. Filter to POC-eligible citations

Apply the inclusion and exclusion rules defined in the [PRD](./prd.md).

Use the LLM only to decide whether the citation instance matches the in-scope `empirical_attribution` function and whether the claim is specific enough to evaluate.

If the answer is no, mark the citation as out of scope and stop processing it.

### 4. Resolve and fetch the cited paper

- Resolve DOI and metadata with OpenAlex first
- Use Semantic Scholar as fallback metadata and open-access link source
- If DOI is missing, allow conservative fallback resolution by:
  - PMCID
  - PMID
  - exact normalized title + author-surname overlap + publication year window
- Retrieve open-access full text where possible
- Use one centralized acquisition policy for all stages:
  - preserve the original requested identifiers alongside provider-normalized identifiers
  - treat provider OA metadata as hints, not as the fetch plan
  - rank candidates as structured repository XML first, verified PDF later
  - allow landing-page fetches only to discover better XML/PDF links
- Prefer structured text sources over PDFs
- Validate payloads before parsing:
  - only send bytes to GROBID if the response is a real PDF
  - classify HTML/interstitial/challenge responses explicitly instead of reporting them as parser failures
- Cache cited-paper metadata, parsed text, and chunked representations locally
- Persist acquisition provenance so each parsed paper records the winning method, locator kind, selected URL, and ordered attempts
- If multiple citing papers reference the same cited paper, fetch and parse it once

If the cited paper cannot be retrieved in usable full-text form, mark the edge as `not_auditable` or `partially_auditable` and stop before fidelity scoring.

### 5. Retrieve candidate spans from the cited paper

For the POC, retrieval should stay narrow but structured:

- normalize full text into blocks with section labels and block kinds
- rank blocks with BM25
- optionally rerank the BM25 shortlist with a local open reranker
- keep only the top candidate evidence blocks for downstream judgment

If no candidate span is plausibly relevant beyond the abstract, mark the edge as `partially_auditable` or `not_auditable` and return `U` rather than guessing.

This should be surfaced explicitly as an abstract-only downgrade, not silently folded into ordinary retrieval success.

### 6. LLM analysis

Run analysis in separate steps:

1. Extract the attributed claim from the citing span.
2. Identify whether the retrieved cited spans are evidence, interpretation, or both.
3. Compare the claim against the cited spans.
4. Assign a top-level label using the taxonomy defined in the [PRD](./prd.md).
5. Assign a subtype only when the [PRD](./prd.md) requires one.
6. Return a short rationale and confidence level.

Every judgment must include:

- the exact citing span
- the exact cited span
- the cited span section label

If any of those are missing, the final label is invalid and must be downgraded to `U`.

## Minimum Data Model

The POC needs only two core tables.

### `papers`

- `id` TEXT PRIMARY KEY
- `title` TEXT
- `authors_json` TEXT
- `abstract` TEXT
- `full_text` TEXT
- `full_text_status` TEXT
- `source` TEXT
- `fetch_status` TEXT
- `metadata_json` TEXT

### `citations`

- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `citing_paper_id` TEXT
- `cited_paper_id` TEXT
- `citation_key` TEXT
- `context_passage` TEXT
- `citing_span` TEXT
- `attributed_claim` TEXT
- `auditability_status` TEXT
- `auditability_reason` TEXT
- `cited_span` TEXT
- `cited_span_section` TEXT
- `citation_function` TEXT
- `fidelity_top` TEXT
- `fidelity_subtype` TEXT
- `fidelity_rationale` TEXT
- `evidence_vs_interpretation` TEXT
- `confidence` TEXT
- `eligibility_status` TEXT
- `review_status` TEXT

Anything else can remain in JSON blobs or logs until it is clearly needed.

## Prompting Rules

- Separate extraction from judgment.
- Determine auditability before fidelity.
- Ask the model for the strongest case that the citation is misleading before asking for a final label.
- Treat uncertainty as a valid outcome.
- Do not force a fidelity label from abstract-only evidence.
- Use JSON-shaped outputs for every model call.
- Never let the model see the entire cited paper if retrieval has already narrowed the candidate spans.

## Report Shape

Generate the per-paper and per-claim-family outputs defined in the [PRD](./prd.md). This spec does not extend or reinterpret those outputs.

## Build Order

Implement in this order:

1. claim-family pre-screen script
2. bioRxiv ingestion and citation-context extraction
3. eligibility filtering and auditability assessment
4. cited-paper resolution and open-access retrieval
5. candidate-span retrieval
6. LLM comparison and classification
7. report generation

Do not build chain analysis, dashboards, or large-scale batch execution before the pre-screen and full-analysis stages above work on one claim family.
