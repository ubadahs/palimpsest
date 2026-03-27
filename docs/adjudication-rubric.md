# Adjudication Rubric

## What Is Operational Today

The implemented adjudication layer uses a **support-style rubric** rather than persisting the PRD taxonomy directly.

Current verdicts are:

- `supported`
- `partially_supported`
- `overstated_or_generalized`
- `not_supported`
- `cannot_determine`

These verdicts are the canonical machine outputs for:

- calibration worksheets
- LLM adjudication runs
- agreement reports
- benchmark blind/diff/apply workflows

## Relationship To The PRD Taxonomy

The PRD’s conceptual taxonomy remains important, but it is **not** the primary persisted output shape in the current implementation.

Conceptual alignment is:

- `supported` is usually closest to PRD `F`
- `partially_supported` often captures compression, indirect sourcing, or narrower forms of scope drift; it sits between PRD `F` and `D`
- `overstated_or_generalized` is usually closest to PRD `D`
- `not_supported` is usually closest to PRD `E`
- `cannot_determine` is closest to PRD `U`

This mapping is intentionally approximate, not lossless. In particular:

- `partially_supported` is broader than any single PRD bucket
- the current pipeline does not persist PRD distortion/error subtypes
- adjudication reports should be read as operational review outputs, not as a one-to-one encoding of the full PRD taxonomy

## Why This Is Deliberate

The current pipeline is optimized for reviewable adjudication packets:

- exact citing context
- retrieved cited spans
- retrieval quality
- concise rationale

That workflow benefits from support-style verdicts during calibration and benchmark comparison. Converting those outputs into PRD-style `F/D/E/U` labels remains a documentation and interpretation layer, not a persisted product contract in this pass.

## Non-Goal Of This Cleanup

This cleanup does **not** refactor the pipeline so `F/D/E/U` becomes the primary output schema.

If that is needed later, it should be implemented as an explicit downstream mapping or a separate adjudication mode, not as an implicit reinterpretation of existing benchmark artifacts.
