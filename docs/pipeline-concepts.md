# Pipeline Concepts

This is the compact object model for the not-yet-replaced executor. The lean six-stage target is tracked in [status.md](./status.md). For exact current executor inputs, outputs, and filenames, see [pipeline.md](./pipeline.md) and [artifact-workflow.md](./artifact-workflow.md).

## Object Flow

```text
DOIs
  -> candidate families
  -> qualified families
  -> citation contexts
  -> evaluation tasks
  -> evidence-backed tasks
  -> audit records
  -> adjudicated records
```

## Main Objects

| Object | Produced by | Used by | Meaning |
|--------|-------------|---------|---------|
| candidate family | `discover` | `screen` | A tracked claim candidate found from seed/citing-paper evidence |
| qualified family | `screen` | `extract` | A candidate family with grounding, auditability, and viability decisions |
| citation context | `extract` | `classify` | A citing-paper passage that appears to carry the attributed claim |
| evaluation task | `classify` | `evidence` | A citation context plus role and evaluation-mode metadata |
| evidence-backed task | `evidence` | `curate` | An evaluation task with cited-paper resolution and retrieved evidence spans |
| audit record | `curate` | `adjudicate` | A sampled record prepared for model or human adjudication |
| adjudicated record | `adjudicate` | benchmark/review workflows | An audit record with a support-style verdict, rationale, confidence, and retrieval-quality judgment; may include optional `fidelityVectorTrace` diagnostics when explicitly enabled |

## Current Executor Names

The not-yet-replaced executor currently writes:

- `screen` writes `_pre-screen-*`
- `extract` writes `_extraction-*`
- current adjudication artifacts use support-style verdicts
- optional `fidelityVectorTrace` diagnostics live inside adjudication records and are not a separate stage or artifact family

Superseded stage names and artifact suffixes are not accepted.
