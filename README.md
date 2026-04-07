# Palimpsest

Palimpsest is CLI-first tooling for auditing citation fidelity in scientific literature. It follows a claim family outward from a seed paper, checks which downstream citations are actually auditable, extracts the claim-bearing citing passages, retrieves evidence from the cited paper, and writes local JSON and Markdown artifacts for review.

The CLI and artifacts are canonical. SQLite stores structured local state. The Next.js app in `apps/ui` is a local orchestration and inspection surface, not a separate hosted product.

## Quick Start

Install dependencies, verify the runtime, and initialize the local database:

```bash
npm install
npm run dev -- doctor
npm run dev -- db:migrate
```

`doctor` checks the runtime boundary. `GROBID_BASE_URL` must be configured; Anthropic is required only for stages that use LLMs. See [docs/runtime-setup.md](docs/runtime-setup.md).

## Main Ways To Run It

Run the full pipeline from DOI input:

```bash
npm run dev -- pipeline --input path/to/dois.json
```

Run stage by stage:

```bash
npm run dev -- discover --input path/to/dois.json
npm run dev -- screen --input path/to/shortlist.json
```

Run the local UI:

```bash
npm run ui:dev
```

See [docs/pipeline.md](docs/pipeline.md) for when to use each path and what every stage consumes and produces.

## Pipeline At A Glance

| Stage | Command | Purpose | Primary outputs |
|------|---------|---------|-----------------|
| Discover | `discover` | Extract candidate empirical claims from seed papers and build a shortlist | discovery results, discovery report, shortlist |
| Screen | `screen` | Ground the tracked claim and decide whether a claim family is viable for deeper analysis | pre-screen results, report, grounding trace |
| Extract | `extract` | Locate and normalize claim-bearing citation contexts in citing papers | extraction results, report, inspection notes |
| Classify | `classify` | Turn extracted mentions into evaluation packets | classification results, report |
| Evidence | `evidence` | Resolve the cited paper and attach retrieved evidence spans | evidence results, report |
| Curate | `curate` | Sample a balanced adjudication set from evidence-backed tasks | calibration set, worksheet |
| Adjudicate | `adjudicate` | Produce verdicts, rationales, and confidence for the sampled tasks | adjudicated calibration set, summary |

Canonical stage names are `discover`, `screen`, `extract`, `classify`, `evidence`, `curate`, and `adjudicate`. Some artifact filenames still preserve older prefixes such as `_pre-screen-*` and `_m2-extraction-*`; the stage contract is documented in [docs/pipeline.md](docs/pipeline.md) and [docs/artifact-workflow.md](docs/artifact-workflow.md).

## Where To Read

- [docs/pipeline.md](docs/pipeline.md) — canonical stage-by-stage workflow guide
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

See [package.json](package.json) for the full script list.
