# Plan: Add evidence-conditioned `fidelityVectorTrace` to adjudication

## Purpose

Add an evidence-conditioned, multi-sampled diagnostic trace to adjudicated audit records:

```ts
fidelityVectorTrace?: FidelityVectorTrace
```

The trace should make Palimpsest adjudication more informative than a single categorical verdict while preserving the existing pipeline contract, artifact filenames, benchmark semantics, and canonical support-style verdicts.

This is intended as one branch and one PR, implemented as small commits. The feature must remain gated and disabled by default on `main`, even if the working branch uses it for exploratory test runs.

## Non-goals

Do not do any of the following in this PR:

- Do not add a new pipeline stage.
- Do not change stage keys or stage order.
- Do not rename artifact suffixes.
- Do not rename legacy `_m2-*` artifact suffixes.
- Do not replace canonical verdicts.
- Do not change advisor escalation policy.
- Do not change curation behavior.
- Do not use vector scores to drive curation, escalation, or final verdicts.
- Do not implement apparent/prior versus evidence/posterior support shift.
- Do not add batched one-call multi-sample mode in v1.
- Do not add MCTS, graph search, or multi-hop drift logic.
- Do not create a calibration dataset in this PR.
- Do not add a large UI visualization.

The new field is diagnostic output only.

## Current Codebase Facts

### Pipeline and artifacts

The canonical pipeline is:

```text
discover -> screen -> extract -> classify -> evidence -> curate -> adjudicate
```

Stage definitions live in `src/contract/stages.ts`. The adjudicate stage currently writes:

- primary JSON artifact with suffix `_llm-audit-sample.json`
- Markdown summary with suffix `_llm-summary.md`
- optional agreement sidecar

No artifact suffixes or stage definitions should change.

### Current adjudication record shape

`src/domain/adjudication.ts` defines `adjudicationRecordSchema`. It already carries the compact material needed for adjudication:

- `recordId`
- `taskId`
- `evaluationMode`
- `citationRole`
- `modifiers`
- `citingPaperTitle`
- `citedPaperTitle`
- `groundedSeedClaimText`
- `citingSpan`
- `citingSpanSection`
- `citingMarker`
- `seedRefLabel`
- `rubricQuestion`
- `evidenceSpans`
- `evidenceRetrievalStatus`
- canonical adjudication outputs: `comparison`, `verdict`, `rationale`, `retrievalQuality`, `judgeConfidence`, `adjudicator`, `adjudicatedAt`, `telemetry`
- exclusion fields

The schema is `.passthrough()`, but `fidelityVectorTrace` should still be explicitly modeled for typed access and validation.

### Current evidence flow

The adjudicator does not receive the full cited-paper text today.

The current flow is:

```text
parsed cited paper
  -> BM25 retrieval over parsed blocks
  -> optional LLM rerank of curated tasks
  -> extracted evidence snippets
  -> AuditSample records
  -> adjudicator prompt
```

Key files:

- `src/retrieval/evidence-retrieval.ts`
- `src/retrieval/llm-reranker.ts`
- `src/adjudication/sample-audit.ts`
- `src/adjudication/llm-adjudicator.ts`

`retrieveEvidence()` ranks cited-paper blocks and returns `citedPaperEvidenceSpans`. `llmRerankBlocks()` can extract the 1-3 most relevant sentences from candidate blocks. `sampleAuditSet()` copies these spans into `AdjudicationRecord.evidenceSpans`.

Vector tracing must reuse these snippets. It must not send full cited-paper text to vector sample calls.

### Current citation-scope handling

`src/shared/citation-context-window.ts` provides:

- `extractCitingWindow()`
- `annotateCitingContext()`

The current adjudicator prompt uses:

```ts
annotateCitingContext(
  extractCitingWindow(record.citingSpan, record.seedRefLabel ?? record.citingMarker, 800),
  record.citingMarker,
  record.seedRefLabel,
)
```

This preserves a focused citing context, uses `seedRefLabel` when available, and marks sentences attributed to the cited paper with `▶ ... ◀`. The packet refactor must preserve this behavior.

### Current evidence formatting

`src/adjudication/llm-adjudicator.ts` currently formats only the top 3 evidence spans:

