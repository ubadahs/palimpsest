# Vector-First Adjudicator

Palimpsest has two adjudication modes:

- **categorical adjudicator**: the default path. The LLM directly produces the canonical support-style verdict, rationale, retrieval quality, and confidence. Advisor mode still belongs to this path.
- **vector-first adjudicator**: an opt-in experiment. It samples `fidelityVectorTrace` first, derives `axisDerivedVerdict`, and only escalates risky records to the categorical adjudicator.

The canonical verdict labels do not change:

- `supported`
- `partially_supported`
- `overstated_or_generalized`
- `not_supported`
- `cannot_determine`

## Enabling

Stored run config uses:

```ts
adjudicationMode: "categorical" | "vector_first"
```

The default is `categorical`.

Pipeline CLI flags:

```bash
--adjudication-mode vector_first
--vector-first-initial-samples 1
--vector-first-max-samples 3
--vector-first-model claude-sonnet-4-6
--vector-first-temperature 0.7
--vector-first-concurrency 2
```

The standalone `adjudicate` command accepts the same vector-first flags for experiments against an existing audit sample.

## Final Verdict Semantics

In `categorical` mode, behavior is unchanged. Optional post-hoc `fidelityVectorTrace` remains diagnostic and does not alter final verdicts.

In `vector_first` mode:

1. The record receives an initial vector sample.
2. Simple routing rules may request more vector samples up to `vectorFirstMaxSamples`.
3. If the final vector aggregate is accepted, final fields are axis-derived:
   - `verdict` is `fidelityVectorTrace.aggregate.axisDerivedVerdict`
   - `rationale` starts with `Axis-derived verdict:`
   - `adjudicator` is `vector-first:<model>:axis-derived`
4. If the final vector aggregate is risky, the existing categorical adjudicator runs on the original unmodified audit record. Categorical fields then become final.

Vector-first mode never runs the post-hoc diagnostic trace path after vector-first tracing. The vector-first trace is the trace for that record.

## Provenance

Each vector-first record carries:

```ts
vectorRoutingDecision?: {
  version: "vector-routing-v1";
  adjudicationMode: "vector_first";
  finalVerdictSource: "axis_derived" | "categorical_escalation";
  triggeredAdaptiveSampling: boolean;
  triggeredCategoricalAdjudicator: boolean;
  initialSampleCount: number;
  finalSampleCount: number;
  adaptiveSamplingReasons: string[];
  categoricalEscalationReasons: string[];
  acceptedAxisDerivedVerdict?: AdjudicationVerdict;
  categoricalVerdict?: AdjudicationVerdict;
}
```

This is a sibling of `fidelityVectorTrace` so routing provenance is easy to inspect and easy to strip from blind benchmarks.

## Routing Policy

The v1 policy is intentionally small. Adaptive sampling can trigger on:

- `axis_verdict_cannot_determine`
- `uncertainty_borderline`
- `core_axis_borderline`
- `sampled_verdict_disagrees_with_axis`
- `bundled_citation_scope_ambiguous`

Categorical escalation can trigger on:

- `axis_verdict_cannot_determine`
- `aggregate_uncertainty_high`
- `sample_disagreement_high`
- `axis_variance_high`
- `evidence_grounding_low`
- `claim_identity_low`
- `modal_sampled_verdict_disagrees_with_axis`
- `bundled_citation_scope_ambiguous`
- `vector_trace_failed`

These thresholds are heuristic and should be tuned only with validation data.

## Benchmarks

Blind benchmark export strips vector-first adjudication outcome fields from active records:

- `fidelityVectorTrace`
- `vectorRoutingDecision`
- final verdict/rationale/confidence/retrieval fields
- per-record telemetry

Benchmark diff and summary continue to compare final adjudication outcomes, not routing provenance.
