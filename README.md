# Citation Fidelity

CLI-first tooling for auditing **citation fidelity** in scientific literature: it checks whether citing papers faithfully represent empirical-attribution claims from cited papers (bioRxiv-focused POC). The **CLI and JSON/Markdown artifacts are canonical**; SQLite stores structured state locally. A **local-only** Next.js app in `apps/ui` can orchestrate pipeline stages and inspect artifacts—there is no hosted product UI.

## Quick start

```bash
npm install
npm run dev -- doctor
npm run dev -- db:migrate
```

Run a stage from the repo root (example):

```bash
npm run dev -- pre-screen --input path/to/shortlist.json
```

**Local UI:** see [docs/ui-setup.md](docs/ui-setup.md) (`npm run ui:dev`).

## Where to read

- [docs/README.md](docs/README.md) — index of all documentation
- [docs/status.md](docs/status.md) — what is implemented today
- [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) — conventions for working in this repo

## Common scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | CLI entry (`tsx src/cli/index.ts`) |
| `npm run build` | Clear `dist/`, then compile `src/` only (no test emit) |
| `npm run typecheck` | Typecheck `src/` + `tests/` |
| `npm run test` | Vitest for root `tests/**/*.ts` |
| `npm run lint` | ESLint for `src/` + `tests/` |
| `npm run lint:all` | Root lint + UI workspace lint |
| `npm run ui:dev` / `ui:build` / `ui:start` | Local Next.js UI |

See [package.json](package.json) for the full list.
