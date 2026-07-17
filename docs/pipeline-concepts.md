# Pipeline Concepts

The public pipeline has six stages:

```text
DOI input
  → Discover observation ledger
  → Scoped families
  → Prepared family × occurrence records
  → Evidence outcomes
  → Adjudication outcomes
  → Canonical report
```

## Main objects

| Object | Produced by | Meaning |
|---|---|---|
| Discover ledger | `discover` | Lossless record of the citing-neighborhood boundary, papers, occurrences, attributed claims, candidates, and dispositions. |
| Scoped family | `scope` | A family whose exact candidate/source-claim/occurrence membership is frozen; grounding is an annotation, not an exclusion. |
| Prepared record | `prepare` | One stable family × citation-occurrence evaluation record with complete and occurrence-local claim context plus classification. |
| Evidence outcome | `evidence` | One retrieval outcome per Prepared record over immutable seed text, with BM25 and optional separate reranking provenance. |
| Adjudication outcome | `adjudicate` | One `F`/`D`/`E`/`U` result or typed operational non-verdict per Evidence record. |
| Canonical report | `report` | Deterministic funnel, rate, trace, and interpretation accounting for the full artifact chain. |

## Important boundaries

- Fresh execution is DOI-first; manual shortlists and tracked-claim starts are removed.
- The public stage vocabulary is only `discover`, `scope`, `prepare`, `evidence`, `adjudicate`, and `report`.
- There is no `curate` or sampling stage. Every scoped family × occurrence record remains accounted for downstream.
- `U` is a scientific uncertainty verdict with evidence; it is not a substitute for retrieval, provider, or classification failure.
- Canonical Adjudicate is runnable but uncalibrated. Blinded human calibration is required before trust claims.
- Old seven-stage executor run rows and directories are unsupported and may be deleted/recreated rather than migrated.
