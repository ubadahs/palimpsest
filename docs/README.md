# Documentation index

Non-normative map of **where to look**. If documents disagree on product scope, follow the order in [implementation-plan.md](./implementation-plan.md) (PRD → Build Spec → Evaluation Protocol → this plan).

## Product and evaluation

- [prd.md](./prd.md) — scope, taxonomy, success criteria
- [build-spec.md](./build-spec.md) — minimum implementation vs non-goals
- [evaluation-protocol.md](./evaluation-protocol.md) — how the POC is evaluated

## Execution and current state

- [implementation-plan.md](./implementation-plan.md) — how to implement the scoped POC
- [status.md](./status.md) — **what exists in the repo today** (keep this current)

## Artifacts, runs, and UI

- [artifact-workflow.md](./artifact-workflow.md) — CLI artifacts, manifests, benchmark flow, stage naming
- [ui-setup.md](./ui-setup.md) — running the local Next.js UI
- [ui-architecture.md](./ui-architecture.md) — UI routes, API, job model, shared contract

## Operations

- [ops-setup.md](./ops-setup.md) — environment and service setup
- [artifact-workflow.md](./artifact-workflow.md) — also covers `data/` policy

## Lint and tests (monorepo)

- **Root package:** `npm run lint` covers `src/` and `tests/` only. `npm run test` runs Vitest for `tests/**/*.ts`.
- **UI workspace:** `npm --workspace @palimpsest/ui run lint` and `npm --workspace @palimpsest/ui run test` (or `npm run lint:all` from root for both linters).

## Release / large-change checklist (avoid stale docs)

Before tagging a release or merging a large feature:

| Check | Action |
|--------|--------|
| Tree vs agents | `src/` and `apps/` match the architecture block in [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md) |
| UI wording | Search `*.md` for outdated phrases like “no web app” without the local-UI clarification |
| Paths | Stage folders under `data/runs/<runId>/` match [artifact-workflow.md](./artifact-workflow.md) |
| Status date | [status.md](./status.md) **Last updated** reflects the change |
| Package exports | [package.json](../package.json) `exports` match docs that mention `palimpsest/ui-contract` |
