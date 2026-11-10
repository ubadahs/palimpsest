# Local evaluation

Evaluation is separate from the six-stage production pipeline. It freezes cases from a completed canonical report, stores them under gitignored `data/evaluations/`, and compares providers without changing production artifacts. Datasets, trials, labels, and scores stay on the machine that created them.

How to judge the system is in [evaluation-protocol.md](./evaluation-protocol.md). Adjudicate stays uncalibrated until blinded human labels exist.

## Commands

```bash
npm run dev -- eval dataset --report data/runs/<run-id>/05-report/<canonical-report>.json --name <name> [--mutations <path>]
npm run dev -- eval validate --dataset <dataset-id>
npm run dev -- eval run --dataset <dataset-id> --config docs/evaluation.example.json
npm run dev -- eval run --experiment <experiment-id>
npm run dev -- eval plan --dataset <dataset-id> --config <path>
npm run dev -- eval status --experiment <experiment-id>
npm run dev -- eval report --experiment <experiment-id>
```

`eval dataset` rebuilds each case with the current code over the run's frozen inputs, so a case shows what the pipeline would hand a model today. Records the run adjudicated but today's packet gate would hold back are left out and counted in the command's output, and seed section roles are inferred again with the current rules. The dataset also stores each seed's full text.

## Adjudicating from the whole seed paper

An Anthropic provider reads the chunks the run selected unless its config says `"adjudicationEvidence": "seed_text"`. With that setting it gets the seed's full text as a prompt prefix, which the provider caches because it is the same for every record of a seed, and it must point at its evidence by quoting the text. Each quote is checked as an exact substring of the block it names. A quote that fails is dropped and counted; an `F`, `D`, or `U` verdict left with no verified quote is an invalid response. An `E` may quote nothing, because the model has read the whole paper and the paper may say nothing on the point. The first request for each seed runs alone to write the cache; the rest then run side by side and read it.

`docs/evaluation.adjudication-arms.example.json` compares Haiku 5.5, Sonnet 5.5 and Opus 5.5, each reading chunks and reading the whole paper, on the same cases, twice. `docs/evaluation.adjudication-probe.example.json` holds only the two Haiku arms and costs a few cents: run it first as a live check of the request path and of how hard the constructed cases are. Its trials are reused when the full comparison runs.

Cost is computed from each provider's stated prices. Cache writes cost 1.25 times the input price. Cache reads default to a tenth of it; set `pricePerMillionCacheReadTokensUsd` for models that charge less, which matters for whole-paper arms because most of their input is read from the cache.

## Constructed cases

Human labels on real records hold almost no distortions, so they cannot show whether an adjudicator misses one. `--mutations <path>` adds cases whose answer is known by construction. Each mutation names a record whose claim unit a human labelled `F` and edits its citing text and claim wording. There are two kinds:

- A **distortion** changes the meaning along one mutation kind and states the verdict that should follow, `D` or `E`. A provider that calls it `F` has missed a distortion.
- A **control** changes only the wording and expects `F`. A provider that objects to it is reacting to the edit, not to the seed.

```json
[
  {
    "recordId": "record_…",
    "expectedVerdict": "D",
    "mutationKind": "population_shifted",
    "direction": "shifted",
    "rationale": "The seed studied mouse, not human.",
    "contextEdits": [{ "find": "in mouse Norel", "replace": "in human Norel" }],
    "claimEdits": [{ "find": "in mouse Norel", "replace": "in human Norel" }]
  },
  {
    "recordId": "record_…",
    "expectedVerdict": "F",
    "rationale": "Wording only: 'described' for 'reported'.",
    "contextEdits": [{ "find": "reported three", "replace": "described three" }],
    "claimEdits": [{ "find": "reported three", "replace": "described three" }]
  }
]
```

The builder refuses a mutation whose source has no undisputed human `F`, whose context edit is ambiguous or leaves the attributed text unchanged, or whose edit crosses the edge of a support span. A constructed case gets its own record and unit identity, so it inherits no label from its source, and the blind annotation queue shows it like any other case. That lets a reviewer spot-check the mutations blind.

An edited case keeps the chunks the run selected for the original wording. Where grounding pins fill the packet that is exactly what the pipeline would select for any wording, and the case is marked `evidencePinned`. Elsewhere the pipeline would have retrieved again, so the report compares chunk providers with whole-paper providers on pinned cases only.

The report scores constructed cases in their own section and never mixes them into human-label accuracy. For each provider it gives how many distortions earned the expected verdict, how many were called faithful, how many `D` verdicts named the mutation that was made, how often the unedited source was called `F` and the edit something else, and how many controls stayed `F`.

## Run-to-run noise

A model asked the same case twice does not always answer the same way. Set `"repetitions": 2` to ask again; first repetitions already saved for the same dataset and provider settings are reused, so only the second is paid for. The report then lists, per provider, how many repeated cases got the same answer. A difference between two providers smaller than that disagreement is noise.

`docs/evaluation.example.json` is a template for an ordinary comparison. Copy it before changing models, endpoints, or prices. `plan` and `status` apply to a config that includes an `optimization` block: planning checks the frozen inputs without calling a provider, and status reads saved progress.

Credentials come from environment variables named in the config (`ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, `DJEV_ENDPOINT`, `DJEV_API_KEY`) and are not written into experiment files. A missing key leaves those trials pending.

The local UI has an Evaluations area for blind role, passage-relevance, span, and verdict labels. Enter a reviewer name before saving. Drafts and revisions are append-only. A reveal is recorded before machine observations are shown, and later labels from that reviewer are marked exposed. Reports bind to the annotation snapshot, so new labels create a new report revision without model calls.

Measured runs bypass exact-result caching. Resume reuses completed trials when the dataset, provider settings, prompt revision, and repetition match. Changed scientific inputs invalidate reuse. Concurrency and spacing do not.
