# Domain Logic & Taxonomy Audit

## Overall Assessment: SOLID foundations with cleanup needed

The domain layer is mostly pure (one critical import violation), has comprehensive Zod schemas, and zero `any` types. However, unused taxonomy types, duplicate enums, and extensibility claims that aren't enforced need attention.

---

## Critical Issues

### 1. Domain imports Pipeline types (architecture violation)
- **File:** `src/domain/discovery-handoff.ts:17`
- **Severity:** CRITICAL
- `FamilyGroundingTrace` imported from `src/pipeline/discovery-family-probe.ts`
- Domain must be dependency-free; this creates circular coupling risk
- **Fix:** Move `FamilyGroundingTrace` into `src/domain/` (e.g., `discovery-grounding.ts`)

---

## High Priority

### 2. Citation function extensibility not enforced at runtime
- **File:** `src/domain/taxonomy.ts:3-15`
- 6 citation functions defined, but only `empirical_attribution` is supported
- No runtime validation prevents processing unsupported functions
- **Fix:** Either reduce enum to only `empirical_attribution`, or add validation at pipeline entry that rejects unsupported functions. Document roadmap for which functions are M2, M2.5, M3.

### 3. Duplicate confidence enums
- `src/domain/extraction.ts:50` — `Confidence` = ["low", "medium", "high"]
- `src/domain/taxonomy.ts:56` — `ConfidenceLevel` = ["low", "medium", "high"]
- Identical values, different names. Only `Confidence` is used.
- **Fix:** Remove `ConfidenceLevel` from taxonomy.ts

### 4. `undefinedable()` helper is a confusing no-op
- **File:** `src/domain/common.ts:3-5`
- `z.preprocess((value) => value, schema.optional())` — the preprocess is a no-op
- Used 139+ times across domain schemas
- May silently accept `null` where `undefined` is intended
- **Fix:** Simplify to `schema.optional()` or document null-handling behavior

---

## Medium Priority

### 5. Unused taxonomy types (dead code)
- **File:** `src/domain/taxonomy.ts:27-40`
- `FidelityTopLabel` (F/D/E/U), `DistortionSubtype` (D1-D5), `ErrorSubtype` (E1-E3), `EvidenceVsInterpretation` — 0 usages each
- **Fix:** Remove or mark as "Reserved for M2.5+ fidelity classification phase"

### 6. Excessive `.passthrough()` on Zod schemas
- 68 occurrences across domain files
- Allows unknown properties through validation, risking silent data corruption
- **Fix:** Replace with `.strict()` where forward-compatibility isn't needed

### 7. Missing invariant: `bundleSize` <-> `isBundled`
- **File:** `src/domain/classification.ts:34-42`
- No constraint enforces `bundleSize > 1` when `isBundled=true`
- Invalid state possible: `{ isBundled: true, bundleSize: undefined }`
- **Fix:** Add `.refine()` validation

### 8. Decision logic semantics undocumented
- `PreScreenDecision` (binary) vs `M2Priority` (4-level) relationship is implicit
- Unclear which takes precedence when `decision=greenlight` but `m2Priority=caution`
- **Fix:** Add JSDoc clarifying precedence rules

### 9. Evaluation mode <-> citation role mapping undocumented
- Three overlapping concept hierarchies: `citationRole`, `evaluationMode`, `studyMode`
- No decision tree for which evaluationMode applies to which citationRole
- **Fix:** Add mapping documentation in `classification.ts`

---

## Strengths (no action needed)

- Domain purity (no filesystem, HTTP, or database imports — except one violation)
- Zero `any` types; consistent `z.infer<>` pattern
- All major data structures have Zod schemas
- SafeParse used at LLM response boundaries
- `DiscoveryHandoffMap` has explicit serialization helpers for the pipeline resume bundle while keeping stage primary artifacts canonical
