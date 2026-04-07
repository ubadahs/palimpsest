# Runtime Setup

This document covers the local runtime boundary: environment variables, external services, and what is required versus optional for different stages.

## What You Need

| Item | Required? | Notes |
|------|-----------|-------|
| Node.js 22+ | Yes | See [`package.json`](../package.json) `engines` |
| Local SQLite path | Yes | `PALIMPSEST_DB_PATH` defaults to `data/palimpsest.sqlite` |
| `GROBID_BASE_URL` | Yes | Required by environment loading and by any PDF-backed parsing path |
| `ANTHROPIC_API_KEY` | Stage-dependent | Required for `discover`, `screen`, `adjudicate`, `pipeline`, and `evidence` when LLM reranking is enabled |
| `LOCAL_RERANKER_BASE_URL` | No | Optional fallback reranker for `evidence` |
| `OPENALEX_EMAIL` | No | Optional, but useful for OpenAlex requests |
| `SEMANTIC_SCHOLAR_API_KEY` | No | Optional metadata and fallback-resolution support |

## Typical `.env.local`

```bash
PALIMPSEST_DB_PATH=data/palimpsest.sqlite
GROBID_BASE_URL=http://localhost:8070

# Optional
ANTHROPIC_API_KEY=...
LOCAL_RERANKER_BASE_URL=http://localhost:8080
OPENALEX_EMAIL=you@example.com
SEMANTIC_SCHOLAR_API_KEY=...
```

Base URLs for OpenAlex, Semantic Scholar, and bioRxiv also have defaults and usually do not need to be set explicitly.

## Required Service: GROBID

### Why it matters

The PDF fallback path no longer uses raw PDF text extraction in production. When a paper is only available as PDF, the pipeline expects GROBID and stores the resulting TEI as `grobid_tei_xml`.

Historical artifacts with legacy `pdf_text` remain loadable, but new PDF-backed runs should go through GROBID.

### Recommended local deployment

```bash
docker run --rm -p 8070:8070 lfoppiano/grobid:0.8.1
```

Any equivalent deployment is fine as long as `GROBID_BASE_URL` exposes:

- `GET /api/isalive`
- `POST /api/processFulltextDocument`

### Failure behavior

- `doctor` fails if GROBID is unreachable
- PDF-backed `discover`, `screen`, `extract`, and `evidence` paths fail or degrade when parsing cannot proceed
- JATS-backed paths do not need GROBID at runtime once structured full text is already available

## Stage-dependent LLM Access

Anthropic is not an all-or-nothing repo requirement. It is required for the stages that currently depend on model calls.

Requires `ANTHROPIC_API_KEY`:

- `discover`
- `screen`
- `adjudicate`
- `pipeline`
- `evidence` when LLM reranking is enabled

Does not strictly require Anthropic:

- `doctor`
- `db:migrate`
- `extract`
- `classify`
- `curate`
- `evidence` when run with `--no-llm-rerank`, or when it falls back to a local reranker or plain BM25

## Optional Local Reranker

BM25 is the baseline retrieval method and the required fallback. The local reranker is optional.

If `LOCAL_RERANKER_BASE_URL` is configured and healthy, `evidence` can use it as a fallback reranker when LLM reranking is unavailable or disabled.

### Expected HTTP contract

Health check:

```http
GET /health
```

Expected success response: any `2xx`

Rerank endpoint:

```http
POST /rerank
Content-Type: application/json
```

Request body:

```json
{
  "query": "string",
  "documents": [
    { "id": "doc-1", "text": "..." }
  ],
  "topN": 5
}
```

Response body:

```json
{
  "results": [
    { "id": "doc-1", "score": 12.34, "rank": 1 }
  ]
}
```

### Failure behavior

- `doctor` reports reranker health as optional and non-fatal
- `evidence` falls back to BM25 if reranking errors or times out

## What `doctor` Actually Means

`npm run dev -- doctor` checks two things:

- environment health
- taxonomy sanity counts

Operationally:

- a bad GROBID check makes `doctor` fail
- missing Anthropic is reported, but it only blocks the stages that actually need it

## Cache Behavior

`extract` and `evidence` reuse:

- raw full-text cache entries
- parsed-paper cache entries keyed by paper id and content hash

Use `--force-refresh` on `extract` or `evidence` to bypass both raw and parsed cache reuse.
