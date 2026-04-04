# Runtime Setup

This repo now has one required parsing dependency and one optional retrieval dependency:

- **GROBID**: required for any PDF-backed full-text path
- **Local reranker sidecar**: optional; BM25 still works without it

## Required Environment

Set these in `.env.local` or the shell environment:

```bash
GROBID_BASE_URL=http://localhost:8070
LOCAL_RERANKER_BASE_URL=http://localhost:8080
```

`LOCAL_RERANKER_BASE_URL` is optional.

## GROBID

### Why it is required

The PDF fallback path no longer uses raw PDF text extraction in production. When a paper is only available as PDF, the pipeline now expects GROBID and stores the resulting TEI as `grobid_tei_xml`.

Historical artifacts with legacy `pdf_text` remain loadable, but new PDF-backed runs should go through GROBID.

### Recommended local deployment

Use the official GROBID service locally, for example with Docker:

```bash
docker run --rm -p 8070:8070 lfoppiano/grobid:0.8.1
```

Any equivalent deployment is fine as long as `GROBID_BASE_URL` exposes:

- `GET /api/isalive`
- `POST /api/processFulltextDocument`

### Failure behavior

- `doctor` fails if GROBID is unreachable
- PDF-backed M2 and M4 runs fail fast with a GROBID parse/fetch error
- JATS-backed paths do not require GROBID at runtime

## Local reranker sidecar

### Why it is optional

BM25 is the baseline retrieval method and the required fallback. The reranker only reorders the BM25 shortlist. If the reranker is unconfigured or unhealthy, the pipeline still runs and emits BM25-only evidence.

### Required HTTP contract

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
- M4 falls back to BM25 if reranking errors or times out

## Cache behavior

M2 and M4 now reuse:

- raw full-text cache entries
- parsed-paper cache entries keyed by paper id and content hash

Use `--force-refresh` on `m2-extract` or `m4-evidence` to bypass both raw and parsed cache reuse.
