# UI Setup

## Start the UI

From the repository root:

```bash
npm run ui:dev
```

This passes `CITATION_FIDELITY_ROOT` into the UI workspace so the app can resolve:

- the root SQLite database
- `.env.local` / `.env`
- `data/runs/`
- existing CLI artifacts and cache directories

## Build and Start

```bash
npm run ui:build
npm run ui:start
```

## Environment Notes

The UI reads the same environment used by the CLI.

- database access is required for the app to function
- GROBID blocks extraction and evidence stages when unavailable
- `ANTHROPIC_API_KEY` blocks `m6-llm-judge` only
- the local reranker is optional and shown as non-blocking health

## Execution Model

- the UI launches the CLI as subprocesses from the repo root
- logs are streamed into `data/runs/<runId>/logs/`
- canonical stage artifacts remain the source of truth
- cancelling a run terminates the active subprocess only
