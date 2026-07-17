# UI Architecture

## Purpose

`apps/ui` is a local-only Next.js workspace for launching and inspecting the canonical pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

It does not implement scientific pipeline logic. It creates DOI-first runs, launches `pipeline --run-id <uuid>`, stores run/stage state in SQLite, streams logs, and renders typed canonical inspector payloads. It is not a hosted product.

Old seven-stage UI/run state is unsupported. Existing local database rows or run directories may need deletion/recreation; the UI does not bridge shortlist, screen, extract, classify, curate, advisor, or vector-first artifacts into canonical runs.

## Routes

- `/` — dashboard and local health
- `/runs/new` — DOI-first run creation
- `/runs/[runId]` — run overview, six-stage rail, live logs, and artifacts
- `/runs/[runId]/stages/[stageKey]` — canonical stage inspection

## API

- `GET /api/health`
- `GET` / `POST /api/runs`
- `GET /api/runs/[runId]`
- `POST /api/runs/[runId]/start`
- `POST /api/runs/[runId]/cancel`
- `GET /api/runs/[runId]/cost`
- `GET /api/runs/[runId]/stages/[stageKey]`
- `POST /api/runs/[runId]/stages/[stageKey]/rerun`
- `GET /api/runs/[runId]/stages/[stageKey]/log`
- `GET /api/runs/[runId]/stages/[stageKey]/artifacts/[kind]`

`stageKey` accepts only `discover`, `scope`, `prepare`, `evidence`, `adjudicate`, or `report`.

## Execution model

- One active local subprocess pipeline at a time.
- Run state and stage pointers persist in SQLite.
- Logs are written under `data/runs/<runId>/logs/`.
- Resume reuses the canonical CLI validation path; succeeded artifacts are checked for lineage and tampering before continuation.
- Cancellation terminates the active subprocess only.

The UI must present canonical Adjudicate as **uncalibrated**. A completed run is executable output, not validated fidelity evidence.
