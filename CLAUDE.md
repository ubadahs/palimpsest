# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

CLI-first tooling for auditing citation fidelity in scientific literature. It analyzes whether citing papers faithfully represent the claims of cited papers, focused on empirical-attribution citations in bioRxiv preprints. Local SQLite storage, no web app.

The project follows a milestone-based implementation plan in `docs/implementation-plan.md`. **What is actually built today** is summarized in `docs/status.md` (CLI-aligned; update when phases land). The canonical design documents live in `docs/` (PRD, build spec, evaluation protocol, concept memo). Do not build infrastructure for later milestones early.

## Commands

```bash
npm run build          # tsc compile to dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run format         # prettier --write
npm run format:check   # prettier --check
npm run test           # vitest run (all tests)
npx vitest run tests/domain/taxonomy.test.ts  # single test file
npm run dev            # run CLI: tsx src/cli/index.ts
npm run dev -- doctor  # check config and taxonomy
npm run dev -- db:migrate  # apply pending SQLite migrations
npm run dev -- pre-screen --input shortlist.json  # pre-screen claim families
```

## Architecture

```
src/
  cli/          Command entrypoints (index.ts dispatches to commands/)
  config/       Env loading (Zod-validated) and AppConfig construction
  domain/       Core taxonomy types and decision logic (pure)
  integrations/ External provider adapters (bioRxiv, OpenAlex, Semantic Scholar, LLM)
  pipeline/     Pre-screen and full-analysis orchestration
  retrieval/    Chunking, ranking, cited-span selection
  reporting/    JSON and Markdown artifact generation
  storage/      SQLite schema, migrations (sequential .sql files), repositories
  shared/       Cross-cutting primitives
tests/          Mirrors src/ structure
```

### Key Patterns

- **Boundary validation**: All external data (API responses, env vars, LLM outputs, XML) is Zod-validated before entering the domain layer. Types are inferred from Zod schemas (`z.infer<typeof schema>`).
- **Domain taxonomy**: Core enums (CitationFunction, AuditabilityStatus, FidelityTopLabel, DistortionSubtype, ErrorSubtype, EvidenceVsInterpretation, ConfidenceLevel) live in `src/domain/taxonomy.ts`. Each has a `values` const array, a Zod schema, and an inferred type.
- **Typed error handling**: Expected failures (unresolved citation, no open-access text, invalid LLM JSON) use `Result<T>` return values (`{ ok: true; data: T } | { ok: false; error: string }`), not thrown exceptions. Throw only for programmer errors.
- **Dependency injection**: Pipeline orchestration accepts adapter interfaces so integration tests can use mocked adapters without network calls.
- **Migrations**: Sequential `.sql` files in `src/storage/migrations/` named `NNNN_description.sql`. Applied via `schema_migrations` table. Never modify existing migration files.
- **ESM modules**: The project uses `"type": "module"` with NodeNext resolution. All local imports must use `.js` extensions.
- **Type imports**: ESLint enforces `import type` for type-only imports (`@typescript-eslint/consistent-type-imports`).

### Domain Model

Fidelity labels are `F` (faithful), `D` (distortion), `E` (error), `U` (uncertain). Auditability gates (`auditable`, `partially_auditable`, `not_auditable`) must pass before fidelity scoring. The only citation function in POC scope is `empirical_attribution`.

## TypeScript Strictness

The tsconfig enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and all strict flags. `no-explicit-any` is enforced in src/ but relaxed in tests/.
