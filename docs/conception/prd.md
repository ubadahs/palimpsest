# Palimpsest

## Product Requirements Document

**Date:** March 2026  
**Status:** Draft  
**Purpose:** Define the canonical product scope for the proof of concept. This document is the source of truth for scope, taxonomy, outputs, non-goals, and success criteria.

## Product Objective

Build a triage system that analyzes open-access biology preprints and identifies likely citation distortion in empirical-attribution citations.

The POC should produce both a reviewable claim-mutation map and a measured account of auditable-edge coverage for a small claim family, grounded in exact text spans from both the citing and cited papers where full fidelity scoring is possible.

The main deliverable is a convincing case study plus an auditability profile for selected claim families, not a large volume of labels.

## Primary User

For the POC, the primary user is the project author or a domain expert reviewing a small local citation cluster.

They need to answer:

1. Is there a real citation-distortion pattern in this claim family?
2. Is the pattern strong enough to justify a larger-scale study?

## Problem

Scientific papers are often treated as a reliable knowledge base, but the fidelity of citations inside that knowledge base is rarely measured. Manual studies suggest that a meaningful minority of citations contain non-trivial errors or distortions, but those studies are small and expensive to run.

The missing instrument is a system that can examine citation instances and answer a narrow question:

> When one paper attributes an empirical finding to another paper, does the cited paper actually support that attribution?

## Motivation

This is a metascience measurement project first. The AI-for-science angle matters, but it is downstream of the main contribution: making citation distortion observable.

The POC should therefore be judged first on whether it produces reviewable evidence about claim mutation, not on whether it supports a downstream AI workflow.

Before a citation can be judged for fidelity, it must first be auditable.

## POC Scope

The POC is intentionally narrow.

- Corpus: bioRxiv preprints plus cited papers in their local claim networks, with full fidelity scoring limited to edges that have usable full text
- Domain: biology
- Language: English
- Unit of analysis: one citation instance in which a citing passage attributes a specific empirical finding to one cited paper
- Sampling strategy: two claim families selected through measured pre-screening of a semi-manual shortlist of candidate seeds

## Auditability First

Full text is generally required for real fidelity scoring. Abstract-only comparison is usually insufficient.

When usable full text or sufficient grounding is missing, the correct output is `U` or `not_auditable`, not a forced fidelity judgment.

The proportion of relevant citation edges that are not auditable is itself a substantive result. It reflects the limits of the current publishing system and the practical limits of machine verification.

## Inclusion Rules For Fidelity Scoring

Assign fidelity labels only to citation instances that satisfy all of the following:

- the citing passage attributes a specific finding or result
- the attribution is to a single cited paper
- the cited object can be resolved
- usable full text is available for the cited paper
- candidate cited spans can be retrieved without relying only on the abstract
- the passage is specific enough to compare against grounded text in the cited paper

## Exclusion Rules

The POC does not analyze:

- method citations
- rhetorical citation bundles
- conceptual framing citations
- priority claims
- citations to reviews or meta-analyses
- non-English papers
- paywalled or abstract-only cited papers for fidelity scoring

These exclusions are deliberate. They define the testable boundary of the first version.

Edges outside the fidelity-scoring boundary still matter for auditability measurement and claim-family selection.

## Auditability Status

Each relevant citation edge should receive one auditability status before fidelity is judged.

- `auditable`: the cited object is resolved, usable full text is available, and the comparison can be grounded in candidate cited spans
- `partially_auditable`: the cited object is resolved and some text is available, but grounding is incomplete or abstract-heavy
- `not_auditable`: the cited object cannot be resolved, usable full text is unavailable, or grounding cannot be established

## Auditable-Edge Coverage

For a given local claim family, auditable-edge coverage is the fraction of relevant citation edges for which the system can:

1. resolve the cited object
2. obtain usable full text
3. retrieve candidate cited spans
4. ground a comparison without relying only on the abstract

This is both:

- a pre-screening metric for claim-family selection
- a substantive project output in its own right

Low coverage is not just an inconvenience. It is evidence that parts of the literature are structurally difficult for machines to verify.

## Claim-Family Pre-Screen

Before running the full analyzer, the project should pre-screen candidate claim families using a simple script plus light manual review.

The workflow is:

1. assemble 5 to 10 candidate seed papers manually
2. identify one concrete, paraphraseable claim per seed
3. build a small local citation network around that claim
4. assess each citation edge for resolution, full-text access, span retrieval, and auditability status
5. compute auditable-edge coverage, rough drift-risk, and local graph size
6. choose the top two claim families using measured coverage plus likely drift signal

The output of this step is a shortlist recommendation with seed claim, local network size, auditable-edge coverage, drift notes, and a greenlight or deprioritize decision.

Prefer seeds with specific claims that look vulnerable to certainty or scope drift. Deprioritize seeds whose local networks are mostly paywalled or abstract-only.

## Core Workflow

For each eligible citation instance:

1. extract the citation context from the citing paper
2. identify the attributed claim
3. resolve the cited object and assign an auditability status
4. retrieve candidate passages from the cited paper when the edge is auditable enough to compare
5. compare the attributed claim against the cited passages
6. assign a fidelity judgment grounded in exact spans, or return `U` / `not_auditable`

