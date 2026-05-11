# CLI & Developer UX Audit

## Overall Assessment: Clean structure, needs help text, input validation, and onboarding docs

The CLI has clear command separation and consistent patterns. Main gaps are missing per-command help, weak input validation, opaque resume UX, and lack of developer onboarding documentation.

---

## Critical Issues

### 1. `.env.local` uses wrong env var name
- **File:** `.env.local` line 2 vs `src/config/env.ts:32`
- `CITATION_FIDELITY_DB_PATH` in `.env.local` but schema expects `PALIMPSEST_DB_PATH`
- **Fix:** Standardize on `PALIMPSEST_DB_PATH` everywhere

### 2. Doctor command outputs JSON only — no human-readable summary
- **File:** `src/cli/commands/doctor.ts:20`
- Raw JSON dump; user must parse mentally
- **Fix:** Add human-readable summary before JSON: `Database: OK`, `GROBID: ERROR (detail)`, etc.

### 3. No `--help` flag per command
- All 14 commands lack `--help` support; user must read source code for flag documentation
- Pipeline has 30+ flags, all undocumented
- **Fix:** Add per-command help with flag descriptions and examples

---

## High Priority

### 4. Typos in flags silently ignored
- No flag name validation; `--inupt` (typo) runs without error
- **Fix:** Build set of valid flags upfront; warn on unknown flags

### 5. No DOI format validation
- Input DOIs accepted as any string; invalid DOIs waste compute
- **Fix:** Add regex: `/^10\.\d{4,}/` validation in input schema

### 6. No file existence check before processing
- User passes non-existent `--input` path; gets raw ENOENT from Node.js
- **Fix:** Add early `fs.existsSync()` check in parseArgs with helpful message

### 7. Missing ANTHROPIC_API_KEY error lacks guidance
- **Files:** `pipeline.ts:450`, `discover.ts:187`, `adjudicate.ts:67`
- Message says "requires ANTHROPIC_API_KEY" but not where to set it
- **Fix:** Add: "Set it in .env.local or export ANTHROPIC_API_KEY=sk-..."

### 8. Resume UX is opaque
- When pipeline starts, run ID is not prominently displayed
- On interrupt, no guidance about `--run-id` resume
- **Fix:** Print run ID on start: `Resume with: npm run dev -- pipeline --run-id <ID>`

### 9. No examples of input/output file formats in docs
- `docs/pipeline.md` mentions "dois.json" but doesn't show format
- **Fix:** Add `docs/examples/` with sample `dois.json`, `shortlist.json`

### 10. No CLI flags reference documentation
- Pipeline has 30+ flags, all undocumented outside source code
- **Fix:** Create `docs/cli-flags.md` with grouped flag descriptions

---

## Medium Priority

### 11. Integer parsing edge cases
- `parseInt(argv[i+1]!, 10) || DEFAULT` — `--top 0` silently becomes default
- **Fix:** Validate `isNaN()` separately; use `Math.max(1, parsed)`

### 12. String arguments not validated
- `--study-mode` cast with `as StudyMode` without validation
- **Fix:** Check against allowed values; error on invalid

### 13. No `--version` flag
- Standard CLI ergonomics missing
- **Fix:** Add `--version` and `--help` global flags

### 14. No way to list active runs
- User can't find their run ID if interrupted
- **Fix:** Add `npm run dev -- runs` command

### 15. Run ID format not validated
- `--run-id garbage` accepted; fails later in DB query
- **Fix:** Validate UUID format in parseArgs

### 16. Validation errors don't show expected format
- "Invalid discovery input artifact: Extra keys" without showing valid schema
- **Fix:** Include expected shape example in error message

### 17. Doctor doesn't check Node version
- `package.json` specifies `node >= 22`; doctor doesn't verify
- **Fix:** Add Node version check in health checks

### 18. Output directory structure not documented in CLI output
- User doesn't know where artifacts go
- **Fix:** Print clear artifact summary at end of each command

---

## Low Priority

### 19. No spinner/loading indicator for long operations
- Discovery, screening, adjudication show nothing until first log line
- **Fix:** Add TTY-aware spinner (e.g., `ora`)

### 20. Inconsistent output formatting between commands
- Doctor outputs pure JSON, benchmark-blind uses labeled paths, discover uses progress events
- **Fix:** Define standard output format

### 21. No upper bounds on numeric arguments
- `--top 1000000` or `--family-concurrency 10000` accepted without guard
- **Fix:** Add sensible caps with warnings

### 22. No size limit on input files
- 1GB JSON loaded into memory without check
- **Fix:** Check file size before reading (50MB limit)

---

## Missing Documentation

| Document | Priority | Content |
|----------|----------|---------|
| `CONTRIBUTING.md` | HIGH | Clone, install, configure, verify, test, project structure |
| `docs/cli-flags.md` | HIGH | All pipeline flags grouped by category |
| `docs/troubleshooting.md` | MEDIUM | Common errors + remediation |
| `docs/examples/` | HIGH | Sample input/output files |
| `docs/debugging.md` | MEDIUM | How to debug failing stages |

---

## Strengths (no action needed)

- Clear one-command-one-file pattern (14 commands across 14 files)
- Help text mentions required dependencies (e.g., "needs ANTHROPIC_API_KEY")
- Structured progress events via `CF_PROGRESS` for UI consumption
- Per-stage log files written alongside stdout
- Cost summaries provided after LLM-based runs
- Artifact naming: consistent timestamps, organized per-run directories
- Zod schemas enforce input structure at load time
