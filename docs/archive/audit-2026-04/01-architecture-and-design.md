# Architecture & Design Audit

## Overall Assessment: SOLID with 2 critical dependency violations

The codebase has well-defined module boundaries, clean ESM compliance, and consistent use of adapter patterns for dependency injection. The monorepo (root + `apps/ui` workspace) is well-organized.

---

## Critical Issues

### 1. Circular Dependency: Domain imports Pipeline types
- **File:** `src/domain/discovery-handoff.ts:17`
- **Severity:** CRITICAL
- `FamilyGroundingTrace` is imported from `src/pipeline/discovery-family-probe.ts` into the domain layer
- Violates the principle that inner layers must never depend on outer layers
- **Fix:** Move `FamilyGroundingTrace` type into `src/domain/` (e.g., `src/domain/grounding-trace.ts`)

### 2. Storage imports UI Contract
- **File:** `src/storage/analysis-runs.ts:4,15`
- **Severity:** CRITICAL
- Storage imports `getStageDefinition`, `stageDefinitions` from `src/contract/stages.ts` and `StageKey` from `src/contract/run-types.ts`
- Persistence layer should not depend on presentation concerns
- **Fix:** Extract stage definitions into `src/domain/run-definition.ts` or `src/config/`, then import from there in both storage and contract

---

## High Priority

### 3. UI Contract broadly coupled to domain internals
- **Files:** `src/contract/inspector-payloads.ts`, `run-types.ts`, `selectors.ts`
- Imports from 4+ domain modules; no curated public API surface
- **Fix:** Create `src/contract/domain-subset.ts` that re-exports only the types the UI actually needs

---

## Medium Priority

### 4. Large monolithic files
| File | LOC | Concern |
|------|-----|---------|
| `src/pipeline/pre-screen.ts` | 1244 | Orchestrates 5 sub-stages; should split into grounding + filtering sub-modules |
| `src/integrations/llm-client.ts` | 929 | Mixes API calls, caching, cost estimation, error classification; extract cache + cost modules |
| `src/cli/commands/pipeline.ts` | ~1700 | CLI orchestrator; could delegate more to pipeline layer |

### 5. Scattered application constants
- Hardcoded thresholds and patterns in `claim-discovery.ts`, `attributed-claim-families.ts`, `pipeline.ts`
- **Fix:** Centralize in `src/config/constants.ts` or `src/config/thresholds.ts`

### 6. Overly broad domain barrel export
- `src/domain/types.ts` re-exports everything from 12 modules
- Makes it hard to identify which types are "core" vs. "internal"
- **Fix:** Create `src/domain/public.ts` with curated core exports

### 7. LLM client tight coupling
- All pipeline stages directly import `createLLMClient` from integrations
- Acceptable now; becomes a problem if multi-provider support is needed
- **Fix (optional):** Pass LLM client via adapter/service pattern rather than direct imports

---

## Strengths (no action needed)

- **ESM compliance:** All local imports use `.js` extensions; `verbatimModuleSyntax: true` enforced
- **Adapter pattern:** Clean, consistent adapter interfaces on all pipeline stages (`PreScreenAdapters`, `DiscoveryStageAdapters`, `M4EvidenceAdapters`, etc.) enabling DI and testing
- **Naming conventions:** Consistent kebab-case files, PascalCase types, `*Adapters`/`*Options`/`*Config` suffix pattern
- **Workspace structure:** `apps/ui` correctly depends on root via workspace; no cross-contamination
- **Dependency direction:** Besides the two critical violations above, the general flow (CLI -> Pipeline -> Domain <- Integrations/Storage/Retrieval) is correct

---

## Remediation Roadmap

| Phase | Items | Effort | Risk |
|-------|-------|--------|------|
| 1: Architecture Repairs | Move `FamilyGroundingTrace` to domain; extract stage defs from contract; update storage imports | 2-3h | Low |
| 2: Coupling Reduction | Create domain public API subset; document adapter pattern | 2-4h | Low |
| 3: Code Quality | Split `pre-screen.ts`; extract llm-client cache/cost modules; centralize constants | 1-2 days | Medium |