## Core Artifact

The main artifact is a claim-mutation map for each claim family.

Each map should show:

- which papers cite which earlier papers
- what empirical finding each citing paper attributes to its source
- whether each edge is auditable, partially auditable, or not auditable
- whether the attribution appears faithful, distorted, wrong, or unclear
- which citing and cited spans support that judgment

The artifact is useful only if a skeptical scientist can inspect the spans and conclude that a claim did, or did not, change as it propagated.

## Taxonomy

### Citation Function Types

Before fidelity assessment, classify what the citation is doing.

| Function | Description | Example |
|---|---|---|
| **Empirical attribution** | Citing a specific finding or result | "Smith et al. found that X increases Y" |
| **Methodological reference** | Citing a technique, protocol, or tool | "We used the method described in Jones (2019)" |
| **Conceptual framing** | Citing an idea, theory, or framework | "According to the dual-process model..." |
| **Priority claim** | Attributing first discovery or proposal | "This phenomenon was first described by Lee et al." |
| **Rhetorical bundling** | One of several citations grouped to establish general consensus | "Several studies have shown... [1-6]" |
| **Contrast or disagreement** | Citing work the author disagrees with or qualifies | "Unlike the findings of Park et al., we observe..." |

The POC analyzes only `empirical_attribution`.

### Top-Level Fidelity Labels

| Category | Code | Description |
|---|---|---|
| **Faithful** | `F` | The citing passage accurately reflects the cited work, including reasonable simplification that does not change meaning. |
| **Distorted** | `D` | The citing passage changes the meaning, certainty, scope, or emphasis of the cited work in a way that could mislead. |
| **Wrong** | `E` | The claim attributed to the cited paper is absent from it, contradicted by it, or the citation is irrelevant. |
| **Unclear** | `U` | The system cannot make a confident determination because the evidence is insufficient, ambiguous, or inaccessible. |

### Distortion Subtypes

Apply only when the top-level label is `D`.

| Subtype | Code | Description |
|---|---|---|
| **Certainty escalation** | `D1` | A hedged finding is presented as definitive. |
| **Certainty deflation** | `D2` | A strong finding is presented as weaker than the original. |
| **Scope expansion** | `D3` | The cited finding is generalized beyond the original context. |
| **Scope contraction** | `D4` | The cited work's broader finding is reduced to a narrower claim than warranted. |
| **Selective emphasis** | `D5` | One aspect is cited accurately while a contradicting or qualifying aspect from the same paper is omitted. |

### Error Subtypes

Apply only when the top-level label is `E`.

| Subtype | Code | Description |
|---|---|---|
| **Misattribution** | `E1` | The claim attributed to the cited paper does not appear in it, or the paper says something substantially different. |
| **Directional reversal** | `E2` | The cited paper's finding is represented as the opposite of what it reports. |
| **Phantom citation** | `E3` | The cited paper has no apparent relevance to the claim being made. |

### Evidence vs. Interpretation

Every assessment must also distinguish whether the citing author is referencing:

- the cited paper's evidence
- the cited paper's interpretation
- both
- or something unclear

This distinction is central to the POC. A citation can be faithful to the discussion section while being weakly grounded in the results section, and that difference matters.

## Required Outputs

For each analyzed paper:

- a machine-readable JSON output
- a human-readable Markdown report
- per-citation entries with auditability status, exact citing span, exact cited span when available, cited section label when available, top-level label when available, optional subtype, rationale, and confidence

For each claim family:

- a summary report that links the local citation cluster
- auditable-edge coverage for the local network
- a concise narrative of any visible mutation pattern
- notes on partially auditable and not auditable edges
- a set of flagged cases for human review

No fidelity judgment is valid unless it is span-grounded.

## Non-Goals

The POC is not trying to:

- build a polished application
- cover all citation types
- resolve every inaccessible reference
- produce a corpus-wide benchmark
- replace human judgment

## Success Criteria

The POC is successful if all of the following are true:

1. The pre-screen selects two claim families using measured auditability and plausible drift signal rather than intuition alone.
2. The pipeline runs end-to-end on auditable edges within those two claim families with limited manual cleanup.
3. The outputs include a measured account of auditable-edge coverage and keep non-auditable edges separate from fidelity judgments.
4. The outputs are grounded in real citing and cited spans rather than free-form model judgments.
5. Human review finds that top-level labels are accurate enough to make the system useful for triage.
6. At least one recurring distortion pattern is validated by a human reviewer.
7. The combination of claim-mutation map plus auditability account teaches something non-obvious about how a claim changed across citations.

For the initial POC, "accurate enough" means top-level agreement on grounded reviewed cases is at least 80%.

## Kill Criterion

Stop after two claim families if the system does not surface at least one human-validated, non-obvious mutation pattern.

That failure can mean:

- the problem is real but the pipeline is weak
- the selected claim families were poor choices
- the premise is less useful than expected

The point of the POC is to find out which explanation is most likely.
