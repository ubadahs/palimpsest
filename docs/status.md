# Implementation status

**Last updated:** 2026-04-14

This file tracks **what exists in the codebase today**. For product intent and principles, see [implementation-plan.md](./implementation-plan.md), [prd.md](./prd.md), and [build-spec.md](./build-spec.md). For a map of all docs, see [README.md](./README.md).

## Pipeline (CLI)

| Area | Command | Status | Notes |
|------|---------|--------|--------|
| Claim discovery | `discover` | Done | Two strategies selectable via `--strategy`: `attribution_first` (default in pipeline) harvests real citing mentions from a probe set (bounded parallel harvest + extract), extracts attributed claims, collapses identical normalized tracked-claim text per DOI before grounding, grounds families with bounded parallel LLM calls, conservatively dedupes exact and near-duplicate families (exact match includes same tracked claim even when grounded paraphrases differ), then ranks and shortlists with a greedy diversity filter on citing-paper overlap (Jaccard ≥ 0.85 skips near-duplicates). Default `--shortlist-cap` **5**. `legacy` extracts seed-side claim units and optionally ranks by citing-paper engagement. Discover defaults (legacy extraction, attribution-first extraction, and seed-family grounding during discover) to `claude-haiku-4-5` with extended thinking **disabled** (`--thinking` / `--discover-thinking` to enable). JSON + Markdown artifacts plus persistent sidecars (neighborhood, probe, mentions, attributed claims, family candidates, grounding trace) |
| Bootstrap / health | `doctor` | Done | Config + taxonomy sanity check, GROBID health required, reranker health optional |
| Database | `db:migrate` | Done | SQLite migrations; paper cache tables included |
| Claim-family pre-screen | `screen` | Done | Requires `ANTHROPIC_API_KEY`: full-manuscript LLM `claimGrounding` (verbatim-quote verification), `*_pre-screen-grounding-trace.json` sidecar (prompt, raw response, usage); centralized full-text acquisition for seed parsing with provenance; claim-scoped citing filter (title/abstract BM25); neighborhood + claim metrics; OpenAlex/S2; dedup; auditability; JSON + Markdown reports. Seed grounding defaults to `claude-sonnet-4-6` with thinking enabled. The grounding trace now stores an ordered `records[]` collection so multiple same-DOI tracked claims do not overwrite one another. Accepts both legacy shortlist entries and attribution-first family candidates. Ungrounded claims (`not_found` grounding) no longer block downstream — treated as a fidelity finding worth surfacing. **Thin-screen path**: when `attribution_first` discovery produces a reusable `DiscoveryHandoff`, screen skips DOI resolution, OpenAlex re-fetch, and LLM claim grounding through `runPreScreenFromHandoff`. Fresh pipeline runs pass that bundle in memory; resume can restore it from `inputs/discovery-handoffs.json` when present. The citing-paper list carried by the handoff (up to 200) is also larger than the standard screen cap (50). |
| Citation context extraction | `extract` | Done | Centralized full-text acquisition, JATS-first parsing, validated PDF -> GROBID parsing, normalized citation mentions, extraction outcomes + inspection artifacts. **Mention reuse**: in `attribution_first` pipeline runs, papers that were probed during discovery have pre-harvested mentions in the `DiscoveryHandoff`; the extract stage reads those directly and skips the full-text fetch + parse. Papers outside the probe budget fall back to the standard full-harvest path. |
| Citation function + packets | `classify` | Done | Roles, evaluation modes, `EdgeEvaluationPacket`, classification reports |
| Cited-paper evidence | `evidence` | Done | DOI/PMCID/PMID/title+author+year resolution, centralized full-text acquisition with method tracking, BM25 retrieval for all tasks, **deferred LLM reranking** (Haiku, only on curated records post-sampling) or optional local HTTP sidecar reranker, abstract-only downgrade, parsed-paper cache reuse; `--no-llm-rerank` to disable |
| Human adjudication set | `curate` | Done | Samples audit worksheet + JSON from evidence results; default target size **20** (`sampleAuditSet` / pipeline `--target-size`). `manual_review_role_ambiguous` tasks stay eligible but are capped to at most **25%** of the target when sampling |
| LLM adjudication | `adjudicate` | Done | Anthropic via centralized LLM client, centralized telemetry, agreement reports; default is `claude-opus-4-6` with extended thinking (`--no-thinking` to disable). **Advisor mode** (`adjudicateAdvisor: true` / `--advisor`): Sonnet+thinking first pass on all records, then escalates `judgeConfidence === "low"`, `verdict === "cannot_determine"`, or bundled citations with `medium` confidence to Opus+thinking. **Enabled by default**; configurable via `adjudicateFirstPassModel`. Per-pass telemetry exposed as `firstPassTelemetry` / `escalationTelemetry` / `escalationCount` in the output artifact. **Citation scope annotation**: adjudicator prompt wraps sentences attributed to the seed paper with `▶ ... ◀` markers using `seedRefLabel` from reference resolution, disambiguating multi-reference paragraphs. |
| Benchmark workflow | `benchmark:*` | Done | Blind export, keyed diff, candidate summary, and approved-delta apply for adjudication datasets; excluded-only adjudication diffs are ignored |
| Full pipeline | `pipeline` | Done | `--input` / `--shortlist` / `--run-id` / `--seed-pdf`. Fresh CLI runs default `discover` strategy to `attribution_first`. Stored defaults include `discoverShortlistCap` **5** and `curateTargetSize` **20**. Resuming with `--run-id` (as the UI does) reads persisted `analysis_runs.config_json`: `stopAfterStage` halts after the named stage, `forceRefresh` maps to paper-cache policy, `evidenceLlmRerank` toggles LLM evidence reranking, `adjudicateModel` / `adjudicateThinking` / `adjudicateAdvisor` / `adjudicateFirstPassModel` pass through to adjudication, `familyConcurrency` bounds parallel extract→adjudicate work across greenlit families after `screen`. `extract` and `classify` reuse run-scoped cached results for identical citing-paper neighborhoods. **Attribution-first handoff**: fresh `attribution_first` runs carry a `DiscoveryHandoff` in memory from `discover` through `screen` and `extract`, eliminating redundant DOI resolution, OpenAlex fetches, LLM grounding, and full-text fetches for probed papers. The pipeline also persists the bundle to `inputs/discovery-handoffs.json`; resume restores it when available and falls back to full paths when it is missing or unreadable. Fatal Anthropic billing/quota/auth failures fail the run and mark later family stages `blocked` with the provider reason instead of silently completing |

