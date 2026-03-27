# Citation Fidelity Analyzer

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

## Bottom Line

This project is worth doing because citation distortion is important, under-measured, and potentially tractable in a narrow setting. The POC should stay narrow until it proves that it can reveal a real mutation pattern in a claim family.
