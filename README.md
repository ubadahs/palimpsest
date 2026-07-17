# Palimpsest

[![CI](https://github.com/ubadahs/palimpsest/actions/workflows/ci.yml/badge.svg)](https://github.com/ubadahs/palimpsest/actions/workflows/ci.yml)

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

The current executor also exposes direct stage commands for inspecting or rerunning a specific handoff:

```bash
npm run dev -- discover --input path/to/dois.json
npm run dev -- screen --input path/to/shortlist.json
```

Run the local UI for orchestration, logs, and artifact inspection:

```bash
npm run ui:dev
```

Pipeline and UI artifacts are written locally under `data/runs/` when using managed runs. See [docs/pipeline.md](docs/pipeline.md) for each stage's inputs, outputs, and blocking behavior.

## Output

In the current executor, each adjudicated claim family produces two artifacts under `data/runs/<run>/06-adjudicate/`:

- A **Markdown summary** (`_llm-summary.md`) — verdict distribution, verdict-by-mode and retrieval-quality breakdowns, and per-record notes on where a citing paper's attribution diverges from the cited text.
- A **JSON audit sample** (`_llm-audit-sample.json`) — the same verdicts with per-record evidence spans, confidence, retrieval-quality judgments, and full LLM-call provenance, so each conclusion is traceable to the cited source.

See [docs/artifact-workflow.md](docs/artifact-workflow.md) for the artifact layout and schemas.

## Pipeline

The canonical target is `discover → scope → prepare → evidence → adjudicate → report`. Its contracts are defined, but the runnable executor has not yet been replaced. Until that migration lands, the CLI and UI run these temporary stages:

| Current executor stage | Purpose |
|------|---------|
| `discover` | Harvest citing-side mentions by default (**`attribution_first`** matches `pipeline`); the temporary executor also exposes `--strategy legacy` for seed-side claim extraction and optional ranking. |
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
