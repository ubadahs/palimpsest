# Adjudication Rubric

## Canonical Adjudicate (Uncalibrated)

Canonical Adjudicate (`runCanonicalAdjudicate`) is the production stage for record-level fidelity decisions. It is wired through the canonical executor and CLI, and is explicitly **uncalibrated** until tested against blinded human labels.

Canonical verdicts follow the project taxonomy:

- `F` faithful: the attribution preserves the cited source’s substantive meaning; reasonable compression is allowed
- `D` distortion: a real source kernel exists, but scope, strength, certainty, causality, population, conditions, or generality is materially altered
- `E` error: the central attribution is unsupported, contradicted, about the wrong entity/result, or otherwise lacks the claimed source kernel
- `U` uncertain: exact cited evidence exists, but genuine scientific/attribution ambiguity prevents a defensible F/D/E judgment

Critical policy:

- `U` is **not** an operational failure bucket
- retrieval/provider/classification/gate failures are `not_adjudicated`, `adjudication_failed`, or `invalid_output` — never F/D/E/U
- `no_lexical_matches` never becomes `E` or `U`
- confidence may be recorded but never chooses another model or alters the verdict path
- there is no advisor, vector-first, challenger, or confidence-only escalation path
- blinded human calibration is required before trust claims

## Canonical Report (Deterministic)

Canonical Report (`runCanonicalReport`) is a pure deterministic audit accounting stage over the complete canonical artifact chain.

Reporting rules that follow from this rubric:

- never report a faithfulness/F/D/E/U rate without the exact adjudicated-record denominator beside it
- never include `not_adjudicated`, retrieval failures, or invalid model output in F/D/E/U denominators
- never turn `no_lexical_matches` into `E` or `U`
- keep `U` (scientific ambiguity with evidence) separate from all operational failures
- do not include accuracy, agreement, benchmark, calibration, or human-vs-model statistics in the canonical audit report; those belong to a separate evaluation workflow
- interpretation status remains `uncalibrated_research_output` until blinded human labels exist

## Non-Goals

- Do not restore advisor/vector routing in canonical Adjudicate until blinded calibration exists
- Do not treat operational failure as `U`
- Do not treat support-style labels (`supported`, `partially_supported`, etc.) as product outputs
