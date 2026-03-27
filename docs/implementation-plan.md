# Citation Fidelity Analyzer

## Implementation Plan

**Date:** March 2026  
**Status:** Draft  
**Implementation progress:** See [status.md](./status.md) for what is built in the repo today (CLI-aligned).  
**Purpose:** Translate the [PRD](./prd.md), [Build Spec](./build-spec.md), and [Evaluation Protocol](./evaluation-protocol.md) into an execution-oriented plan for a clean, type-safe, elegant codebase.

## Canonical Order

If documents conflict, follow this order:

1. [PRD](./prd.md)
2. [Build Spec](./build-spec.md)
3. [Evaluation Protocol](./evaluation-protocol.md)
4. This document

This document does not change product scope. It defines how to implement the scoped POC cleanly.

## Implementation Goal

Build the narrowest possible system that can:

- pre-screen candidate claim families for auditability and drift potential
- analyze eligible empirical-attribution citations
- compare citing claims against grounded cited spans
- store structured results locally
- generate reviewable outputs for a human reviewer

The first version should be a local CLI-driven codebase, not a platform.

## Default Technical Direction

This plan assumes a TypeScript-first implementation because type safety, explicit domain states, and schema-validated boundaries matter more than raw iteration speed for this POC.

Default choices:

- Language: TypeScript
- Runtime: Node.js
- Storage: SQLite
- Validation: runtime schemas at all external boundaries
- Testing: lightweight unit and fixture-based integration tests
- Interface: CLI scripts, not a web app

If the stack changes later, keep the same architectural rules and module boundaries.

## Codebase Principles

### Type Safety

- Enable strict TypeScript settings from day one.
- Do not use `any` outside scripts or tests.
- Validate all external data before it enters the domain layer.
- Represent domain states with explicit unions or enums instead of loose strings where practical.
- Keep one canonical definition for each domain type and import it rather than redefining shapes locally.
- Model expected absence and uncertainty explicitly. Do not hide them behind optional fields unless absence is the real domain state.

### Reuse and Consistency

- Before adding a new utility or helper, search the codebase for an existing function or module that already handles part of the job.
- Reuse existing patterns before inventing a new one.
- Extract shared logic into composable functions when there is a real repeated need.
- Stay DRY, but do not abstract on the first use.
- Do not create catch-all `utils` dumping grounds. Shared code must have a clear home and purpose.
- Similar workflows should follow similar shapes and naming patterns.

### Elegance

- Prefer small, focused functions with one clear responsibility.
- Prefer early returns over nested conditionals.
- Use descriptive names so code is readable without explanatory comments.
- Keep comments minimal and reserve them for domain constraints, subtle invariants, or non-obvious decisions.
- Remove dead code immediately.
- Do not leave commented-out code behind.
- Keep orchestration thin and push decision logic into testable functions.

### Composition

- Keep IO at the edges.
- Keep domain logic pure where possible.
- Compose pipeline steps from small functions instead of embedding all logic in one large service.
- Prefer plain functions over classes unless a class clearly improves lifecycle management or state handling.

## Architectural Rules

### Boundary Validation

Every external boundary must validate and normalize data:

- provider responses
- parsed XML or PDF output
- environment variables
- LLM outputs
- database row hydration when shapes can drift

Internal code should operate on normalized, typed objects rather than raw provider payloads.

### Error Handling

Use typed return values for expected operational outcomes:

- unresolved citation target
- no open-access full text
- retrieval found no grounded cited span
- LLM returned invalid JSON

Throw only for programmer errors or truly impossible states.

Do not collapse all failures into one generic error path. Preserve reason codes because they matter for auditability reporting.

### Persistence

SQLite access should live behind narrow repository functions or modules.

Pipeline code should not assemble raw SQL strings inline.

Keep storage models and domain models close but not conflated. It is acceptable for a database row shape to differ from the richer in-memory domain type if that keeps boundaries clear.

### Reporting

Treat structured JSON outputs as the canonical machine artifact.

Generate Markdown reports from typed intermediate report models rather than interleaving report formatting directly into pipeline logic.

