# Implementation status

**Last updated:** 2026-04-09

This file tracks **what exists in the codebase today**. For product intent and principles, see [implementation-plan.md](./implementation-plan.md), [prd.md](./prd.md), and [build-spec.md](./build-spec.md). For a map of all docs, see [README.md](./README.md).

## Pipeline (CLI)

| Area | Command | Status | Notes |
|------|---------|--------|--------|
| Claim discovery | `discover` | Done | Two strategies selectable via `--strategy`: `attribution_first` (default in pipeline) harvests real citing mentions from a probe set, extracts attributed claims, constructs singleton families, grounds each back to the seed, and shortlists by observable viability; `legacy` extracts seed-side claim units and optionally ranks by citing-paper engagement. New flags: `--probe-budget`, `--shortlist-cap`. JSON + Markdown artifacts plus persistent sidecars (neighborhood, probe, mentions, attributed claims, family candidates, grounding trace) |
| Bootstrap / health | `doctor` | Done | Config + taxonomy sanity check, GROBID health required, reranker health optional |
| Database | `db:migrate` | Done | SQLite migrations; paper cache tables included |
| Claim-family pre-screen | `screen` | Done | Requires `ANTHROPIC_API_KEY`: full-manuscript LLM `claimGrounding` (verbatim-quote verification), `*_pre-screen-grounding-trace.json` sidecar (prompt, raw response, usage); centralized full-text acquisition for seed parsing with provenance; claim-scoped citing filter (title/abstract BM25); neighborhood + claim metrics; OpenAlex/S2; dedup; auditability; JSON + Markdown reports. Accepts both legacy shortlist entries and attribution-first family candidates. Ungrounded claims (`not_found` grounding) no longer block downstream — treated as a fidelity finding worth surfacing |
| Citation context extraction | `extract` | Done | Centralized full-text acquisition, JATS-first parsing, validated PDF -> GROBID parsing, normalized citation mentions, extraction outcomes + inspection artifacts |
| Citation function + packets | `classify` | Done | Roles, evaluation modes, `EdgeEvaluationPacket`, classification reports |
| Cited-paper evidence | `evidence` | Done | DOI/PMCID/PMID/title+author+year resolution, centralized full-text acquisition with method tracking, BM25 retrieval, LLM-based reranking (Haiku, default on) or optional local HTTP sidecar reranker, abstract-only downgrade, parsed-paper cache reuse; `--no-llm-rerank` to disable |
| Human adjudication set | `curate` | Done | Samples calibration worksheet + JSON from evidence results |
| LLM adjudication | `adjudicate` | Done | Anthropic via centralized LLM client, telemetry, agreement reports; default is `claude-opus-4-6` with extended thinking (`--no-thinking` to disable) |
| Benchmark workflow | `benchmark:*` | Done | Blind export, keyed diff, candidate summary, and approved-delta apply for adjudication datasets; excluded-only adjudication diffs are ignored |

## Local UI

| Area | Surface | Status | Notes |
|------|---------|--------|--------|
| Run orchestration UI | `apps/ui` | Done | Local-only Next.js App Router workspace for run creation, orchestration, live logs, and stage inspection; discover stage fully orchestrated (DOI-only default, shortlist auto-copied to inputs/ after discover succeeds); manual claim entry optional |
| Run registry | SQLite `analysis_runs`, `analysis_run_stages` | Done | Durable run/stage status, pointers to latest artifacts, log paths, stale downstream tracking |
| Local supervisor | UI server runtime | Done | One active subprocess pipeline at a time, startup reconciliation to `interrupted`, per-stage cancel/rerun/continue |

## Cross-cutting

| Area | Status | Notes |
|------|--------|--------|
| Domain taxonomy + Zod boundaries | Done | `src/domain/` |
| Artifact schemas + validated loaders | Done | Stage artifacts are schema-validated on load |
| Artifact manifests | Done | Primary JSON outputs get adjacent manifest files |
| OpenAlex + Semantic Scholar adapters | Done | `src/integrations/`; separate PDF vs landing-page URLs and conservative metadata fallback |
| Centralized LLM client | Done | `src/integrations/llm-client.ts`; single Anthropic client, per-call purpose tags (`claim-discovery`, `seed-grounding`, `claim-family-filter`, `evidence-rerank`, `adjudication`, `attributed-claim-extraction`), run-level cost ledger |
| SQLite paper cache (`paper_cache`, `paper_parsed`, …) | Done | Raw full text and parsed-paper cache reuse wired into `extract` and `evidence`; acquisition provenance persisted with cached raw papers |
| Reporting (JSON + Markdown) | Done | `src/reporting/` per stage; benchmark diff and benchmark summary Markdown added |
| Unit / fixture tests | Done | `npm test`; Vitest limited to `tests/**/*.ts` |
| UI workspace tests | Partial | Targeted command-builder coverage in `apps/ui/tests`; broader component/E2E coverage not added yet |

## Retrieval and Parsing Notes

- PDF ingestion now requires **GROBID**. Legacy `pdf_text` artifacts remain loadable, but new runs emit `grobid_tei_xml`.
- Full-text retrieval is now centralized in one acquisition layer shared by `discover`, `screen`, `extract`, and `evidence`.
- Provider metadata is treated as retrieval hints. The acquisition layer preserves requested identifiers, ranks candidates, validates payloads, and records the winning method plus every attempted path.
- GROBID is invoked only after a response has been validated as a real PDF. HTML landing pages, interstitials, and challenge pages are classified explicitly rather than surfacing as generic parser failures.
- Citing and cited full text are normalized into one parsed-document representation with:
  - structured blocks
  - bibliography references
  - resolved in-text citation mentions
- Evidence retrieval now uses:
  - BM25 over normalized blocks (first pass, always runs)
  - LLM-based reranking via `claude-haiku-4-5` (default on; mode-aware prompt, sentence extraction, hybrid BM25 fallback)
  - optional local HTTP sidecar reranking through `LOCAL_RERANKER_BASE_URL` (legacy, used as fallback if LLM reranking fails)
  - explicit `abstract_only_matches` downgrade when only abstract blocks match
  - `extractCitingWindow()` focuses retrieval and adjudication on sentences around the citation marker
- Stage artifacts now record acquisition provenance so reports can say how each paper was materialized (`pmc_xml`, `biorxiv_xml`, landing-page XML, or validated direct PDF via GROBID).

## Not implemented yet (or out of current scope)

| Area | Status | Notes |
|------|--------|--------|
| Paper-level synthesis score | Not started | No single paper- or family-level fidelity rollup in product form |
| Automated challenger routing (e.g. thinking model escalation) | Not started | Policy discussed; not wired in CLI |
| Multi–claim-family batch at scale | Partial | Commands are family-oriented; expansion is operational, not a separate module |
| Full PRD `F/D/E/U` output stack | Partial | Operational adjudication uses support-style verdicts; see `adjudication-rubric.md` |

## How to update this file

Edit the tables when a command’s behavior materially ships or when scope changes. Bump **Last updated** to the change date.

When the **local UI** or **workspace layout** changes, verify [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) still match the repo. When **artifact paths**, **stage keys**, or **stage responsibilities** change, update [pipeline.md](./pipeline.md), [artifact-workflow.md](./artifact-workflow.md), and [ui-architecture.md](./ui-architecture.md) in the same change when possible.

Before a release or large merge, use the checklist in [README.md](./README.md) (release / large-change section) to avoid stale documentation.
