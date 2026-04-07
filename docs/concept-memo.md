# Palimpsest

## Concept Memo

**Date:** March 2026  
**Status:** Draft  
**Purpose:** Explain why this project is worth testing.

## Thesis

Citation fidelity is an under-measured property of the scientific record. A system that can surface where empirical claims are sharpened, broadened, weakened, or detached from their original evidence would be useful first as a metascience instrument and only secondarily as infrastructure for AI systems that consume literature.

## Problem

Scientific papers are treated as a reliable knowledge base by researchers, reviewers, and increasingly by AI systems. But the links inside that knowledge base, citations, are not routinely audited for whether they preserve the meaning of the work they reference.

Manual studies suggest that a meaningful minority of citations contain non-trivial distortions or outright errors. Those studies are valuable but too small to characterize how distortion behaves across a local citation graph.

The missing instrument is a system that can answer a narrow question repeatedly:

> When one paper attributes an empirical finding to another paper, does the cited paper actually support that attribution?

If the answer is often "not quite" or "no," then the citation graph is not just a record of knowledge transfer. It is also a mechanism by which claims mutate as they propagate.

Before a citation can be judged for fidelity, it must first be auditable. Full text is generally required for that; abstract-only access is usually not enough. The share of edges that fail this test is itself evidence about how opaque the literature remains to machine verification.

## Why This Matters

### It creates a new metascience measurement

The project measures a neglected form of corpus bias: not publication bias or selection bias, but citation distortion.

### It grounds complaints about scientific communication in evidence

People often argue that the literature is distorted by incentive systems, prestige effects, and sloppy propagation of claims. This project turns one part of that complaint into something measurable.

### It gives AI systems a better uncertainty prior

Systems that retrieve and synthesize papers inherit the citation graph as part of their evidence base. If some claim neighborhoods are visibly distorted, those are places where AI systems should be more skeptical.

## Why The POC Is Narrow

The first version should be narrow because the point is not to build a platform. The point is to learn whether the signal exists clearly enough to justify more engineering.

That is why the POC focuses on:

- one domain
- one citation function type
- full fidelity scoring only where usable open-access full text is available
- measured pre-screening of candidate claim families before full analysis
- a small number of claim families
- outputs designed for human review rather than automation

## What Would Make This Worth Continuing

The POC is worth continuing only if it produces a reviewable artifact that teaches something real about how a claim changed as it propagated. If it cannot do that in a small, favorable setting, scaling it would be wasted effort.

## Canonical References

- [PRD](./prd.md): canonical source for scope, taxonomy, outputs, non-goals, and success criteria
- [Build Spec](./build-spec.md): implementation details for the POC pipeline
- [Evaluation Protocol](./evaluation-protocol.md): review procedure and stop-go logic

## Beyond The POC: Multi-Hop Claim Drift

The POC analyzes one hop: citing papers that reference a seed paper directly. But the real phenomenon is **claim drift** — the compounding distortion that emerges across multiple generations of citation.

### The telephone game

Consider a chain: Paper A reports a hedged finding. Paper B cites A and slightly overstates it. Paper C cites B (not A) and overstates it further. By the time Paper D cites C, the original hedge has been replaced by a confident assertion that the evidence does not support. Each individual hop may look like minor compression or reasonable shorthand. The cumulative effect is a claim that has drifted far from its evidentiary base.

This means transitive fidelity cannot be assumed: if A→B is faithful and B→C is faithful, A→C is not necessarily faithful. Small compressions compound.

### The review-article bottleneck

A specific and common drift mechanism: a review article rewords an original finding, and downstream papers cite the review instead of the primary source. The review's wording becomes the de facto version of the claim. If the review simplified, generalized, or shifted emphasis, that distortion is inherited by every paper that cites it — and none of those downstream papers have any reason to check the original.

This creates a latent bias in the corpus: a consensus built not on the primary evidence but on one intermediary's rewording of it.

### What multi-hop analysis requires

Extending the pipeline from one-hop fidelity auditing to multi-hop drift tracking would require:

- **Claim identity across hops**: a way to recognize that a claim in Paper C is "the same claim" as one in Paper A, despite different wording. This is a canonicalization problem.
- **Graph structure beyond star topology**: the current claim family is a star (seed at center, citers around it). Multi-hop means a DAG where citers themselves become seeds for the next generation.
- **Automated claim extraction**: at one hop, a human can hand-identify the seed claim. At multiple hops, the system needs to extract claim units from papers automatically — identifying which sentences assert the paper's own findings versus reference others' work.
- **Drift quantification**: a way to measure cumulative fidelity loss across a chain, not just per-edge verdicts.

These are not in the POC scope. The POC must first prove that single-hop fidelity auditing works reliably in a small, favorable setting. If it does, multi-hop drift tracking is the natural next instrument.

## Bottom Line

This project is worth doing because citation distortion is important, under-measured, and potentially tractable in a narrow setting. The POC should stay narrow until it proves that it can reveal a real mutation pattern in a claim family.
