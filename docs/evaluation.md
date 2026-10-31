# Local evaluation

Evaluation is separate from the six-stage production pipeline. It freezes cases from a completed canonical report, stores them under gitignored `data/evaluations/`, and compares providers without changing production artifacts. Datasets, trials, labels, and scores stay on the machine that created them.

How to judge the system is in [evaluation-protocol.md](./evaluation-protocol.md). Adjudicate stays uncalibrated until blinded human labels exist.

## Commands

```bash
npm run dev -- eval dataset --report data/runs/<run-id>/05-report/<canonical-report>.json --name <name>
npm run dev -- eval validate --dataset <dataset-id>
npm run dev -- eval run --dataset <dataset-id> --config docs/evaluation.example.json
npm run dev -- eval run --experiment <experiment-id>
npm run dev -- eval plan --dataset <dataset-id> --config <path>
npm run dev -- eval status --experiment <experiment-id>
npm run dev -- eval report --experiment <experiment-id>
```

`docs/evaluation.example.json` is a template for an ordinary comparison. Copy it before changing models, endpoints, or prices. `plan` and `status` apply to a config that includes an `optimization` block: planning checks the frozen inputs without calling a provider, and status reads saved progress.

Credentials come from environment variables named in the config (`ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, `DJEV_ENDPOINT`, `DJEV_API_KEY`) and are not written into experiment files. A missing key leaves those trials pending.

The local UI has an Evaluations area for blind role, passage-relevance, span, and verdict labels. Enter a reviewer name before saving. Drafts and revisions are append-only. A reveal is recorded before machine observations are shown, and later labels from that reviewer are marked exposed. Reports bind to the annotation snapshot, so new labels create a new report revision without model calls.

Measured runs bypass exact-result caching. Resume reuses completed trials when the dataset, provider settings, prompt revision, and repetition match. Changed scientific inputs invalidate reuse. Concurrency and spacing do not.
