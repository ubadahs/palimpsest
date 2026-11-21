# UI Architecture

## Purpose

`apps/ui` is a local-only Next.js workspace for launching and inspecting the pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

It does not implement scientific pipeline logic. It creates DOI-first runs, launches `pipeline --run-id <uuid>`, stores run/stage state in SQLite, streams logs, and renders typed inspector payloads. It is not a hosted product.

## Routes

- `/` — dashboard and local health
- `/runs/new` — DOI-first run creation
- `/runs/[runId]` — run overview, six-stage rail, live logs, and artifacts
- `/runs/[runId]/stages/[stageKey]` — stage inspection
- `/evaluations` — frozen datasets, those with open grading requests first
- `/evaluations/[datasetId]` — what is waiting to be graded, and saved experiment results
- `/evaluations/[datasetId]/grade?request=<id>` or `?task=<task>` — blind grader, one case at a time
- `/two-hop-review` — human review of citation paths in a locally prepared study packet

## Report explorer

The Report stage (`/runs/[runId]/stages/report`) renders a typed report explorer rather than a raw dump:

- **Overview** — uncalibrated-output warning, F/D/E/U distribution with the adjudicated denominator, retrieval/adjudication coverage, and Discover→Adjudicate funnel cards
- **Families** — family-centered mutation view: sticky seed claim/grounding panel plus chronological citing restatements with deep links `?tab=families&family=<id>&record=<id>`
- **Statements** — exact citing wording and marked citation, credited group, linked source findings and quotes, and the retained wording or scope change. Fidelity verdicts appear beside their own records.
- **Citation history** shows saved histories for the active Report. A downstream use is displayed once. Paths link to it and show the evidence in the intermediate paper, the direct comparison with each original finding, co-citation, and model-call references. The view includes search coverage and a verified JSON download.
- **Records** — searchable/filterable per-record browser joined from Prepare, Evidence, and Adjudicate onto the report `recordTraces` spine (claims, citation context, retrieved passages, the seed passages a whole-paper verdict quoted, comparison/rationale, operational gates)
- **Review** — integrated human review queue/workspace against the current report lineage; Save draft / Mark final append immutable review events; export JSON/CSV
- **Audit trail** — method/lineage hashes, decision summaries, and links to authoritative JSON/Markdown/manifest artifacts

The completed-run overview links into this explorer with cautious “received F” wording. Report JSON remains authoritative; Markdown stays a derived technical artifact. Human reviews never mutate machine verdicts.

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
- `GET /api/runs/[runId]/history?report=<report-artifact-id>` — list verified history sidecars for this Report. Add `artifact=<history-artifact-id>` to inspect one, and `download=1` to download it.
- `POST /api/runs/[runId]/review/events` — append a draft/final review revision
- `GET /api/runs/[runId]/review/export?format=json|csv` — lineage-bound review export
- `GET /api/evaluations` — frozen datasets with their count of open grading requests
- `GET /api/evaluations/[datasetId]` — one dataset's blind cases, labels, and grading requests
- `GET /api/evaluations/[datasetId]/experiments` — saved experiments
- `POST /api/evaluations/[datasetId]/annotations` — append a blind annotation
- `POST /api/evaluations/[datasetId]/reveal` — record exposure before showing machine output
- `POST /api/evaluations/[datasetId]/results` — build a report from the annotation snapshot
- `GET` / `PUT /api/two-hop-review` — read study evidence and the reviewer's progress, or save a case assessment

`stageKey` accepts only `discover`, `scope`, `prepare`, `evidence`, `adjudicate`, or `report`.

## Grading

The report and evaluation workspaces share answer controls (`components/ui/choice-grid.tsx`) and a remembered reviewer name (`lib/reviewer.ts`).

- The Report explorer's **Review** tab labels the records of one run. Its store is the append-only review sidecar of that report.
- The **Evaluations** grader (`components/evaluation/`) labels the frozen cases of a dataset. A queue is either a grading request, which is a named, ordered set of cases created with `eval request`, or every case of one kind of question. `lib/evaluation-client.ts` resolves the queue from the URL and derives progress from the annotation log.

Both open blind: machine output stays hidden until the reviewer asks for it. Open grading requests are surfaced on the dashboard so the reviewer does not have to look for them.

The two-hop workspace reads the local evidence packet at `data/two-hop-review/study.json`. It shows the clauses where the middle paper cites the original beside the later paper’s marked citation to the middle paper. Bold text identifies the part under review. The original paper’s findings, the middle paper’s own results, full paragraphs, group references and available source texts are available to inspect. Each excerpt is bound to its source text. The page checks direct co-citation from the version-specific bibliography and marked group, including whether the bibliography scan was complete.

Choosing one answer saves a full-path judgment and opens the next unreviewed case. A case can cover multiple extractions of the same proposition at the same occurrence. The page resumes at the first unsaved case and supports a direct link such as `?case=C02`. The API serves an allowlist of evidence fields. Saved revisions live in `data/two-hop-review/answers/<study-hash>/<case-id>/`. When a packet is amended, a manifest in `data/two-hop-review/history/<new-study-hash>.json` can reference specific earlier answer revisions and explain their scope. An answer to the later hop alone stays available in the history and leaves the full-path question open. Inherited answers keep their original provenance. A new answer is appended under the new packet hash. The API rejects stale saves.

## Execution model

- One active local subprocess pipeline at a time.
- Run state and stage pointers persist in SQLite.
- Logs are written under `data/runs/<runId>/logs/`.
- Resume reuses the CLI validation path; succeeded artifacts are checked for lineage and tampering before continuation.
- Cancellation terminates the active subprocess only.

The UI must present Adjudicate as **uncalibrated**. A completed run is executable output, not validated fidelity evidence.
