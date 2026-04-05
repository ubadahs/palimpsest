# UI Architecture

## Purpose

`apps/ui` is a local-only Next.js App Router workspace that sits on top of the canonical CLI and artifact workflow.

The UI does not reimplement pipeline logic. It:

- creates run-scoped shortlist input
- launches CLI subprocesses stage by stage
- records run/stage state in SQLite
- streams logs into run-scoped log files
- loads and inspects canonical JSON / Markdown / manifest artifacts
- derives a natural-language workflow checklist from structured stage telemetry embedded in those logs

## Routes

- `/` dashboard with environment health and recent runs
- `/runs/new` run creation
- `/runs/[runId]` run overview, stage rail, live log, and quick artifact access
- `/runs/[runId]/stages/[stageKey]` deep stage inspection

## API

Route handlers are local-only and back the client polling model:

- `GET /api/health`
- `GET /api/runs`
- `POST /api/runs`
- `GET /api/runs/[runId]`
- `POST /api/runs/[runId]/start`
- `POST /api/runs/[runId]/cancel`
- `GET /api/runs/[runId]/stages/[stageKey]`
- `POST /api/runs/[runId]/stages/[stageKey]/rerun`
- `GET /api/runs/[runId]/stages/[stageKey]/log`
- `GET /api/runs/[runId]/stages/[stageKey]/artifacts/[kind]`

## Job Model

- one active run at a time in v1
- subprocess execution through `npm run cli -- <command> ...`
- module-global supervisor state in the UI server process
- persisted `process_id` and startup reconciliation for interrupted runs
- per-stage log file append in `data/runs/<runId>/logs/`

## Workflow Progress

- stages emit one-line `CF_PROGRESS {...}` telemetry markers to the existing per-stage logs
- the UI parses those markers server-side into ordered workflow snapshots with step labels, descriptions, and optional counters
- `RunDetail` exposes the active stage workflow for the run overview page
- `RunStageDetail` exposes the stage workflow for the deep inspection page
- historical runs without telemetry fall back to honest inferred states from stage status rather than synthetic fine-grained replay
- raw logs remain canonical; the workflow checklist is an explanatory layer on top of them

## Shared Contract

The root package exposes a narrow shared contract for the UI:

- stage keys and ordering
- run and run-stage schemas
- environment health checks
- artifact discovery and stage-summary selectors
- stage-specific inspector payload builders

Client components import only the client-safe `citation-fidelity/ui-contract` entrypoint. Server code uses `citation-fidelity/ui-contract/server`.
