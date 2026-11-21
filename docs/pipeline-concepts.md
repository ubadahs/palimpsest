# Pipeline Concepts

The public pipeline has six stages:

```text
DOI input
  → Discover observation ledger
  → Scoped families
  → Prepared family × occurrence records
  → Evidence outcomes
  → Adjudication outcomes
  → Report
```

## Main objects

| Object | Produced by | Meaning |
|---|---|---|
| Discover ledger | `discover` | Lossless record of the citing-neighborhood boundary, papers, occurrences, attributed claims, candidates, and dispositions. |
| Scoped family | `scope` | A family whose exact candidate/source-claim/occurrence membership is frozen; grounding is an annotation, not an exclusion. |
| Seed finding | `scope` | A result the seed's authors established, with exact quotes in a specific version of the seed text. |
| Citation statement | `scope` | One extracted proposition at one citing occurrence, with its exact wording and marker when verified, group credit, and assessment against the inventory. |
| Prepared record | `prepare` | One stable family × citation-occurrence evaluation record with complete and occurrence-local claim context plus classification. |
| Evidence outcome | `evidence` | One retrieval outcome per Prepared record over immutable seed text, with BM25 and optional separate reranking provenance. |
| Adjudication outcome | `adjudicate` | One `F`/`D`/`E`/`U` result or typed operational non-verdict per Evidence record. |
| Report | `report` | Deterministic funnel, rate, trace, and interpretation accounting for the full artifact chain. |
| Citation history | `citation-history` | A Report-bound history of what the downstream paper credits to the intermediate paper, the documented connection through that paper, and how the downstream wording compares with the original finding. The evidence and coverage accompany each result. |

## Important boundaries

- Every run starts from seed DOIs.
- The public stage vocabulary is only `discover`, `scope`, `prepare`, `evidence`, `adjudicate`, and `report`.
- Every scoped family × occurrence record remains accounted for downstream.
- `U` is a scientific uncertainty verdict with evidence; it is not a substitute for retrieval, provider, or classification failure.
- Adjudicate is runnable but uncalibrated. Blinded human calibration is required before trust claims.
