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

## Report explorer

The Report stage (`/runs/[runId]/stages/report`) renders a typed report explorer rather than a raw dump:

- **Overview** — uncalibrated-output warning, F/D/E/U distribution with the adjudicated denominator, retrieval/adjudication coverage, and Discover→Adjudicate funnel cards
- **Families** — family-centered mutation view: sticky seed claim/grounding panel plus chronological citing restatements with deep links `?tab=families&family=<id>&record=<id>`
- **Records** — searchable/filterable per-record browser joined from Prepare, Evidence, and Adjudicate onto the report `recordTraces` spine (claims, citation context, evidence passages, comparison/rationale, operational gates)
- **Review** — integrated human review queue/workspace against the current report lineage; Save draft / Mark final append immutable review events; export JSON/CSV
- **Audit trail** — method/lineage hashes, decision summaries, and links to authoritative JSON/Markdown/manifest artifacts

The completed-run overview links into this explorer with cautious “received F” wording. Canonical Report JSON remains authoritative; Markdown stays a derived technical artifact. Human reviews never mutate machine verdicts.

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
- `GET /api/runs/[runId]/review` — current report-bound review state/progress/head
- `POST /api/runs/[runId]/review/events` — append a draft/final review revision
- `GET /api/runs/[runId]/review/export?format=json|csv` — lineage-bound review export

`stageKey` accepts only `discover`, `scope`, `prepare`, `evidence`, `adjudicate`, or `report`.

## Execution model

- One active local subprocess pipeline at a time.
- Run state and stage pointers persist in SQLite.
- Logs are written under `data/runs/<runId>/logs/`.
- Resume reuses the canonical CLI validation path; succeeded artifacts are checked for lineage and tampering before continuation.
- Cancellation terminates the active subprocess only.

The UI must present canonical Adjudicate as **uncalibrated**. A completed run is executable output, not validated fidelity evidence.
