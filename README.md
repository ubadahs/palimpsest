# Palimpsest

[![CI](https://github.com/ubadahs/palimpsest/actions/workflows/ci.yml/badge.svg)](https://github.com/ubadahs/palimpsest/actions/workflows/ci.yml)

Palimpsest is local, CLI-first tooling for auditing citation fidelity in scientific literature. Starting from seed DOIs, it follows claim families through the citing literature, retrieves cited-paper evidence, and writes reviewable JSON and Markdown artifacts.

The CLI and artifacts are the source of truth. SQLite stores local run state. The Next.js app in `apps/ui` is only a local orchestration and inspection surface; it is not a hosted product.

## Requirements

- Node.js 22+
- `GROBID_BASE_URL` for validated PDF parsing
- `ANTHROPIC_API_KEY` for model-backed canonical pipeline work, including attributed-claim extraction, grounding, evidence reranking (on by default), and eligible-record adjudication.

See [docs/runtime-setup.md](docs/runtime-setup.md) for environment variables, GROBID setup, and optional providers.

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run dev -- doctor
npm run dev -- db:migrate
```

`doctor` checks the local runtime boundary. It fails if GROBID is unreachable, and reports Anthropic as configured or missing based on the stages you can run.

## Run

Use a DOI-first run when Palimpsest should discover claim families from citing behavior:

```json
{
  "dois": ["10.0000/example"]
}
```

```bash
npm run dev -- pipeline --input path/to/dois.json
```

Stop after a canonical stage or resume a managed run:

```bash
npm run dev -- pipeline --input path/to/dois.json --stop-after evidence
npm run dev -- pipeline --run-id <uuid>
```

Estimated spend is kept current in `cost-summary.json` at the run root. Cap it, or send model requests through Anthropic's Message Batches API at half price (slower; see [docs/pipeline.md](docs/pipeline.md)):

```bash
npm run dev -- pipeline --input path/to/dois.json --max-cost 4
npm run dev -- pipeline --input path/to/dois.json --batch
```

`--census` analyzes every citer and keeps every claim family instead of sampling; pair it with a cost cap:

```bash
npm run dev -- pipeline --input path/to/dois.json --census --max-cost 40
```

Scope also builds a codebook of the seed paper's citable statements, stores it so later runs of the same seed reuse it, and tags every citing claim with the entries it is about; the report adds per-entry and per-theme tables beside the claim families. `--force-refresh` keeps the stored codebook; to replace it:

```bash
npm run dev -- pipeline --run-id <uuid> --rerun-from scope --regenerate-codebook
```

Run the local UI for orchestration, logs, and artifact inspection:

```bash
npm run ui:dev
```

Pipeline and UI artifacts are written locally under `data/runs/` when using managed runs. Old local database rows and run directories from the superseded seven-stage executor are unsupported; delete/recreate them rather than attempting to resume or bridge them.

`eval` freezes a finished report into local cases under `data/evaluations/` and compares providers on them. It can add constructed cases, whose right verdict is known because they edit a restatement a reviewer called faithful, and it can compare adjudicating from retrieved chunks with adjudicating from the whole cited paper. A reviewer grades cases blind in the local UI, one at a time, and `eval request` queues the few cases a comparison turns on. Those datasets and trials are gitignored. See [docs/evaluation.md](docs/evaluation.md).

## Output

The final `report` stage writes authoritative JSON funnel/rate/trace accounting and a deterministic Markdown rendering under `data/runs/<run>/05-report/`. Canonical Adjudicate's `F`/`D`/`E`/`U` outcomes are **uncalibrated**; a runnable pipeline is not a validated method or a basis for trust claims.

## Pipeline

The runnable production pipeline is `discover → scope → prepare → evidence → adjudicate → report`. These are the only public CLI stage keys. It is DOI-first only: manual shortlist and tracked-claim starts are removed. Discover selects an adaptive claim portfolio (default 15–25 families) under a prepared-record budget; Evidence retrieves from occurrence-local claims and skips reranking when verified grounding pins already fill the packet. There is no sampling or `curate` stage. The source tree is canonical-only after the six-stage cutover cleanup.

Model calls default to Claude Haiku 5.5 (claim extraction, citation roles, reranking) and Sonnet 5.5 (claim clustering, seed grounding, adjudication). Each can be changed in the run config. The adjudicator reads the whole cited paper and must quote the passages its verdict rests on; each quote is checked against the paper's text.

## Where To Read

- [docs/pipeline.md](docs/pipeline.md) — stage-by-stage workflow guide
- [docs/artifact-workflow.md](docs/artifact-workflow.md) — artifact names, run layout, manifests
- [docs/runtime-setup.md](docs/runtime-setup.md) — environment variables, required services, failure and fallback behavior
- [docs/status.md](docs/status.md) — what is implemented in the repo today
- [docs/evaluation.md](docs/evaluation.md) — local evaluation: frozen cases, constructed cases, provider comparisons; datasets stay out of git
- [docs/ui-setup.md](docs/ui-setup.md) — running the local UI
- [docs/README.md](docs/README.md) — full documentation map

## Common Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | CLI entry (`tsx src/cli/index.ts`) |
| `npm run build` | Clear `dist/`, then compile `src/` only |
| `npm run typecheck` | Typecheck `src/` and `tests/` |
| `npm run test` | Run root Vitest suite |
| `npm run test:live-smoke` | Optional live dual-DOI smoke (`PALIMPSEST_LIVE_SMOKE=1`; non-CI) |
| `npm run lint` | Run ESLint over `src/` and `tests/` |
| `npm run lint:all` | Run root lint plus UI workspace lint |
| `npm run typecheck:all` | Typecheck root and the UI workspace |
| `npm run db:gc -- --days 90 [--dry-run]` | Delete aged run-registry rows, stale LLM cache rows, and expired batch request rows (never stored seed codebooks) |
| `npm run runs:gc -- [--run-id <uuid>] [--dry-run]` | Delete superseded stage attempts and the provenance only they referenced |
| `npm run ui:dev` / `ui:build` / `ui:start` | Run the local Next.js UI |
| `npm --workspace @palimpsest/ui run test` | Run UI workspace tests |

See [package.json](package.json) for the full script list.
