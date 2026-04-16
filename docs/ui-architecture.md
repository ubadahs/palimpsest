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

- `/` dashboard with stats ribbon, grouped runs (active / completed / failed), and expandable system health
- `/runs/new` run creation
- `/runs/[runId]` run overview, stage rail, live log, and quick artifact access
- `/runs/[runId]/stages/[stageKey]` deep stage inspection

## API

Route handlers are local-only and back the client polling model:

- `GET /api/health`
- `GET /api/runs` — returns `{ health, stats, runs }` (`DashboardPollPayload`: aggregate counts, `RunSummary[]` including optional per-run `verdictSummary` for succeeded runs)
- `POST /api/runs`
- `GET /api/runs/[runId]`
- `POST /api/runs/[runId]/start`
- `POST /api/runs/[runId]/cancel`
- `GET /api/runs/[runId]/stages/[stageKey]` — returns a **stage group** (`RunStageGroupDetail`: `aggregateStatus`, `members[]` each a full `RunStageDetail`)
- `POST /api/runs/[runId]/stages/[stageKey]/rerun`
- `GET /api/runs/[runId]/stages/[stageKey]/log` — optional query `familyIndex` when logs differ per family row
- `GET /api/runs/[runId]/stages/[stageKey]/artifacts/[kind]` — optional query `familyIndex` (defaults to `0`) so parallel families do not collide on artifact paths

The UI supervisor still launches `pipeline --run-id <uuid>`; the CLI pipeline reads the run’s stored config from SQLite (see [status.md](./status.md) pipeline row).

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
- run schemas: dashboard/run detail use `stages: LogicalStageGroup[]` (one entry per `stageKey`, each with `aggregateStatus`, `members: AnalysisRunStage[]`, optional merged `summary`)
- `RunStageGroupDetail` / `RunStageDetail` for stage pages and polling
- `buildLogicalStageGroups`, `computeAggregateStageStatus` (`src/contract/stage-groups.ts`)
- environment health checks
- artifact discovery and stage-summary selectors (including stem-aware resolution for per-family artifacts)
- stage-specific inspector payload builders
- workflow snapshot types derived from `CF_PROGRESS` telemetry

Client components import only the client-safe `palimpsest/contract` entrypoint. Server code uses `palimpsest/contract/server`.
