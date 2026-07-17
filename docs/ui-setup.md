# UI Setup

For service and environment requirements, see [runtime-setup.md](./runtime-setup.md).

## Start the UI

From the repository root:

```bash
npm run ui:dev
```

`PALIMPSEST_ROOT` lets the workspace resolve the root SQLite database, `.env.local` / `.env`, and `data/runs/`.

## Build and start

```bash
npm run ui:build
npm run ui:start
```

## Runtime behavior

The UI creates DOI-first canonical runs and starts the six-stage CLI pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

It uses the same environment as the CLI:

- **Database** — required for local run state.
- **GROBID** — required for validated PDF parsing when structured text is unavailable.
- **`ANTHROPIC_API_KEY`** — required for model-backed canonical operations, including discovery extraction, Scope grounding, optional Evidence reranking, and eligible-record Adjudicate calls.

The UI does not support manual shortlist or tracked-claim starts, sampling/curation, advisor/vector routing, or any other old stage vocabulary. Old local SQLite rows and run directories from the former seven-stage executor may need deletion/recreation.

Canonical Adjudicate is runnable but **uncalibrated**; the UI must not present a completed run as validated fidelity measurement.
