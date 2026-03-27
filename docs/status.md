# Implementation status

**Last updated:** 2026-03-26

This file tracks **what exists in the codebase today**. For product intent and principles, see [implementation-plan.md](./implementation-plan.md), [prd.md](./prd.md), and [build-spec.md](./build-spec.md). Naming here follows **CLI commands** (`m2-extract`, …), which do not map 1:1 to milestone numbers in the original plan.

## Pipeline (CLI)

| Area | Command | Status | Notes |
|------|---------|--------|--------|
| Bootstrap / health | `doctor` | Done | Config + taxonomy sanity check |
| Database | `db:migrate` | Done | SQLite migrations; paper cache tables included |
| Claim-family pre-screen | `pre-screen` | Done | OpenAlex/S2, dedup, auditability, JSON + Markdown reports |
| Citation context extraction | `m2-extract` | Done | Full text, JATS/PDF mentions, extraction outcomes + inspection artifacts |
| Citation function + packets | `m3-classify` | Done | Roles, evaluation modes, `EdgeEvaluationPacket`, classification reports |
| Cited-paper evidence | `m4-evidence` | Done | Lexical retrieval → spans per `EvaluationTask`; evidence reports |
| Human adjudication set | `m5-adjudicate` | Done | Samples calibration worksheet + JSON from evidence results |
| LLM adjudication | `m6-llm-judge` | Done | Anthropic via AI SDK, telemetry, agreement reports; optional extended thinking |

## Cross-cutting

| Area | Status | Notes |
|------|--------|--------|
| Domain taxonomy + Zod boundaries | Done | `src/domain/` |
| OpenAlex + Semantic Scholar adapters | Done | `src/integrations/` |
| SQLite paper cache (`paper_cache`, …) | Done | `src/storage/` + migrations |
| Reporting (JSON + Markdown) | Done | `src/reporting/` per stage |
| Unit / fixture tests | Done | `npm test`; Vitest limited to `tests/**/*.ts` |

## Not implemented yet (or out of current scope)

| Area | Status | Notes |
|------|--------|--------|
| Paper-level synthesis score | Not started | No single paper- or family-level fidelity rollup in product form |
| Automated challenger routing (e.g. thinking model escalation) | Not started | Policy discussed; not wired in CLI |
| Multi–claim-family batch at scale | Partial | Commands are family-oriented; expansion is operational, not a separate module |
| Full PRD “LLM analysis” stack for all modes | Partial | Heuristic classification + retrieval + adjudication path exists; not every evaluation mode has a dedicated LLM fidelity agent |

## How to update this file

Edit the tables when a command’s behavior materially ships or when scope changes. Bump **Last updated** to the change date.