- includes the evidence legend
- includes `matchMethod`
- includes LLM rerank relevance only for `llm_reranked`
- includes `sectionTitle`
- includes span text
- emits retrieval warnings for statuses such as `no_fulltext`, `abstract_only_matches`, `unresolved_cited_paper`, and `no_matches`

The packet abstraction must preserve this formatting and top-3 logic unless tests deliberately show a behavior-preserving equivalent.

### Current advisor flow

`src/adjudication/llm-adjudicator.ts` has:

- `runPass()` for a single adjudication pass
- `runAdvisorAdjudication()` for first pass plus escalation
- `adjudicateAuditSample()` as public entry point

Advisor mode currently:

1. Runs first pass.
2. Selects escalation records by existing policy.
3. Runs escalation subset.
4. Merges escalated records back over first-pass records.

Vector tracing must not run inside `runPass()` if that would trace intermediate first-pass advisor records. It must run only after final adjudicated records are known.

### Current LLM client and telemetry

`src/integrations/llm-client.ts` defines `llmPurposeValues`. Current purposes include:

- `claim-discovery`
- `seed-grounding`
- `claim-family-filter`
- `adjudication`
- `evidence-rerank`
- `attributed-claim-extraction`
- `family-consolidation`

Add `"fidelity-vector"` as a distinct purpose.

The client already supports purpose-level ledger aggregation through `getLedger()`. Persistent exact-result caching is opt-in via `exactCache`. Vector sample calls must not pass `exactCache`.

`generateObject()` currently does not appear to expose temperature. Add temperature support only if needed, and keep it backward-compatible.

### Current benchmark blind behavior

`src/benchmark/workflow.ts` strips adjudication outputs from active records in `blindRecord()`. `src/benchmark/types.ts` defines `blindAdjudicationRecordSchema` by omitting canonical adjudication fields.

`fidelityVectorTrace` is adjudication outcome information and must be stripped from blind active records.

## Design

### Field

Add optional field:

```ts
fidelityVectorTrace?: FidelityVectorTrace
```

It belongs inside existing adjudication records in the existing adjudicate stage output. No new primary artifact is added.

### Semantics

The trace is:

- evidence-conditioned
- multi-sampled
- diagnostic
- uncalibrated
- independent of the canonical verdict prompt

The vector prompt should not see the canonical verdict. Code may pass the final canonical verdict after sampling to compute agreement with the modal vector verdict.

### Why a trace

A single LLM-generated numeric vector looks falsely precise. The v1 design stores:

- multiple independent samples
- aggregate means
- aggregate variance
- verdict distribution
- direction distributions
- disagreement and uncertainty heuristics

Use `fidelityVectorTrace`, not `fidelityVector`.

### Sampling

Use true multi-sampling via separate LLM calls in v1.

Defaults:

- `sampleCount = 3`
- allowed sample count range: `1..10`
- `temperature = 0.7`
- model default: Sonnet unless explicitly configured

Do not implement one-call "return N samples" batching in v1. If cost becomes a problem later, add a separately named mode because batched samples have different correlation semantics.

### Model choice

Default to Sonnet for vector traces, not the canonical adjudication model. This avoids accidentally turning `sampleCount = 3` into three extra Opus calls per adjudicated record when the user only enables the diagnostic.

Use `claude-sonnet-4-6` as the default unless the project model defaults have moved. Haiku can be tested as a cheaper baseline, but axes such as `claimIdentity`, `directionalAlignment`, `scopeMatch`, and `certaintyMatch` require nuanced reading.

## Commit 1: Extract Adjudication Packet Rendering

### Goal

Create a reusable, behavior-preserving packet abstraction that both the canonical adjudicator and fidelity vector scorer can consume.

### New module

Add:

```text
src/adjudication/adjudication-packet.ts
```

Suggested exports:

```ts
export type AdjudicationPacket = {
  recordId: string;
  taskId: string;
  citationRole: CitationRole;
  evaluationMode: EvaluationMode;
  modifiers: TransmissionModifiers;
  citingPaperTitle: string;
  citedPaperTitle: string;
  groundedSeedClaimText?: string | undefined;
  rubricQuestion: string;
  citingSpanSection?: string | undefined;
  citingMarker: string;
  seedRefLabel?: string | undefined;
  markedCitingContext: string;
  evidenceBlock: string;
  evidenceRetrievalStatus: TaskEvidenceRetrievalStatus;
};

export function buildAdjudicationPacket(
  record: AdjudicationRecord,
): AdjudicationPacket;

export function renderAdjudicationPacket(packet: AdjudicationPacket): string;
```

