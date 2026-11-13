# Palimpsest

[![CI](https://github.com/ubadahs/palimpsest/actions/workflows/ci.yml/badge.svg)](https://github.com/ubadahs/palimpsest/actions/workflows/ci.yml)

Palimpsest checks whether papers that cite a study describe it faithfully. Give it the DOI of a paper (the _seed_). It finds the papers that cite it, pulls out what each one says the seed showed, finds the passages in the seed that bear on each statement, and has a model judge whether the statement holds up. Everything it decides is written to JSON and Markdown files you can audit line by line.

It runs locally from the command line. A local web UI can launch runs and browse their results; it is not a hosted service.

## How it works

A run has six stages:

1. **Discover** lists the papers citing the seed, samples some of them (100 by default), and extracts each sentence that attributes a finding to the seed. Statements from different papers that make the same claim are grouped into one **claim family**, and 15–25 families are chosen to audit by default.
2. **Scope** fixes exactly which citing sentences belong to each chosen family and locates each family's claim in the seed's own text.
3. **Prepare** makes one record per citing sentence in each chosen family and classifies how the sentence uses the seed: as a specific finding, as background, or for a method.
4. **Evidence** retrieves the seed passages relevant to each record.
5. **Adjudicate** asks a model for a verdict on each record that is eligible for one. The model reads the whole seed paper and must quote the passages its verdict rests on; every quote is checked against the paper's text.
6. **Report** reconciles every count across the stages and writes the results.

Each verdict is one of:

| Verdict | Meaning                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `F`     | Faithful: the citing paper says what the seed showed; shorter or reworded is fine.                                                         |
| `D`     | Distortion: the right finding, but changed in scope, strength, certainty, causality, population, conditions, endpoint, or generality.     |
| `E`     | Error: the seed does not support the statement, contradicts it, or is about something else.                                               |
| `U`     | Uncertain: the relevant passages exist but genuinely do not settle it.                                                                    |

For example (an invented case):

> **The seed reports:** "Knocking out gene X reduced Y by 40% in adult mice."
>
> **A citing paper says:** "Gene X is required for Y."
>
> **Verdict:** `D`. The finding is real, but the claim is stronger (_reduced_ became _required_) and broader (_adult mice_ became everything).

Records that cannot be judged are reported separately, with the reason, and never counted as verdicts: for example, a citation whose purpose is unclear, a claim that could not be tied to the exact citing text, a citation that carries no claim, or no seed text to check against. The full rules are in [docs/adjudication-rubric.md](docs/adjudication-rubric.md).

**The verdicts are not yet calibrated.** They have not been validated against blinded human judgments, so treat a report as material for review, not as a measurement.

## What is and is not deterministic

Palimpsest is partly deterministic.

- **Deterministic:** which citing papers are sampled (a fixed order derived from each paper's identity, not a random draw), passage retrieval, the rules that decide which records can be judged, and every count in the report. The same inputs give the same output, at any concurrency setting.
- **Not deterministic:** every model call, from extracting claims to the verdicts. The same request can get a different answer on another day. The outside world also moves: the list of citing papers grows, and papers become available or paywalled.

A run is still auditable and repeatable. Every model request and reply is saved with the run, so each result can be traced to exactly what the model saw and said. Identical requests are answered from a local cache, so rerunning on the same machine gives the same result unless you pass `--force-refresh`.

## Requirements

- Node.js 22 or later
- A running [GROBID](https://github.com/kermitt2/grobid) server, for parsing PDFs (`GROBID_BASE_URL`)
- An Anthropic API key (`ANTHROPIC_API_KEY`), for the model calls

Optional settings, such as an OpenAlex contact email or an institutional proxy for paywalled papers, are described in [docs/runtime-setup.md](docs/runtime-setup.md).

## Quick start

```bash
npm install
cp .env.example .env.local    # then fill in your keys
npm run dev -- doctor         # checks the database, GROBID, and the API key
npm run dev -- db:migrate
```

Put one or more seed DOIs in a JSON file:

```json
{ "dois": ["10.0000/example"] }
```

and run the pipeline:

```bash
npm run dev -- pipeline --input dois.json --max-cost 5
```

`--max-cost` stops sending model requests once the run's estimated spend reaches that many dollars. A run writes everything under `data/runs/<run-id>/`, one folder per stage.

## What you get

- **The report**, in `data/runs/<run-id>/05-report/`. The JSON is authoritative: every claim family with its citing statements and verdicts, verdict rates with their denominators, and a trace of every record through every stage. The Markdown is rendered from it.
- **Every stage's artifact**, each with a content hash and the exact inputs it was built from, so a run can be resumed and checked for tampering.
- **`cost-summary.json`** at the run root, kept current while the run is going.

To browse runs, start the local UI:

```bash
npm run ui:dev
```

## Common options

```bash
# Stop after a stage, or resume a run where it stopped
npm run dev -- pipeline --input dois.json --stop-after evidence
npm run dev -- pipeline --run-id <run-id>

# Send model requests through Anthropic's Message Batches API at half price (slower)
npm run dev -- pipeline --input dois.json --batch

# Analyze every citing paper and every claim family instead of sampling
npm run dev -- pipeline --input dois.json --census --max-cost 40
```

Scope also builds a **codebook** of the seed's citable statements, stored so later runs of the same seed reuse it, and tags each citing claim with the entries it is about. To build a new one:

```bash
npm run dev -- pipeline --run-id <run-id> --rerun-from scope --regenerate-codebook
```

By default, Claude Haiku 5.5 extracts claims, classifies citations, reranks passages, and tags claims; Claude Sonnet 5.5 groups claims, locates them in the seed, builds the codebook, and adjudicates. Every model and option can be changed in the run config ([docs/pipeline.md](docs/pipeline.md)).

## Evaluation

`npm run dev -- eval` freezes a finished report into local test cases and compares models or settings on them. It can add constructed cases, edits of statements a reviewer judged faithful, whose correct verdict is known. Reviewers grade cases blind in the local UI. Datasets stay on your machine and out of git. See [docs/evaluation.md](docs/evaluation.md).

## Documentation

- [docs/pipeline.md](docs/pipeline.md): what each stage reads, does, and writes
- [docs/pipeline-concepts.md](docs/pipeline-concepts.md): the objects that move through the stages
- [docs/adjudication-rubric.md](docs/adjudication-rubric.md): the verdict rules and how rates are counted
- [docs/artifact-workflow.md](docs/artifact-workflow.md): run layout and artifact files
- [docs/runtime-setup.md](docs/runtime-setup.md): environment variables and services
- [docs/status.md](docs/status.md): what is built today
- [docs/README.md](docs/README.md): the full documentation map

## Scripts

| Script                                                 | Purpose                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `npm run dev -- <command>`                             | Run the CLI (`doctor`, `db:migrate`, `pipeline`, `eval`, `db:gc`, `runs:gc`)                         |
| `npm run build`                                        | Compile `src/` to `dist/`                                                                            |
| `npm run typecheck` / `typecheck:all`                  | Typecheck the CLI and tests / also the UI                                                            |
| `npm run lint` / `lint:all`                            | Lint the CLI and tests / also the UI                                                                 |
| `npm run test`                                         | Run the test suite                                                                                   |
| `npm --workspace @palimpsest/ui run test`              | Run the UI tests                                                                                     |
| `npm run test:live-smoke`                              | Optional live smoke test against real providers (`PALIMPSEST_LIVE_SMOKE=1`)                          |
| `npm run db:gc -- --days 90 [--dry-run]`               | Delete old run records, stale model-response cache rows, and expired batch rows (never codebooks)   |
| `npm run runs:gc -- [--run-id <run-id>] [--dry-run]`   | Delete stage attempts a rerun replaced, and the provenance files only they used                     |
| `npm run ui:dev` / `ui:build` / `ui:start`             | Run the local UI                                                                                     |

## License

[MIT](LICENSE)
