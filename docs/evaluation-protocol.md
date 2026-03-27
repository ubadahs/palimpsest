# Citation Fidelity Analyzer

## Evaluation Protocol

**Date:** March 2026  
**Status:** Draft  
**Purpose:** Define how to evaluate whether the implementation satisfies the [PRD](./prd.md).

## Canonical Reference

The [PRD](./prd.md) is the source of truth for:

- scope
- taxonomy
- required outputs
- overall success criteria
- kill criterion

## Evaluation Question

Can the system correctly determine whether a citation edge is auditable and, when it is auditable, produce span-grounded citation-fidelity judgments that are accurate enough to surface real mutation patterns in a small claim-family cluster?

This protocol evaluates the POC as a triage instrument, not as an autonomous judge.

## What Is Being Evaluated

The system is evaluated at four layers:

1. **Auditability and access**
   - Was the cited object resolved?
   - Was usable full text available?
   - Was the edge correctly labeled `auditable`, `partially_auditable`, or `not_auditable`?
2. **Eligibility and extraction**
   - Did it identify a real empirical-attribution citation?
   - Did it capture the correct citing span and attributed claim?
3. **Grounding and retrieval**
   - Did it find a genuinely relevant span in the cited paper?
   - Is the cited span correctly located and labeled by section?
   - Did it avoid relying only on the abstract when full fidelity scoring was not justified?
4. **Final judgment**
   - Given the grounded spans, is the `F/D/E/U` label reasonable?
   - If `D` or `E`, is the subtype reasonable?

These layers must be judged separately. A bad retrieval result should not be counted as a pure classification error.

## Review Set

Human review should cover:

- all `E` cases
- all `D` cases for the first claim family
- a random sample of `F` cases
- a random sample of `U` cases
- a sample of `partially_auditable` and `not_auditable` edges

The `F` sample matters disproportionately. False `F` labels are the highest-risk operational error because they create fake confidence in suspect edges.

After the first claim family, the review load can be reduced, but `E` cases should still all be checked.

## Human Reviewer Task

For each reviewed citation instance, the reviewer should answer:

1. Is this edge truly `auditable`, `partially_auditable`, or `not_auditable`?
2. Is this citation in scope for the POC?
3. Is the extracted citing span the real claim-bearing span?
4. Is the cited span real and relevant?
5. Is the section label correct?
6. Is the system avoiding abstract-only scoring where fidelity cannot be grounded?
7. Is the top-level label correct?
8. If labeled `D` or `E`, is the subtype correct?
9. Does the rationale match the evidence?

If the cited span is wrong or not relevant, the judgment is invalid even if the final label appears plausible.

## Review Form Fields

Each reviewed case should record:

- citation id
- claim family
- reviewer name
- auditability status correct yes or no
- in-scope yes or no
- citing span valid yes or no
- cited span valid yes or no
- cited span section valid yes or no
- top-level label correct yes or no
- subtype correct yes or no or not applicable
- free-text notes

## Metrics

Track the following metrics separately.

### Layer 1: auditability

- auditable-edge coverage by claim family
- distribution of `auditable`, `partially_auditable`, and `not_auditable` edges
- reviewer agreement on auditability status

### Layer 2: extraction quality

- percent of reviewed cases that are truly in scope
- percent with valid citing spans
- percent with acceptable attributed-claim extraction

### Layer 3: grounding quality

- percent with valid cited spans
- percent with correct section labels
- percent of abstract-only edges correctly left unscored

### `U` behavior

- overall `U` rate
- percent of `U` labels caused by retrieval failure
- percent of `U` labels caused by genuine ambiguity

### Layer 4: judgment quality

- top-level label agreement on cases with valid grounding
- subtype agreement on grounded `D` and `E` cases
- precision of flagged `D` and `E` cases

## Success Readout

Use the metrics in this document to determine whether the [PRD](./prd.md) success criteria have been met. This protocol does not redefine those criteria.

The readout should report both claim-mutation findings and auditability findings for the selected claim families.

## Failure Modes To Watch

The POC should be considered weak if any of the following dominate:

- too many citations are misidentified as empirical attributions
- abstract-only edges are treated as fully auditable
- retrieved cited spans are often irrelevant
- the model uses discussion text as if it were evidence without saying so
- the system defaults to `F` when evidence is thin; false `F` labels are the highest-risk operational error because they create fake confidence
- publishing opacity is misread as citation distortion
- the system avoids `U` even when grounding is poor

## Stop Rule

Apply the kill criterion from the [PRD](./prd.md).

Also stop early if grounding quality is too poor to support meaningful review. If the reviewer cannot trust the cited spans, the rest of the pipeline is not ready.

## Threats To Validity

- human review is domain-limited and may not generalize beyond biology
- open-access cited papers may not be representative of the broader literature
- abstract-only edges usually cannot be scored for fidelity
- inaccessible full text inflates `U` and `not_auditable` rates
- some fidelity judgments depend on background knowledge not stated in either paper
- internal tension inside the cited paper can make a single "paper position" hard to define

These limits should be stated explicitly in every POC readout. They are not merely pipeline weaknesses; they are part of the metascientific picture.

## Decision After The POC

There are only three acceptable conclusions:

1. **Proceed:** the system is noisy but useful, and it surfaces real patterns.
2. **Refine:** the idea looks real, but one pipeline layer is too weak and must be fixed before scaling.
3. **Stop:** the system does not produce convincing insight in the narrow setting.

The point of this protocol is to make that decision quickly and honestly.