Adjust exact types to current domain exports.

### Required preservation

Move these behaviors out of `llm-adjudicator.ts` without changing semantics:

- retrieval status warning text
- evidence legend
- top-3 evidence span limit
- LLM rerank score display only for `llm_reranked`
- section title display
- `groundedSeedClaimText` block
- modifier string for bundled and review-mediated records
- `extractCitingWindow(..., 800)`
- `annotateCitingContext(...)`
- `seedRefLabel` fallback behavior
- citation-scope instructions

### Canonical adjudicator refactor

In `src/adjudication/llm-adjudicator.ts`, replace the existing inline packet construction in `buildPrompt(record)` with:

```ts
const packet = buildAdjudicationPacket(record);
const packetText = renderAdjudicationPacket(packet);
```

The canonical prompt instructions should remain otherwise unchanged. This commit should be intended as behavior-preserving.

### Tests

Add focused tests that prove:

- top-3 evidence span logic is preserved
- `llm_reranked` relevance score formatting is preserved
- BM25 scores are not rendered as relevance `/100`
- retrieval warnings are preserved
- `seedRefLabel` and marked citing context are used
- no full cited-paper text is included beyond the existing selected evidence snippets

If snapshot tests are used, keep them small and stable.

## Commit 2: Add Fidelity Vector Trace Schema

### New domain module

Add:

```text
src/domain/fidelity-vector.ts
```

Export it from:

```text
src/domain/types.ts
```

### Names

Use:

- `fidelityVectorTrace`
- `FidelityVectorTrace`
- `FidelityVectorSample`
- `FidelityVectorAggregate`
- `FidelityAxis`
- `FidelityAxisScore`

Avoid:

- `distributionalAdjudication`
- `bayesianSurprise`
- `priorSupport`
- `posteriorSupport`
- `driftVector`
- `supportVector`

### Axes

Use this v1 axis set:

```ts
export const fidelityAxisValues = [
  "support",
  "evidenceGrounding",
  "claimIdentity",
  "directionalAlignment",
  "scopeMatch",
  "certaintyMatch",
  "attributionDirectness",
  "uncertainty",
] as const;
```

All scores are numbers in `[0, 1]`.

Axis meanings:

- `support`: whether the cited evidence supports the citing claim.
- `evidenceGrounding`: whether retrieved cited-paper spans are usable and sufficient.
- `claimIdentity`: whether the citing claim is the same empirical claim as the cited finding.
- `directionalAlignment`: whether the citing claim preserves the direction of the cited finding.
- `scopeMatch`: whether the citing claim preserves the cited paper's scope.
- `certaintyMatch`: whether the citing claim preserves hedging and strength.
- `attributionDirectness`: whether the cited paper is direct evidence rather than indirect/background/review-like support.
- `uncertainty`: how unstable, ambiguous, or underdetermined the judgment is.

Document that `uncertainty` is reverse-direction: `1.0` means high uncertainty and `0.0` means low uncertainty.

### Direction fields

Do not use signed scores in v1. Add direction fields:

```ts
scopeDirection: "none" | "expansion" | "contraction" | "shift" | "unclear";
certaintyDirection: "none" | "escalation" | "deflation" | "shift" | "unclear";
```

### Suggested schemas

Use Zod schemas with strict numeric bounds:

```ts
z.number().min(0).max(1)
z.string().min(1)
```

Suggested shape:

```ts
export type FidelityAxisScore = {
  score: number;
  rationale: string;
};

export type FidelityVectorSample = {
  sampleIndex: number;
  axes: FidelityVectorAxes;
  scopeDirection: ScopeDirection;
  certaintyDirection: CertaintyDirection;
  suggestedVerdict: AdjudicationVerdict;
  rationale: string;
  telemetry?: LLMCallTelemetry;
};

export type FidelityVectorAggregate = {
  meanAxes: Record<FidelityAxis, number>;
  varianceAxes: Record<FidelityAxis, number>;
  verdictDistribution: {
    sampleCount: number;
    counts: Record<AdjudicationVerdict, number>;
    modalVerdict: AdjudicationVerdict;
    entropy: number;
  };
  scopeDirectionDistribution: Record<ScopeDirection, number>;
  certaintyDirectionDistribution: Record<CertaintyDirection, number>;
  disagreementScore: number;
  overallUncertainty: number;
};

export type FidelityVectorTrace = {
  version: "fidelity-vector-trace-v1";
  model: string;
  temperature: number;
  sampleCount: number;
  samples: FidelityVectorSample[];
  aggregate: FidelityVectorAggregate;
  canonicalVerdict?: AdjudicationVerdict;
  canonicalVerdictAgreement?: boolean;
  telemetry?: RunTelemetry;
};
```

