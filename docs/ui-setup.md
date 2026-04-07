# UI Setup

For environment variables and service requirements, see [runtime-setup.md](./runtime-setup.md).

## Start the UI

From the repository root:

```bash
npm run ui:dev
```

This passes `PALIMPSEST_ROOT` into the UI workspace so the app can resolve:

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

The UI reads the same environment used by the CLI (including `.env.local` / `.env` at the repo root when resolved via `PALIMPSEST_ROOT`).

- **Database** — required for the app to function.
- **GROBID** — used for PDF → structured text and for seed full-text materialization. When it is down or unreachable, stages that need parsed full text (including **screen** seed parsing and **extract/evidence** PDF paths) fail or degrade according to each command’s behavior. The **GROBID Docker image is JVM-heavy**; reserving on the order of **3–4 GiB** RAM for the container is normal.
- **`ANTHROPIC_API_KEY`** — required for **`screen`** (full-manuscript LLM claim grounding) and for **`adjudicate`**. Without it, those commands exit early; `doctor` reports Anthropic as not configured.
- **Local reranker** (`LOCAL_RERANKER_BASE_URL`) — optional; health treats it as non-blocking when unset.

## Execution Model

- the UI launches the CLI as subprocesses from the repo root
- logs are streamed into `data/runs/<runId>/logs/`
- canonical stage artifacts remain the source of truth
- cancelling a run terminates the active subprocess only
