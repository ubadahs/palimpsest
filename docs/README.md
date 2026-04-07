# Documentation index

Non-normative map of **where to look**.

## Execution and current state

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