Exact telemetry shape may be adjusted to avoid circular imports. The core requirement is that vector-call costs must be visible and recoverable.

Use an explicit axis object schema, not a loose `Record`, for sample axes:

```ts
export type FidelityVectorAxes = {
  support: FidelityAxisScore;
  evidenceGrounding: FidelityAxisScore;
  claimIdentity: FidelityAxisScore;
  directionalAlignment: FidelityAxisScore;
  scopeMatch: FidelityAxisScore;
  certaintyMatch: FidelityAxisScore;
  attributionDirectness: FidelityAxisScore;
  uncertainty: FidelityAxisScore;
};
```

The Zod schema should require every v1 axis and reject arbitrary extra axis names. This keeps missing or hallucinated axes from silently entering artifacts.

### Add to adjudication record

In `src/domain/adjudication.ts`, add:

```ts
fidelityVectorTrace: undefinedable(fidelityVectorTraceSchema),
```

or use `.optional()` if that better matches local optional-field style. Existing records without the field must still parse.

### Tests

Add schema tests for:

- adjudication record parses without `fidelityVectorTrace`
- adjudication record parses with a valid trace
- axis score below `0` fails
- axis score above `1` fails
- invalid direction value fails

## Commit 3: Add Fidelity Vector Aggregation

### New module

Add:

```text
src/adjudication/fidelity-vector-stats.ts
```

Suggested exports:

```ts
export function aggregateFidelityVectorSamples(
  samples: FidelityVectorSample[],
): FidelityVectorAggregate;

export function computeMean(values: number[]): number;
export function computeSampleVariance(values: number[]): number;
export function computeNormalizedEntropy(counts: Record<string, number>): number;
export function selectModalVerdict(
  counts: Record<AdjudicationVerdict, number>,
): AdjudicationVerdict;
```

### Modal verdict tie-break

Use conservative tie-break order:

```text
cannot_determine
not_supported
overstated_or_generalized
partially_supported
supported
```

### Distribution counts

For `Record<AdjudicationVerdict, number>`, include all verdict keys with `0` when absent. Do the same for direction distributions.

### Disagreement and uncertainty

Keep v1 simple and documented as heuristic.

Recommended:

```ts
disagreementScore = verdictEntropy;
```

Recommended:

```ts
overallUncertainty = clamp01(
  0.5 * meanAxes.uncertainty +
  0.3 * verdictEntropy +
  0.2 * meanAxisVariance,
);
```

Do not claim calibration.

### Tests

Add tests for:

- mean axis computation
- sample variance computation
- entropy bounded in `[0, 1]`
- modal verdict selection
- conservative tie-break
- disagreement and overall uncertainty are bounded

## Commit 4: Sample Fidelity Vectors After Final Adjudication

### New scorer module

Add:

```text
src/adjudication/fidelity-vector-scorer.ts
```

Suggested public API:

```ts
export async function generateFidelityVectorTrace(params: {
  record: AdjudicationRecord;
  canonicalVerdict?: AdjudicationVerdict;
  client: LLMClient;
  model: string;
  temperature: number;
  sampleCount: number;
  signal?: AbortSignal;
}): Promise<FidelityVectorTrace>;
```

Adjust exact params to current project types.

### Prompt input

The scorer must:

- call `buildAdjudicationPacket(record)`
- call `renderAdjudicationPacket(packet)`
- not send full cited-paper text
- not include canonical verdict in the prompt
- ground the scoring in the provided citing context and cited-paper evidence spans only

### Prompt requirements

The prompt should state:

