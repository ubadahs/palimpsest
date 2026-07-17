# Adjudication Rubric

## Canonical Adjudicate (Isolated, Uncalibrated)

Canonical Adjudicate (`runCanonicalAdjudicate`) is the lean-pipeline stage for record-level fidelity decisions. It is **implemented as an isolated service**, not CLI/executor-wired, and is explicitly **uncalibrated** until tested against blinded human labels.

Canonical verdicts follow the PRD taxonomy:

- `F` faithful: the attribution preserves the cited source’s substantive meaning; reasonable compression is allowed
- `D` distortion: a real source kernel exists, but scope, strength, certainty, causality, population, conditions, or generality is materially altered
- `E` error: the central attribution is unsupported, contradicted, about the wrong entity/result, or otherwise lacks the claimed source kernel
- `U` uncertain: exact cited evidence exists, but genuine scientific/attribution ambiguity prevents a defensible F/D/E judgment

Critical policy:

- `U` is **not** an operational failure bucket
- retrieval/provider/classification/gate failures are `not_adjudicated`, `adjudication_failed`, or `invalid_output` — never F/D/E/U
- `no_lexical_matches` never becomes `E` or `U`
- confidence may be recorded but never chooses another model or alters the verdict path
- there is no advisor, vector-first, challenger, or confidence-only escalation path in canonical Adjudicate
- blinded human calibration is still required before advisor/vector routing or trust claims

## What Is Operational Today (Temporary Current Executor)

The temporary current-executor adjudication layer still uses a **support-style rubric** for sampled audit records. That workflow is separate from canonical Adjudicate and has no lean-pipeline standing.

Current-executor verdicts are:

- `supported`
- `partially_supported`
- `overstated_or_generalized`
- `not_supported`
- `cannot_determine`

These verdicts remain the authoritative machine outputs for the temporary executor's:

- audit sample worksheets
- LLM adjudication runs
- agreement reports
- benchmark blind/diff/summary/apply workflows

In the temporary executor's default **categorical adjudicator** mode, optional `fidelityVectorTrace` output is diagnostic only. The opt-in **vector-first adjudicator** (`adjudicationMode: "vector_first"`) and default **advisor** confidence escalation are temporary current-executor behaviors only. Do not treat them as the canonical Adjudicate contract.

## Approximate Mapping (Documentation Only)

Conceptual alignment between temporary-executor labels and PRD labels is approximate:

- `supported` ≈ `F`
- `partially_supported` sits between `F` and `D`
- `overstated_or_generalized` ≈ `D`
- `not_supported` ≈ `E`
- `cannot_determine` is sometimes closest to `U`, but in the temporary executor it also absorbs retrieval/operational failures that canonical Adjudicate keeps as non-verdict outcomes

This mapping is intentionally not lossless and must not be used as a compatibility bridge.

## Canonical Report (Isolated, Deterministic)

Canonical Report (`runCanonicalReport`) is a pure deterministic audit accounting stage over the complete canonical artifact chain. It is **implemented as an isolated service**, not CLI/executor-wired.

Reporting rules that follow from this rubric:

- never report a faithfulness/F/D/E/U rate without the exact adjudicated-record denominator beside it
- never include `not_adjudicated`, retrieval failures, or invalid model output in F/D/E/U denominators
- never turn `no_lexical_matches` into `E` or `U`
- keep `U` (scientific ambiguity with evidence) separate from all operational failures
- do not call temporary-executor `partially_supported` a fidelity rate in canonical Report
- do not include accuracy, agreement, benchmark, calibration, or human-vs-model statistics in the canonical audit report; those belong to a separate evaluation workflow
- interpretation status remains `uncalibrated_research_output` until blinded human labels exist

## Non-Goals

- Do not silently convert temporary-executor support-style artifacts into canonical F/D/E/U envelopes
- Do not restore advisor/vector routing in canonical Adjudicate until blinded calibration exists
- Do not treat operational failure as `U` / `cannot_determine` in the lean pipeline
- Do not treat temporary-executor audit summaries or agreement reports as canonical Report
