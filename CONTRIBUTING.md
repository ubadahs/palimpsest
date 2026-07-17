# Contributing

## Development Setup

```bash
git clone <repo-url> && cd citation-fidelity
npm install
cp .env.example .env.local   # then edit with your keys
npm run dev -- doctor         # verify runtime health
npm run test                  # run tests
```

### Required Services

- **GROBID** (PDF parsing): `docker run -d -p 8070:8070 lfoppiano/grobid:0.8.1`
- **ANTHROPIC_API_KEY**: Required for LLM-backed canonical stages (discover extraction, scope grounding, optional evidence rerank, adjudicate)

### Optional Services

- **Semantic Scholar API key**: Higher rate limits
- **Institutional proxy**: Access paywalled papers (see `docs/runtime-setup.md`)

## Project Structure

```
src/
  adjudication/ Canonical adjudicate packet builders
  classification/ Deterministic citation-function and evaluation-mode helpers
  cli/          Command entrypoints (index.ts dispatches to commands/)
  config/       Env loading (Zod-validated) and AppConfig construction
  contract/     Shared stage/run types (consumed by both CLI and UI)
  domain/       Core taxonomy types and decision logic (pure, no I/O)
  health/       Health checks shared by CLI (doctor) and UI
  integrations/ External provider adapters + centralized LLM client
  pipeline/     Canonical six-stage orchestration and production adapters
  retrieval/    Full-text acquisition, parsing, BM25, canonical evidence retrieval
  reporting/    Canonical Report Markdown rendering
  storage/      SQLite schema, migrations, repositories
  shared/       Cross-cutting primitives
apps/ui/        Local-only Next.js dashboard
tests/          Mirrors src/ structure
```

## Key Commands

```bash
npm run build          # compile TypeScript
npm run typecheck      # tsc --noEmit (src + tests)
npm run lint           # eslint src tests
npm run format         # prettier --write
npm run test           # vitest run
npm run dev -- doctor  # check config and taxonomy
npm run dev -- pipeline --input dois.json  # canonical e2e pipeline
npm run ui:dev         # local Next.js UI
```

## Common Tasks

**Add a new command**: Create `src/cli/commands/my-command.ts`, register in `src/cli/index.ts`.

**Update domain schemas**: Prefer focused modules under `src/domain/` (`taxonomy.ts`, `classification.ts`, `common.ts`, `parsing.ts`). Import directly from those modules rather than a barrel.

**Add a migration**: Create `src/storage/migrations/NNNN_description.sql`. Never modify existing migration files.

**Run or resume the pipeline**: `npm run dev -- pipeline --input path/to/dois.json` or `npm run dev -- pipeline --run-id <uuid>`. Use `--stop-after <canonical-stage>` to halt early.

## Code Conventions

- ESM-only: all local imports must use `.js` extensions
- `import type` for type-only imports (enforced by ESLint)
- `Result<T>` for expected failures; throw only for programmer errors
- No `any` in production code; relaxed in tests
- Adapter interfaces on pipeline stages for dependency injection
- Do not reintroduce shortlist/pre-screen/extract/classify/curate stages, sampling, advisor/vector routing, or support-style labels
