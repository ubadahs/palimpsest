# Palimpsest

Palimpsest is local, CLI-first tooling for auditing citation fidelity in scientific literature. Starting from seed DOIs or a known claim shortlist, it follows claim families through the citing literature, checks auditability, retrieves cited-paper evidence, and writes reviewable JSON and Markdown artifacts.

The CLI and artifacts are the source of truth. SQLite stores local run state. The Next.js app in `apps/ui` is only a local orchestration and inspection surface; it is not a hosted product.

## Requirements

- Node.js 22+
- `GROBID_BASE_URL` for validated PDF parsing
- `ANTHROPIC_API_KEY` for LLM-backed stages: `discover`, `screen`, `pipeline`, `adjudicate`, and `evidence` when LLM reranking is enabled

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

Use an existing shortlist when the tracked claim is already known:

```bash
npm run dev -- pipeline --shortlist path/to/shortlist.json
```

Run stages directly when you want to inspect or rerun a specific handoff:

```bash
npm run dev -- discover --input path/to/dois.json
npm run dev -- screen --input path/to/shortlist.json
```

Run the local UI for orchestration, logs, and artifact inspection:

```bash
npm run ui:dev
```

Pipeline and UI artifacts are written locally under `data/runs/` when using managed runs. See [docs/pipeline.md](docs/pipeline.md) for each stage's inputs, outputs, and blocking behavior.

## Pipeline

| Stage | Purpose |
|------|---------|
| `discover` | Harvest citing-side mentions by default (**`attribution_first`** matches `pipeline`); use `--strategy legacy` for older seed-side claim extraction and optional ranking. |
| `screen` | Qualify claim families for downstream analysis with seed grounding, family filtering, and auditability checks. |
| `extract` | Locate and normalize claim-bearing citation contexts in citing papers. |
| `classify` | Convert citation contexts into evaluation tasks with role and mode metadata. |
| `evidence` | Resolve cited papers and attach retrieved evidence spans. |
| `curate` | Sample evidence-backed tasks into review-ready audit records. |
| `adjudicate` | Produce verdicts, rationales, confidence, and retrieval-quality judgments. |

## Where To Read

- [docs/pipeline.md](docs/pipeline.md) — stage-by-stage workflow guide
- [docs/artifact-workflow.md](docs/artifact-workflow.md) — artifact names, run layout, manifests, benchmark outputs
- [docs/runtime-setup.md](docs/runtime-setup.md) — environment variables, required services, failure and fallback behavior
- [docs/status.md](docs/status.md) — what is implemented in the repo today
- [docs/ui-setup.md](docs/ui-setup.md) — running the local UI
- [docs/README.md](docs/README.md) — full documentation map

## Common Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | CLI entry (`tsx src/cli/index.ts`) |
| `npm run build` | Clear `dist/`, then compile `src/` only |
| `npm run typecheck` | Typecheck `src/` and `tests/` |
| `npm run test` | Run root Vitest suite |
| `npm run lint` | Run ESLint over `src/` and `tests/` |
| `npm run lint:all` | Run root lint plus UI workspace lint |
| `npm run ui:dev` / `ui:build` / `ui:start` | Run the local Next.js UI |
| `npm --workspace @palimpsest/ui run test` | Run UI workspace tests |

See [package.json](package.json) for the full script list.