```text
You are producing a diagnostic citation-fidelity vector.
You are not replacing the canonical adjudication verdict.
Use only the provided citing context and cited-paper evidence.
Do not rely on outside knowledge.
Scores are diagnostic estimates, not calibrated probabilities.
```

Require JSON output only.

The model should return the sample without `sampleIndex`; code assigns it:

```json
{
  "axes": {
    "support": { "score": 0.75, "rationale": "..." }
  },
  "scopeDirection": "expansion",
  "certaintyDirection": "escalation",
  "suggestedVerdict": "partially_supported",
  "rationale": "..."
}
```

Include scoring anchors:

```text
0.0 = clearly fails this axis
0.25 = mostly fails
0.5 = mixed, partial, or unclear
0.75 = mostly satisfies
1.0 = clearly satisfies

For uncertainty only:
0.0 = low uncertainty
0.5 = moderate uncertainty
1.0 = high uncertainty
```

Rationales should be short and refer to the provided text, not outside knowledge.

### LLM purpose and cache

Add `"fidelity-vector"` to `llmPurposeValues` in `src/integrations/llm-client.ts`.

Vector sample calls must use:

```ts
purpose: "fidelity-vector"
```

Do not pass `exactCache`. Persistent exact-result caching undermines true multi-sampling by returning identical samples.

Provider prompt caching is acceptable if it naturally applies through the shared LLM client.

### Temperature support

If vector sampling needs temperature control and `generateObject()` does not support it yet, extend `GenerateObjectParams` and the implementation in a backward-compatible way:

```ts
temperature?: number;
```

Only pass it to the provider when defined.

Do not require existing call sites to change.

### Telemetry

Each sample should capture its `LLMCallRecord` and convert it to artifact-safe telemetry.

The trace should contain enough telemetry to ensure:

- standalone adjudicate summaries can include vector calls when enabled
- pipeline run-cost artifacts include `"fidelity-vector"` purpose
- costs do not disappear because vector calls are outside canonical adjudication telemetry

Prefer using the shared client ledger for pipeline run-cost reporting. For standalone adjudicate, either merge vector telemetry into the returned `runTelemetry` or attach a separate trace-level telemetry summary and update reporting accordingly.

If embedding full `RunTelemetry` in every trace is awkward or creates circular imports, use:

- per-sample call telemetry
- a trace-level telemetry summary for the vector calls belonging to that record
- aggregate run-cost reporting through the shared LLM ledger

The hard requirement is that `"fidelity-vector"` costs are visible in both standalone `adjudicate` summaries and pipeline run-cost output.

### Advisor-safe wiring

Do not run vector tracing inside `runPass()`.

Add a helper such as:

```ts
async function attachFidelityVectorTraces(
  set: AuditSample,
  options: AdjudicatorOptions,
  client: LLMClient,
): Promise<AuditSample>
```

Call it only after final canonical adjudication:

- normal mode: after `runPass()` returns
- advisor mode: after `runAdvisorAdjudication()` returns the merged records

Only active final records receive `fidelityVectorTrace`.

If tracing fails for one record:

- keep the canonical record
- do not fail the whole adjudication run
- log a warning
- leave `fidelityVectorTrace` absent for that record

### Bounded concurrency

Do not run all records times samples with unbounded `Promise.all`.

Use bounded concurrency for vector tracing, ideally reusing the existing `pMap` pattern from adjudication. Default conservatively:

```ts
fidelityVectorConcurrency = 2;
```

Allow an internal option or config field only if it is useful, but keep the public CLI surface minimal unless needed. The important requirement is that vector calls are bounded across records and samples.

### Adjudicator options

Extend `AdjudicatorOptions` with a nested option:

```ts
fidelityVectorTrace?: {
  enabled: boolean;
  sampleCount: number;
  model?: string;
  temperature: number;
  concurrency?: number;
};
```

Use a nested option to avoid confusing canonical adjudication model settings with diagnostic vector settings.

### Tests

Use mocked `LLMClient`; do not add live LLM tests.

Test that:

- scorer calls the client `sampleCount` times
- sample calls are bounded by configured concurrency where practical to test
- `purpose` is `"fidelity-vector"`
- `exactCache` is not passed
- temperature is passed only when configured
- trace aggregate is computed
- `canonicalVerdictAgreement` compares the canonical verdict with modal vector verdict
- advisor mode traces only final merged records, not first-pass-only intermediate records
- vector failure does not erase canonical verdict fields

