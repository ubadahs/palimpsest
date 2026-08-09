# Palimpsest

## Evaluation Protocol

**Date:** July 2026
**Status:** Active for uncalibrated canonical outputs
**Purpose:** Define how to evaluate whether the canonical six-stage pipeline produces scientifically useful, reviewable fidelity judgments.

## Canonical Reference

Authoritative current docs:

- [pipeline.md](./pipeline.md) — runnable workflow
- [status.md](./status.md) — what is implemented
- [adjudication-rubric.md](./adjudication-rubric.md) — F/D/E/U and Report denominator rules

Historical POC conception docs (shortlist/pre-screen era) are archived under [archive/pre-canonical/](./archive/pre-canonical/) and are not operational authority.

## Evaluation Question

Can the system correctly determine when a citation record is eligible for adjudication and, when it is, produce span-grounded F/D/E/U judgments that are accurate enough to surface real mutation patterns in a small claim-family cluster?

This protocol evaluates the system as a triage instrument, not as an autonomous judge. Canonical Adjudicate remains **uncalibrated** until blinded human labels exist.

## What Is Being Evaluated

The system is evaluated at four layers:

1. **Access and materialization**
   - Was the seed/citing object resolved?
   - Was usable full text available when required by a stage?
2. **Eligibility and extraction**
   - Did Discover/Prepare identify a real empirical-attribution citation occurrence?
   - Did it capture the correct citing span and attributed claim?
3. **Grounding and retrieval**
   - Did Scope record verified grounding without excluding families incorrectly?
   - Did Evidence find genuinely relevant cited-paper spans over immutable Scope seed text?
4. **Final judgment**
   - Given the grounded spans, is the `F`/`D`/`E`/`U` label reasonable?
   - Are operational non-verdicts (`not_adjudicated`, `adjudication_failed`, `invalid_output`) kept out of the F/D/E/U denominator?

These layers must be judged separately. A bad retrieval result should not be counted as a pure classification error, and retrieval failure must never be scored as `U`.

## Review Set

Human review should cover:

- all `E` cases
- all `D` cases for the first claim family
- a random sample of `F` cases
- a random sample of `U` cases
- a sample of operational non-verdicts to confirm they are not mislabeled as F/D/E/U

The `F` sample matters disproportionately. False `F` labels are the highest-risk operational error because they create fake confidence in suspect edges.

After the first claim family, the review load can be reduced, but `E` cases should still all be checked.

## Human Reviewer Task

For each reviewed citation instance, the reviewer should answer:

1. Was the record eligible for adjudication, or correctly gated as an operational non-verdict?
2. Is this citation in scope for the evaluation?
3. Is the extracted citing span the real claim-bearing span?
4. Is the cited span real and relevant?
5. Is the section label correct when present?
6. Is the top-level label correct when adjudicated?
7. Does the rationale match the evidence?
8. Was selected text evidence sufficient for the judgment (for example, not figure-only)?

If the cited span is wrong or not relevant, the judgment is invalid even if the final label appears plausible.

Score these layers separately when summarizing calibration:

- `labelAgreement` — human and model top-label match
- `evidenceSufficiency` — packet evidence could support the judgment
- `endToEndValid` — `labelAgreement && evidenceSufficiency` and packet quality OK

Do not invent new product verdict modes for these fields.

## Review Form Fields

Each reviewed case should record:

- citation / record id
- claim family
- reviewer name
- eligible for adjudication yes or no
- in-scope yes or no
- citing span valid yes or no (with exact offset-bound correction into the citation context when no)
- cited span valid yes or no (with corrected Evidence chunk IDs when no)
- evidence sufficiency sufficient or limited
- top-level label correct yes or no or not applicable (with overridden `F`/`D`/`E`/`U` when no)
- free-text notes
- draft vs final review status

### Local review workspace

The Report explorer **Review** tab implements this form against an append-only, report-hash-bound sidecar (`data/runs/<runId>/review/<reportArtifactId>/events.json`). Use **Families** to inspect claim mutation chronologies before or during review. Export JSON/CSV from the Review tab for offline calibration metrics. Machine artifacts remain immutable; human overrides live only in the sidecar.

## Metrics

Track the following metrics separately.

### Layer 1: access and accounting

- family and occurrence retention through Scope/Prepare/Evidence/Adjudicate
- distribution of operational non-verdicts versus adjudicated records

### Layer 2: extraction quality

- percent of reviewed cases that are truly in scope
- percent with valid citing spans
- percent with acceptable attributed-claim extraction

### Layer 3: grounding / retrieval quality

- percent with valid cited spans
- percent of BM25 `no_lexical_matches` correctly kept as operational non-verdicts

### `U` behavior

- overall `U` rate among adjudicated records only
- percent of `U` labels caused by genuine scientific/attribution ambiguity
- confirm retrieval/provider failures are never counted as `U`

### Layer 4: judgment quality

- top-level label agreement on cases with valid grounding
- precision of flagged `D` and `E` cases

## Success Readout

Use the metrics in this document together with [status.md](./status.md) and [adjudication-rubric.md](./adjudication-rubric.md). Do not treat runnable pipeline success as calibration success.

The readout should report both claim-mutation findings and operational accounting for the selected claim families.

## Failure Modes To Watch

The system should be considered weak if any of the following dominate:

- too many citations are misidentified as empirical attributions
- retrieved cited spans are often irrelevant
- the model uses discussion text as if it were evidence without saying so
- the system defaults to `F` when evidence is thin; false `F` labels are the highest-risk operational error
- publishing opacity is misread as citation distortion
- operational failures are absorbed into `U`

## Stop Rule

Stop early if grounding quality is too poor to support meaningful review. If the reviewer cannot trust the cited spans, the rest of the pipeline is not ready. Do not make trust claims from uncalibrated F/D/E/U rates alone.

## Threats To Validity

- human review is domain-limited and may not generalize beyond the chosen literature
- open-access cited papers may not be representative of the broader literature
- inaccessible full text inflates operational non-verdicts
- some fidelity judgments depend on background knowledge not stated in either paper
- internal tension inside the cited paper can make a single "paper position" hard to define

These limits should be stated explicitly in every readout.

## Decision After Evaluation

There are only three acceptable conclusions:

1. **Proceed:** the system is noisy but useful, and it surfaces real patterns.
2. **Refine:** the idea looks real, but one pipeline layer is too weak and must be fixed before scaling.
3. **Stop:** the system does not produce convincing insight in the narrow setting.

The point of this protocol is to make that decision quickly and honestly.