### Prompting

Prompt modules must follow the product rules already defined in the build spec:

- separate extraction from judgment
- determine auditability before fidelity
- treat uncertainty as a valid outcome
- do not force fidelity labels from abstract-only evidence

Also follow these implementation rules:

- store prompts in dedicated modules rather than inline inside orchestration code
- use typed input and output contracts for every model call
- validate model outputs before accepting them
- use placeholders like `<DISEASE>` and `<GENE>` in reusable runtime prompts rather than hardcoded biomedical examples

## Proposed Repository Layout

Use a small, explicit structure:

```text
src/
  cli/
  config/
  domain/
  integrations/
  pipeline/
  retrieval/
  reporting/
  storage/
  shared/
scripts/
fixtures/
```

Module responsibilities:

- `cli/`: command entrypoints and argument parsing
- `config/`: env loading, app config, feature flags
- `domain/`: taxonomy, core types, decision logic, pure helpers
- `integrations/`: bioRxiv, OpenAlex, Semantic Scholar, LLM provider adapters
- `pipeline/`: pre-screen and full-analysis orchestration
- `retrieval/`: chunking, ranking, cited-span selection
- `reporting/`: JSON and Markdown artifact generation
- `storage/`: SQLite schema, migrations, repositories
- `shared/`: small cross-cutting primitives with clear ownership
- `scripts/`: one-off developer scripts only
- `fixtures/`: saved XML, paper text, and model-response samples for tests

Do not create empty directories or files just to satisfy a template. Add structure only when the code needs it.

## Preferred Module Shape

Within a feature area, prefer a small number of files with obvious roles:

- `types.ts` for exported types
- `schemas.ts` for runtime validation
- `service.ts` for feature logic when one module owns a cohesive workflow
- `repository.ts` for persistence access when needed
- `index.ts` only when it genuinely improves imports

Do not force this pattern everywhere. Use it when it makes the module easier to scan.

## Domain Modeling Rules

The core domain concepts should be explicit and centralized:

- paper
- citation
- citation function
- attributed claim
- auditability status
- fidelity label
- fidelity subtype
- evidence versus interpretation
- claim family

Important modeling guidance:

- represent `auditable`, `partially_auditable`, and `not_auditable` as first-class states
- represent `F`, `D`, `E`, and `U` as first-class states
- make it hard to produce a fidelity judgment without required grounding fields
- prefer discriminated unions when state changes affect which fields are valid

The type system should make invalid states harder to represent.

## Milestones

### Milestone 0: Bootstrap

Set up the repository for disciplined implementation.

Deliverables:

- TypeScript project with strict compiler settings
- lint, format, test, and typecheck scripts
- env configuration loader
- SQLite setup and migration strategy
- baseline folder structure
- core domain taxonomy types copied from the PRD

Definition of done:

- the project installs and runs locally
- typecheck and tests pass
- the codebase has one obvious place for domain types, config, storage, and pipeline code

### Milestone 1: Claim-Family Pre-Screen

Implement the first build-spec phase before the full analyzer.

Deliverables:

- input format for a shortlist of seed papers
- citation-network gathering around one tracked claim per seed
- open-access resolution checks
- lightweight full-text access checks
- auditability-status assignment for relevant edges
- auditable-edge coverage and rough drift-risk computation
- JSON and Markdown output for shortlist decisions

Definition of done:

- one CLI command runs end to end on a shortlist
- the output clearly shows greenlight versus deprioritize decisions
- no fidelity classification is attempted in this milestone

### Milestone 2: bioRxiv Ingestion And Citation Extraction

Build the citing-paper ingestion path.

Deliverables:

- bioRxiv XML fetch and parse flow
- reference-list extraction
- in-text citation marker extraction
- citation-context capture
- exact citing-span extraction candidates
- persistence for parsed papers and raw citation candidates

Definition of done:

- one bioRxiv paper can be ingested and stored locally
- citation candidates can be inspected without running later pipeline stages

### Milestone 3: Eligibility And Auditability Assessment

Filter citation candidates down to POC-eligible cases.

Deliverables:

- empirical-attribution eligibility check
- claim-specificity check
- auditability assessment before fidelity scoring
- explicit reasons for out-of-scope, partially auditable, and not auditable cases

Definition of done:

- out-of-scope and weakly grounded citations exit early with structured reasons
- no citation reaches fidelity scoring without passing eligibility and auditability gates

### Milestone 4: Cited-Paper Resolution And Retrieval

Implement cited-paper resolution and open-access retrieval.

Deliverables:

- OpenAlex-first resolution flow
- Semantic Scholar fallback flow
- open-access text retrieval
- caching of cited-paper metadata and parsed text
- reuse of cached papers across multiple citing papers

Definition of done:

- repeated citations to the same paper do not trigger repeated fetch-and-parse work
- inaccessible full text is recorded as an auditability outcome, not a silent failure

### Milestone 5: Candidate Span Retrieval

Implement simple, reliable retrieval before any more advanced methods.

Deliverables:

- paragraph and section chunking
- section labeling
- lexical ranking or BM25 retrieval
- cited-span provenance data
- abstract-only guardrails

Definition of done:

- the system returns a small set of ranked candidate spans with section labels
- edges without plausible non-abstract grounding are downgraded rather than guessed

### Milestone 6: LLM Analysis

Add model-based extraction and comparison only after the earlier layers work.

Deliverables:

- attributed-claim extraction prompt
- evidence-versus-interpretation prompt
- comparison and fidelity-label prompt
- typed JSON output validation
- invalid-output handling
- rationale and confidence capture

Definition of done:

- model outputs are schema-validated
- invalid or under-grounded cases are downgraded to `U`
- final judgments always include required spans and section labels

### Milestone 7: Reporting And Review Support

Generate artifacts that match the PRD and support the evaluation protocol.

Deliverables:

- per-paper JSON output
- per-paper Markdown report
- claim-family summary report
- mutation-map-friendly structured output
- reviewer export or review form seed data

Definition of done:

- one claim family can be reviewed manually using the evaluation protocol
- the report clearly separates auditability findings from fidelity findings

## First End-To-End Target

Do not aim for full corpus analysis first.

The first true end-to-end target is:

- one shortlisted claim family
- one seed claim
- a small local citation cluster
- at least one auditable edge carried through to a human-reviewable report

Once that works, expand to the second claim family required by the PRD.

## Testing Strategy

Prefer tests that lock down behavior at stable seams:

- parser tests using saved XML fixtures
- normalization tests for provider payloads
- retrieval tests using saved paper text fixtures
- domain logic tests for label gating and state transitions
- report tests for output shape

Use pure-function unit tests where possible.

Add a small number of fixture-based integration tests for the main pipeline seams. Avoid brittle tests that depend on live providers unless the test is explicitly marked as an integration script.

## Definition Of Done For Any Change

A change is complete only when all of the following are true:

- the code follows the established module and naming pattern
- no existing utility or module could have handled the job with a smaller change
- new shared logic was extracted only if the duplication was real
- the types remain precise
- boundary inputs and outputs are validated
- dead code and commented-out experiments are removed
- tests or fixtures were added when the behavior is important enough to lock down

## Working Rules For Future Agents

Before implementing:

1. Read the PRD, build spec, evaluation protocol, and this plan.
2. Search the codebase for an existing pattern before introducing a new helper or module.
3. Keep the current milestone narrow. Do not build later-stage infrastructure early.

While implementing:

1. Prefer editing an existing module over creating a parallel alternative.
2. Prefer small pure functions over large stateful services.
3. Use early returns and descriptive names.
4. Keep comments rare and meaningful.

After implementing:

1. Run typecheck and relevant tests.
2. Remove dead code and redundant abstractions.
3. Check whether the new code made the surrounding pattern more consistent or less consistent.

## Non-Goals For The Codebase

Do not optimize early for:

- a web application
- distributed processing
- multi-tenant storage
- benchmark infrastructure
- generalized citation analysis across all citation functions
- highly abstract plugin systems

The codebase should earn complexity only after the narrow POC works on real claim families.