## Commit 5: Wire Fidelity Vector Options

### Standalone adjudicate CLI

In `src/cli/commands/adjudicate.ts`, add disabled-by-default flags:

```bash
--fidelity-vector-trace
--fidelity-vector-samples <n>
--fidelity-vector-model <model>
--fidelity-vector-temperature <number>
```

Defaults:

```ts
fidelityVectorTrace: false
fidelityVectorSamples: 3
fidelityVectorTemperature: 0.7
fidelityVectorModel: "claude-sonnet-4-6"
```

If the user supplies `--fidelity-vector-model`, use it. Otherwise use the Sonnet default. Do not inherit the canonical adjudication model implicitly because that can accidentally create multiple extra Opus calls.

Clamp samples to `1..10`.

### Pipeline config

In `src/contract/run-types.ts`, add defaults to `analysisRunConfigObjectSchema`:

```ts
adjudicateFidelityVectorTrace: z.boolean().default(false),
fidelityVectorSamples: z.number().int().min(1).max(10).default(3),
fidelityVectorModel: z.string().min(1).default("claude-sonnet-4-6"),
fidelityVectorTemperature: z.number().min(0).max(2).default(0.7),
```

The temperature upper bound can follow the provider's supported range. If the current provider expects a narrower range, use that range instead.

### Pipeline CLI

In `src/cli/commands/pipeline.ts` and `src/pipeline/run-orchestrator.ts`, add:

```bash
--fidelity-vector-trace
--fidelity-vector-samples <n>
--fidelity-vector-model <model>
--fidelity-vector-temperature <number>
```

Map CLI overrides into `AnalysisRunConfig`.

### Family runner

In `src/pipeline/family-runner.ts`, pass vector options into `adjudicateAuditSample()`:

```ts
fidelityVectorTrace: {
  enabled: runConfig.adjudicateFidelityVectorTrace,
  sampleCount: runConfig.fidelityVectorSamples,
  model: runConfig.fidelityVectorModel,
  temperature: runConfig.fidelityVectorTemperature,
  concurrency: 2,
}
```

If concurrency becomes configurable later, pass the configured value instead of the conservative internal default.

### UI config

Keep UI minimal.

For this PR:

- add run config schema support so UI-created runs parse and store defaults
- do not add visible UI controls unless trivial
- optional inspector payload support is fine, but no large visualization

Update `apps/ui/tests/config-defaults.test.ts` or equivalent if defaults are mirrored there.

### Tests

Add config and CLI parsing tests where practical:

- defaults disabled
- default samples `3`
- default temperature `0.7`
- samples are clamped or schema-rejected outside `1..10`, depending on local CLI convention
- pipeline config accepts all new fields

Do not create a large CLI harness only for these flags if the repo does not already test standalone parsing.

## Commit 6: Summarize Fidelity Vector Traces

### JSON artifact

The existing `_llm-audit-sample.json` includes optional `fidelityVectorTrace` on records when enabled.

No filename changes.

### Markdown summary

Update:

```text
src/reporting/audit-sample-summary.ts
```

Add an optional section only when at least one active record has `fidelityVectorTrace`:

```md
## Fidelity Vector Trace Summary
```

Include a concise aggregate table:

```md
| Task | Canonical verdict | Vector verdict | Agreement | Support | Grounding | Claim identity | Scope | Certainty | Uncertainty |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
```

Use aggregate means rounded to two decimals.

Do not include all sample rationales in Markdown. Raw JSON is the detailed source.

### Telemetry summary

Ensure standalone `adjudicate` summaries include vector telemetry when enabled, either through merged `runTelemetry` or an additional compact vector telemetry section.

Pipeline run-cost artifacts should naturally include `"fidelity-vector"` if they use the shared LLM ledger. Confirm this and update hardcoded purpose handling if found.

### Inspector payload

Optional minimal support:

- vector modal verdict
- canonical agreement
- mean axis scores

Do not add a full visualization in this PR.

### Tests

Add report tests:

- summary without traces does not include the section
- summary with traces includes `Fidelity Vector Trace Summary`
- table values round to two decimals

## Commit 7: Strip Fidelity Vectors From Blind Benchmarks

### Blind export

Update:

```text
src/benchmark/workflow.ts
src/benchmark/types.ts
```