## Local UI

| Area | Surface | Status | Notes |
|------|---------|--------|--------|
| Run orchestration UI | `apps/ui` | Done | Local-only Next.js App Router workspace for run creation, orchestration, live logs, and stage inspection. Run overview and APIs expose one **logical stage per `stageKey`** (`LogicalStageGroup`) with rolled-up status and optional multi-family summaries; stage detail supports per-`familyIndex` logs and artifacts (`?familyIndex=`). New-run defaults: `discoverStrategy` **attribution_first**, `discoverShortlistCap` **5**, `curateTargetSize` **20**, `discoverModel` **claude-haiku-4-5** with `discoverThinking` **false**, `screenGroundingModel` **claude-sonnet-4-6** with `screenGroundingThinking` enabled, configurable `familyConcurrency`. UI readers accept richer run-cost files and render downstream `blocked` family stages when a fatal provider failure halts later work. Discover fully orchestrated (DOI-only default, shortlist copied to `inputs/` after discover succeeds); manual claim entry skips discover |
| Run registry | SQLite `analysis_runs`, `analysis_run_stages` | Done | Durable run/stage status, pointers to latest artifacts, log paths, stale downstream tracking |
| Local supervisor | UI server runtime | Done | One active subprocess pipeline at a time, startup reconciliation to `interrupted`, per-stage cancel/rerun/continue |

## Cross-cutting

| Area | Status | Notes |
|------|--------|--------|
| Domain taxonomy + Zod boundaries | Done | `src/domain/` |
| Artifact schemas + validated loaders | Done | Stage artifacts are schema-validated on load |
| Artifact manifests | Done | Primary JSON outputs get adjacent manifest files |
| OpenAlex + Semantic Scholar adapters | Done | `src/integrations/`; separate PDF vs landing-page URLs and conservative metadata fallback |
| Centralized LLM client | Done | `src/integrations/llm-client.ts`; single Anthropic client, per-call purpose tags (`claim-discovery`, `seed-grounding`, `claim-family-filter`, `evidence-rerank`, `adjudication`, `attributed-claim-extraction`), shared run-level telemetry collector, attempted/successful/failed/billable accounting, provider-error classification for fatal vs retryable failures. Opt-in persistent exact-result cache (`llm_result_cache` table) with SHA-256 key over canonical request data; enabled for evidence-rerank, adjudication, seed-grounding, and attributed-claim-extraction; `forceRefresh` bypasses reads and writes; per-purpose `keyVersion` constants auto-invalidate stale entries when prompt templates change |
| SQLite paper cache (`paper_cache`, `paper_parsed`, …) | Done | Raw full text and parsed-paper cache reuse wired into `extract` and `evidence`; acquisition provenance persisted with cached raw papers |
| SQLite LLM result cache (`llm_result_cache`) | Done | Persistent exact-result reuse for identical LLM requests across runs; dedicated table separate from paper cache; cache-hit telemetry surfaced in `LLMCallRecord`, `LLMRunLedger`, and `*_run-cost.json` |
| Family consolidation | Done | Post-discovery, pre-screen Opus `generateText` call with extended thinking clusters semantically equivalent tracked claims; domain-agnostic prompt; picks most specific representative per cluster; full merge provenance logged to `_family-consolidation.json` artifact; auto-skips for ≤1 seeds; cost tracked under `family-consolidation` purpose; exact-result cached |
| Local seed PDF (`--seed-pdf`) | Done | Pipeline accepts a local PDF for the paywalled seed paper; GROBID parses it; path persisted in run config for `--run-id` resume; UI new-run form supports optional PDF upload (base64 in JSON body) |
| Institutional proxy (`INSTITUTIONAL_PROXY_URL`) | Done | EZproxy-style prefix URL; full-text acquisition tries open-access first, falls back to proxy-prefixed URLs; `accessChannel` field on acquisition metadata tracks how text was obtained (`open_access`, `institutional_proxy`, `local_pdf`) |
| Deferred evidence reranking | Done | BM25 retrieval for all tasks (free), curate samples audit set, LLM reranking only on the curated ~20 records before adjudication; saves ~80% of evidence reranking cost on well-cited papers |
| Citation scope annotation (`seedRefLabel`) | Done | `seedRefLabel` populated at mention-harvest time from matched bibliography entry's `authorSurnames` + `year`; propagated through extraction → classification → curate → adjudication; adjudicator prompt wraps attributed sentences with `▶ ... ◀` markers; context window centers on `seedRefLabel` instead of raw marker for proper disambiguation |
| Reporting (JSON + Markdown) | Done | `src/reporting/` per stage; benchmark diff and benchmark summary Markdown added |
| Unit / fixture tests | Done | `npm test`; Vitest limited to `tests/**/*.ts` |
| UI workspace tests | Done | Vitest in `apps/ui/tests` (run-queries, run-focus-stage, run-supervisor, component smoke); full browser E2E not added |

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
