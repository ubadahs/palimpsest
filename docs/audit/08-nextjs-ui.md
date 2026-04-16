# Next.js UI Audit

## Overall Assessment: Well-structured local dashboard with testing gaps and data-fetching issues

The UI is a solid local-only Next.js 15 app with App Router, good TypeScript strictness, and clean component separation. Main concerns are broken test suite, waterfall data fetching, and incomplete error boundaries.

---

## Critical Issues

### 1. Test suite broken (ESM/CJS conflict)
- All 6 UI test files fail to run due to `ERR_REQUIRE_ESM` in jsdom dependency chain
- Vitest cannot start workers
- **Fix:** Resolve ESM/CJS conflict in vitest config (likely needs `environment: "jsdom"` with proper ESM support or `--pool=forks` flag)

### 2. Waterfall data fetching on stage detail page
- **File:** `apps/ui/app/runs/[runId]/stages/[stageKey]/page.tsx:20-26`
- Two sequential server calls: `getRunDetailOrThrow()` then `getStageGroupDetailOrThrow()`
- **Fix:** Parallelize with `Promise.all()`

### 3. API error handling returns 400 for all errors
- **File:** `apps/ui/lib/api-route.ts:45-46`
- Generic `handleApiError()` returns 400 regardless of error type
- **Fix:** Return 404 for missing resources, 422 for validation errors, 500 for unexpected errors

### 4. Artifact `kind` parameter not validated
- **File:** `apps/ui/pages/api/runs/[runId]/stages/[stageKey]/artifacts/[kind].ts:32`
- No whitelist of allowed artifact kinds; potential path traversal
- **Fix:** Whitelist allowed artifact kinds or sanitize input

---

## High Priority

### 5. `suppressHydrationWarning` masks real issues
- **Files:** `run-detail-client.tsx:159,161,177`, `stage-detail-client.tsx:176`
- Multiple `suppressHydrationWarning` attributes for date/time rendering
- **Fix:** Extract date formatting to `useEffect` or pass server-formatted time as props

### 6. No error boundaries
- No `error.tsx` or `not-found.tsx` boundary files for any route
- **Fix:** Add error boundaries for graceful error display

### 7. Polling has no error callback
- **File:** `apps/ui/lib/use-poll.ts:23-35`
- Fetch failures in poll loop silently swallowed
- **Fix:** Add `onError` callback to `usePoll()` hook

### 8. PDF upload has no content-type validation
- **File:** `apps/ui/pages/api/runs/index.ts:26-28`
- 20MB body limit but no content-type check before base64 parsing
- **Fix:** Validate `content-type: application/json` on request

---

## Medium Priority

### 9. ESLint disabled during build
- **File:** `apps/ui/next.config.mjs`
- `eslint: { ignoreDuringBuilds: true }` — lint issues won't block CI
- **Fix:** Enable or run lint separately in CI

### 10. No success notifications for async actions
- Continue, Cancel, Rerun buttons show no confirmation
- **Fix:** Add transient success toast/message

### 11. Cost fetch happens client-side after render
- **File:** `apps/ui/components/run-detail-client.tsx:93-108`
- Could be server-side for faster display
- **Fix:** Move to SSR or show skeleton

### 12. Log panel loads even when collapsed
- **File:** `apps/ui/components/log-panel.tsx`
- Fetches on mount regardless of visibility
- **Fix:** Guard with `!collapsed` before fetch

### 13. Large JSON artifacts rendered as plain text
- No syntax highlighting for `primary.json` artifacts
- **Fix:** Use code block component with JSON highlighting

### 14. Form validation is client-side only
- No real-time field validation (e.g., DOI format check)
- **Fix:** Add inline validation feedback

---

## Low Priority

### 15. No dark mode support
- Only light theme defined in `globals.css`
- **Fix:** Add `@media (prefers-color-scheme: dark)` variants if desired

### 16. Some hardcoded rgba colors not centralized
- e.g., `rgba(155,92,65,0.08)` scattered in components
- **Fix:** Extract to CSS custom properties

### 17. Badge variant mapping has no exhaustiveness check
- **File:** `apps/ui/lib/status-variants.ts`
- **Fix:** Use `satisfies` or const assertion

---

## Testing Gaps

| Component/Feature | Status |
|-------------------|--------|
| `NewRunForm` (validation, submission) | Not tested |
| `StageDetailClient` (family selection, rerun) | Not tested |
| All 11 API routes | Not tested |
| `usePoll()` hook | Not tested |
| Component-to-API integration | Not tested |
| E2E user flows | Not tested |

---

## Strengths (no action needed)

- Clean App Router structure: root -> runs -> [runId] -> stages -> [stageKey]
- Proper server vs. client component separation (`"use client"` only where needed)
- Consistent error handling via `handleApiError()` wrapper
- Input validation using Zod schemas on API routes
- Clean state management: `useState` + `useTransition` (no unnecessary state libraries)
- Accessible: ARIA labels, semantic HTML throughout
- Responsive: Tailwind breakpoints (md:, xl:, sm:)
- Lazy artifact loading (only on tab click)
- `usePoll()` with configurable intervals (2s running, 10s dashboard)
- TypeScript strict mode enabled with `noUncheckedIndexedAccess`