For active records, strip:

```ts
fidelityVectorTrace
```

Rationale: the trace is adjudication outcome information and leaks labels.

Excluded records should follow the existing convention. Do not change excluded-record behavior unless an existing test requires it.

### Benchmark summary

`benchmark:summary` should not score vector traces. Existing verdict scoring should remain based on canonical verdicts.

### Benchmark diff

For v1:

- ignore `fidelityVectorTrace`, or
- report only coarse presence/high-level changes

Do not diff every sample rationale.

### Tests

Extend `tests/benchmark/workflow.test.ts`:

- active blind records lose `fidelityVectorTrace`
- excluded record behavior matches existing convention
- benchmark scoring is unchanged by trace presence

## Commit 8: Document Fidelity Vector Traces

Update docs:

- `docs/adjudication-rubric.md`
- `docs/pipeline.md`
- `docs/artifact-workflow.md`
- `docs/status.md`
- `docs/pipeline-concepts.md`

Add concise language:

```md
`fidelityVectorTrace` is an optional adjudication diagnostic. It does not replace the canonical support-style verdict. It samples evidence-conditioned vector judgments multiple times and records aggregate axis means, variance, verdict distribution, and disagreement.
```

Document:

- disabled by default
- stored in adjudication records only when enabled
- evidence-conditioned on existing retrieved evidence snippets
- full cited-paper text is not sent to vector sample calls
- persistent exact-result cache is disabled for vector samples
- costs are reported under `"fidelity-vector"`
- benchmark blind export strips it
- uncalibrated diagnostic until human benchmark data exists

Do not overstate accuracy.

## Cost Controls and Operational Notes

Parallel calls reduce wall-clock time but not cost. With `sampleCount = 3`, vector tracing can add roughly three additional LLM calls per active adjudicated record.

Cost controls in this design:

- feature disabled by default
- trace only final active records
- reuse compact adjudication packet
- top-3 evidence spans only
- no full cited-paper text in vector calls
- no tracing of advisor first-pass intermediates
- separate `"fidelity-vector"` purpose in telemetry
- sample count capped at `10`

Future cost optimization, not in v1:

- batched one-call trace mode with a distinct name
- trace only low-confidence or high-disagreement records
- use trace uncertainty for escalation after calibration
- smaller model after empirical comparison

## Acceptance Criteria

The PR is acceptable when:

1. Existing runs without `fidelityVectorTrace` still load.
2. Existing adjudication outputs remain unchanged when the feature is disabled.
3. Canonical adjudicator packet refactor preserves current prompt semantics.
4. Enabling the feature adds `fidelityVectorTrace` to final active adjudicated records.
5. Advisor mode traces only final merged records.
6. `verdict`, `rationale`, `retrievalQuality`, `judgeConfidence`, `comparison`, and advisor behavior are unchanged by vector tracing.
7. Vector samples are repeated via separate LLM calls and aggregated.
8. Vector sample calls use purpose `"fidelity-vector"`.
9. Persistent exact-result cache is not used for vector sample calls.
10. Vector telemetry/costs are visible in standalone and pipeline reporting.
11. Markdown summary includes vector section only when traces exist.
12. `benchmark:blind` removes `fidelityVectorTrace` from active records.
13. Benchmark scoring is unaffected by traces.
14. No stage keys, artifact filenames, or pipeline order change.
15. Tests cover packet rendering, schema, aggregation, scorer behavior, advisor-safe wiring, reporting, and blind stripping.

## Suggested Validation Commands

Run:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run lint:all
npm --workspace @palimpsest/ui run test
npm run ui:build
npx knip --reporter compact
```

If any environment-specific UI issue appears, report it exactly. Do not claim success if it fails.

## Future Work

Do not implement these in this PR:

1. Create a small checked-in or reproducible human calibration artifact.
2. Compare vector-derived modal verdicts against human labels.
3. Add UI visualization of vector axes.
4. Add a dedicated evidence-grounding review object if `evidenceGrounding` proves too compressed.
5. Add support-belief tracing for apparent versus evidence-conditioned support shift.
6. Use vector uncertainty or disagreement for advisor escalation after calibration.
7. Use vector risk or disagreement for curation after calibration.
8. Consider calibrated thresholds for deriving canonical verdicts from vectors.
