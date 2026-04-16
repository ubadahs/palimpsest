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
- **ANTHROPIC_API_KEY**: Required for LLM-based stages (discover, screen, adjudicate)

### Optional Services

- **Semantic Scholar API key**: Higher rate limits
- **Institutional proxy**: Access paywalled papers (see `docs/runtime-setup.md`)

## Project Structure

```
src/
  cli/          Command entrypoints (index.ts dispatches to commands/)
  config/       Env loading (Zod-validated) and AppConfig construction
  domain/       Core taxonomy types and decision logic (pure, no I/O)
  health/       Health checks shared by CLI (doctor) and UI
  integrations/ External provider adapters + centralized LLM client
  pipeline/     Claim discovery, pre-screen, and full-analysis orchestration
  retrieval/    Chunking, BM25 ranking, LLM reranking, cited-span selection
  reporting/    JSON and Markdown artifact generation
  storage/      SQLite schema, migrations, repositories
  shared/       Cross-cutting primitives
  contract/  Shared stage/run types (consumed by both CLI and UI)
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
npm run dev -- pipeline --input dois.json  # full e2e pipeline
npm run ui:dev         # local Next.js UI
```

## Common Tasks

**Add a new command**: Create `src/cli/commands/my-command.ts`, register in `src/cli/index.ts`.

**Update domain schemas**: Edit types in `src/domain/`, update barrel export in `src/domain/types.ts`.

**Add a migration**: Create `src/storage/migrations/NNNN_description.sql`. Never modify existing migration files.

**Run a single stage**: `npm run dev -- extract --pre-screen /path/to/screen-output.json`

## Code Conventions

- ESM-only: all local imports must use `.js` extensions
- `import type` for type-only imports (enforced by ESLint)
- `Result<T>` for expected failures; throw only for programmer errors
- No `any` in production code; relaxed in tests
- Adapter interfaces on pipeline stages for dependency injection
