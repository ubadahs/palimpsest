# Runtime Setup

This guide covers dependencies for the runnable canonical pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

Fresh runs are DOI-first. The public CLI exposes `doctor`, `db:migrate`, `db:gc`, and `pipeline` only.

## What you need

| Item | Required? | Notes |
|---|---|---|
| Node.js 22+ | Yes | See `package.json`. |
| Local SQLite path | Yes | `PALIMPSEST_DB_PATH` defaults to `data/palimpsest.sqlite`. |
| `GROBID_BASE_URL` | Yes | Required by environment validation and PDF-backed parsing. |
| `ANTHROPIC_API_KEY` | Stage-dependent | Needed for model-backed extraction, grounding, optional reranking, and eligible-record adjudication. |
| `OPENALEX_EMAIL` | No | Useful for OpenAlex requests. |
| `SEMANTIC_SCHOLAR_API_KEY` | No | Optional metadata/fallback resolution. |

```bash
PALIMPSEST_DB_PATH=data/palimpsest.sqlite
GROBID_BASE_URL=http://localhost:8070
ANTHROPIC_API_KEY=...
OPENALEX_EMAIL=you@example.com
SEMANTIC_SCHOLAR_API_KEY=...
```

## GROBID

PDF payloads are validated before being sent to GROBID. New PDF-backed work stores GROBID TEI, not raw PDF-text extraction.

```bash
docker run --rm -p 8070:8070 lfoppiano/grobid:0.8.1
```

`doctor` fails when GROBID is unreachable. JATS-backed inputs do not need GROBID once structured text is available.

## Model access

Anthropic is required only when a run reaches a model-backed operation. Discover can extract attributed claims, Scope can ground claims, Evidence can optionally rerank, and Adjudicate calls the model only for eligible records. Fully gated Adjudicate runs can complete without model calls.

Run:

```bash
npm run dev -- doctor
npm run dev -- db:migrate
npm run dev -- db:gc --dry-run
npm run dev -- pipeline --input path/to/dois.json
```

`db:gc` deletes aged analysis-run and LLM-cache SQLite rows only. It does not delete on-disk run artifact directories under `data/runs/`.

Canonical Adjudicate is **uncalibrated**. Runtime availability does not establish scientific validity or support trust claims.

## Cutover data

Old local SQLite rows and run directories from the former seven-stage executor are unsupported and may need deletion/recreation. Do not attempt to resume or bridge old shortlist, curation, advisor, or vector-first state into a canonical run.
