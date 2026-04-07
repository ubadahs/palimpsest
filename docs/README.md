# Documentation Guide

Use this as the map of the docs set. The goal is not to document every internal detail; it is to keep a small number of durable documents aligned with the workflow that actually exists.

If design documents disagree on scope, follow this order:

1. [prd.md](./prd.md)
2. [build-spec.md](./build-spec.md)
3. [evaluation-protocol.md](./evaluation-protocol.md)
4. [implementation-plan.md](./implementation-plan.md)

## Start Here

- [../README.md](../README.md) — repo landing page, quick start, high-level workflow
- [runtime-setup.md](./runtime-setup.md) — environment variables, external services, required versus optional dependencies
- [pipeline.md](./pipeline.md) — canonical stage-by-stage workflow guide

## If You Want To Run Or Inspect The Tool

- [pipeline.md](./pipeline.md) — what each stage reads, writes, and decides
- [artifact-workflow.md](./artifact-workflow.md) — artifact names, run layout, manifests, benchmark outputs
- [status.md](./status.md) — what is implemented in the repo today
- [ui-setup.md](./ui-setup.md) — run the local Next.js UI
- [ui-architecture.md](./ui-architecture.md) — local UI routes, API, supervisor model, shared contract

## If You Want The Project Intent

- [concept-memo.md](./concept-memo.md) — why this project is worth testing
- [prd.md](./prd.md) — canonical scope, taxonomy, outputs, success criteria
- [build-spec.md](./build-spec.md) — minimum implementation and non-goals
- [evaluation-protocol.md](./evaluation-protocol.md) — how the POC is judged
- [implementation-plan.md](./implementation-plan.md) — execution-oriented plan for the scoped POC

## Focused Reference Docs

- [adjudication-rubric.md](./adjudication-rubric.md) — current adjudication output shape and rubric notes
- [eval-reranker-model-selection.md](./eval-reranker-model-selection.md) — reranker evaluation note and current retrieval-model rationale

## Lint And Tests

- Root package: `npm run lint` covers `src/` and `tests/`; `npm run test` runs Vitest for `tests/**/*.ts`
- UI workspace: `npm --workspace @palimpsest/ui run lint` and `npm --workspace @palimpsest/ui run test`

## Large-Change Checklist

Before merging a large workflow, artifact, or UI change:

| Check | Action |
|--------|--------|
| Tree vs agent docs | Verify `src/` and `apps/` still match [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) |
| Stage contract | If stage names, order, inputs, or outputs changed, update [pipeline.md](./pipeline.md) and [artifact-workflow.md](./artifact-workflow.md) |
| Runtime boundary | If env vars or service requirements changed, update [runtime-setup.md](./runtime-setup.md), [ui-setup.md](./ui-setup.md), and the root [README.md](../README.md) |
| UI wording | Search `*.md` for stale wording about the local UI or hosted-product boundary |
| Run layout | Verify stage folders under `data/runs/<runId>/` still match [artifact-workflow.md](./artifact-workflow.md) |
| Status ledger | Update [status.md](./status.md) when shipped behavior materially changes |
| Package exports | Verify [package.json](../package.json) exports still match docs that mention `palimpsest/ui-contract` |
