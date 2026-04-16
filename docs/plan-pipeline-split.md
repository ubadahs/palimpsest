# Plan: Split `cli/commands/pipeline.ts`

## Problem

`pipeline.ts` is 1760 lines — the largest file in the codebase. It mixes three
distinct responsibilities:

1. **CLI concerns** — arg parsing, env loading, input file resolution, run
   identity, signal handling, cost summary printing
2. **Run orchestration** — stage sequencing, resume logic, DB stage tracking,
   handoff serialization, per-family parallel dispatch
3. **Per-stage wiring** — for each of the 7 stages, a block that loads
   artifacts, calls pipeline logic, writes output artifacts, updates DB rows

This makes it hard to test the orchestration logic (it's buried inside a CLI
command) and hard to read (1760 lines of mixed abstraction levels).

## Proposed Structure

```
src/
  cli/commands/
    pipeline.ts          (~200 lines)  CLI entry: parse args, load env, delegate
  pipeline/
    run-orchestrator.ts  (~300 lines)  Stage sequencing, resume, DB tracking
    run-tracker.ts       (~120 lines)  DB helpers: trackStageStart/Success/Blocked
    family-runner.ts     (~500 lines)  Per-family stage loop: extract→…→adjudicate
    cost-summary.ts      (~60 lines)   Ledger aggregation by stage
```

### What goes where

**`cli/commands/pipeline.ts` (stays, shrinks to ~200 lines)**
- `parseArgs()` — unchanged
- `runPipelineCommand()` — becomes thin: parse args, load env, build config,
  call `orchestrateRun()`, handle top-level errors, close DB

**`pipeline/run-tracker.ts` (new, ~120 lines)**
Extract the inner functions currently nested inside `runPipelineCommand`:
- `trackStageStart()`
- `trackStageSuccess()`
- `trackStageBlocked()`
- `trackRunFailed()`
- `blockPendingFamilyStages()`
- `succeededArtifact()`

These are pure DB helpers that take a database handle and run ID. No reason for
them to be closures inside a 1300-line function body.

**`pipeline/run-orchestrator.ts` (new, ~300 lines)**
The top-level flow that currently lives inside the try block (lines 604–1743):
- Build run config from CLI overrides + defaults
- Resolve/create run directory
- Stage 1: discover (or resume from shortlist)
- Stage 2: screen (or resume)
- Dispatch per-family stages via `runFamilyStages()`
- Final cost summary + status update

Signature:
```typescript
export async function orchestrateRun(params: {
  runId: string;
  config: AnalysisRunConfig;
  database: Database.Database;
  apiKey: string;
  appConfig: AppConfig;
  outputDir: string;
  args: PipelineCliOverrides;
}): Promise<void>;
```

**`pipeline/family-runner.ts` (new, ~500 lines)**
The per-family body currently inside the `pMap` callback (lines 1190–1741):
extract → classify → evidence → curate → adjudicate for one family index.

Signature:
```typescript
export async function runFamilyStages(params: {
  familyIndex: number;
  family: ProcessableFamily;
  tracker: RunTracker;
  llmClient: LLMClient;
  adapters: FamilyStageAdapters;
  outputDir: string;
  stamp: string;
  config: AnalysisRunConfig;
}): Promise<FamilyStageResult>;
```

**`pipeline/cost-summary.ts` (new, ~60 lines)**
Extract `summarizeLedgerByStage()` — currently at line 392, a pure function
with no dependencies on the rest of the file.

## Execution Plan

The split is mechanical — move code blocks, add import/export, update one
call site. No logic changes.

1. Extract `cost-summary.ts` (pure function, zero risk)
2. Extract `run-tracker.ts` (convert closures to explicit params)
3. Extract `family-runner.ts` (the pMap body)
4. Extract `run-orchestrator.ts` (the try-block body)
5. Thin `pipeline.ts` to parse args + delegate
6. Build, lint, test at each step

## Risk

Low. Every extraction is a cut-and-paste with an added function signature.
No behavior changes. The existing test suite (258 tests) validates nothing
breaks. The orchestration logic has no unit tests today, so the refactor
can't regress anything — it only makes future testing easier.

## Not in Scope

- Changing the stage logic itself
- Adding new tests (that's a separate task)
- Splitting `fulltext-fetch.ts` or `pre-screen.ts` (separate effort)
