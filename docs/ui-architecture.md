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
- `/evaluations` — frozen datasets, those with open grading requests first
- `/evaluations/[datasetId]` — what is waiting to be graded, and saved experiment results
- `/evaluations/[datasetId]/grade?request=<id>` or `?task=<task>` — blind grader, one case at a time

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
- `GET /api/evaluations` — frozen datasets with their count of open grading requests
- `GET /api/evaluations/[datasetId]` — one dataset's blind cases, labels, and grading requests
- `GET /api/evaluations/[datasetId]/experiments` — saved experiments
- `POST /api/evaluations/[datasetId]/annotations` — append a blind annotation
- `POST /api/evaluations/[datasetId]/reveal` — record exposure before showing machine output
- `POST /api/evaluations/[datasetId]/results` — build a report from the annotation snapshot

`stageKey` accepts only `discover`, `scope`, `prepare`, `evidence`, `adjudicate`, or `report`.

## Grading

Two places take human labels, and they share one set of answer controls (`components/ui/choice-grid.tsx`) and one remembered reviewer name (`lib/reviewer.ts`):

- The Report explorer's **Review** tab labels the records of one run. Its store is the append-only review sidecar of that report.
- The **Evaluations** grader (`components/evaluation/`) labels the frozen cases of a dataset. A queue is either a grading request, which is a named, ordered set of cases created with `eval request`, or every case of one kind of question. `lib/evaluation-client.ts` resolves the queue from the URL and derives progress from the annotation log.

Both open blind: machine output stays hidden until the reviewer asks for it. Open grading requests are surfaced on the dashboard so the reviewer does not have to look for them.

## Execution model

- One active local subprocess pipeline at a time.
- Run state and stage pointers persist in SQLite.
- Logs are written under `data/runs/<runId>/logs/`.
- Resume reuses the canonical CLI validation path; succeeded artifacts are checked for lineage and tampering before continuation.
- Cancellation terminates the active subprocess only.

The UI must present canonical Adjudicate as **uncalibrated**. A completed run is executable output, not validated fidelity evidence.
