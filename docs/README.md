# Documentation Guide

Use this as the map of the docs set. The goal is not to document every internal detail; it is to keep a small number of durable documents aligned with the workflow that actually exists.

If design documents disagree on scope, follow this order:

1. [pipeline.md](./pipeline.md) — runnable six-stage workflow
2. [status.md](./status.md) — what is implemented in the repo today
3. [adjudication-rubric.md](./adjudication-rubric.md) — F/D/E/U and Report denominator rules
4. [evaluation-protocol.md](./evaluation-protocol.md) — how uncalibrated outputs should be judged scientifically

## Start Here

- [../README.md](../README.md) — repo landing page, quick start, high-level workflow
- [runtime-setup.md](./runtime-setup.md) — environment variables, external services, required versus optional dependencies
- [pipeline.md](./pipeline.md) — runnable six-stage workflow
- [pipeline-concepts.md](./pipeline-concepts.md) — short object-flow glossary for the pipeline

## If You Want To Run Or Inspect The Tool

- [pipeline.md](./pipeline.md) — what each stage reads, writes, and decides
- [pipeline-concepts.md](./pipeline-concepts.md) — main objects that move through the stages
- [artifact-workflow.md](./artifact-workflow.md) — artifact roles, names, run layout, manifests
- [status.md](./status.md) — what is implemented in the repo today
- [evaluation.md](./evaluation.md) — freeze a report, add constructed cases with known verdicts, and compare providers locally; datasets stay gitignored
- [ui-setup.md](./ui-setup.md) — run the local Next.js UI
- [ui-architecture.md](./ui-architecture.md) — local UI routes, API, supervisor model, shared contract

## If You Want The Project Intent

- [concept-memo.md](./concept-memo.md) — why this project is worth testing
- [evaluation-protocol.md](./evaluation-protocol.md) — how uncalibrated outputs should be reviewed

## Focused Reference Docs

- [adjudication-rubric.md](./adjudication-rubric.md) — uncalibrated F/D/E/U rubric and Report denominator rules
- [caching.md](./caching.md) — paper and LLM exact-result cache behavior

## Lint And Tests

- Root package: `npm run lint` covers `src/` and `tests/`; `npm run test` runs Vitest for `tests/**/*.ts`
- UI workspace: `npm --workspace @palimpsest/ui run lint` and `npm --workspace @palimpsest/ui run test` (Vitest + `happy-dom`; `@vitejs/plugin-react` aligns with Vite 6 alongside root Vitest 3.x)
- Optional dead-code/unlisted-deps: `npx knip --reporter compact` uses root [`knip.json`](../knip.json); keep suppressions narrow so dead code stays visible

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
| Package exports | Verify [package.json](../package.json) exports still match docs that mention `palimpsest/contract` |
