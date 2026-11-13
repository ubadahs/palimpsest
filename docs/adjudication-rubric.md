# Adjudication Rubric

## Adjudicate (Uncalibrated)

Adjudicate (`runAdjudicate`) is the production stage for record-level fidelity decisions. It is wired through the executor and CLI, and is explicitly **uncalibrated** until tested against blinded human labels.

Verdicts follow the project taxonomy:

- `F` faithful: the attribution preserves the cited source’s substantive meaning; reasonable compression is allowed
- `D` distortion: a real source kernel exists, but scope, strength, certainty, causality, population, conditions, or generality is materially altered
- `E` error: the central attribution is unsupported, contradicted, about the wrong entity/result, or otherwise lacks the claimed source kernel
- `U` uncertain: exact cited evidence exists, but genuine scientific/attribution ambiguity prevents a defensible F/D/E judgment

### Where faithful ends

A change in certainty, scope, or generality is a distortion when a reader would come away believing the cited paper showed more, or less, than it did.

- The test runs in both directions. Strengthening a claim beyond what the source grounds is not faithful: a dropped hedge ("may contribute" becomes "contributes"), a widened quantifier ("several" becomes "all"), or an association restated as a cause. Weakening is not faithful either: a tested result restated as speculation, or a count narrowed below what the source reports.
- Rewording that leaves the reader's belief unchanged is faithful: a synonym ("reported" for "described"), a shorter restatement, or a detail left out that does not change what was shown.
- The reference point is what the source grounds with its own results, not what is plausible, known from other work, or flattering to the source. A reviewer who wrote the cited paper applies the same test to restatements that make it look stronger.

Human reviewers and the adjudication model are held to this same line. A constructed distortion in the evaluation harness should be one that crosses it.

Critical policy:

- `U` is **not** an operational failure bucket
- retrieval/provider/classification/gate failures are `not_adjudicated`, `adjudication_failed`, or `invalid_output` — never F/D/E/U
- ambiguous citation roles (`manual_review_role_ambiguous`, `manual_review_extraction_limited`) stay gated as operational non-verdicts and are not auto-routed to the adjudication model. Prepare may ask a small role-classification model to resolve a citation role the deterministic pass left `unclear`; that call labels the role only and never touches the verdict.
- `no_lexical_matches` never becomes `E` or `U`
- by default the adjudicator reads the whole seed text and quotes the passages its verdict rests on. Each quote is verified as exact text of the seed block it names; one that is not is dropped and counted. An `F`, `D`, or `U` left with no verified quote is `invalid_output`. An `E` may quote nothing, because the whole paper was read and may say nothing on the point
- confidence may be recorded but never chooses another model or alters the verdict path
- `D` verdicts name one to three categorical `mutationKinds` and a `direction`; `F`, `E`, and `U` carry none. These fields record which dimension of the source claim moved and are aggregated by Report as `mutationKindCounts` / `mutationDirectionCounts`; they are descriptive and do not route or reweight the verdict
- blinded human calibration is required before trust claims

## Report (Deterministic)

Report (`runReport`) is a pure deterministic audit accounting stage over the complete artifact chain.

Reporting rules that follow from this rubric:

- never report a faithfulness/F/D/E/U rate without the exact adjudicated-record denominator beside it
- never include `not_adjudicated`, retrieval failures, or invalid model output in F/D/E/U denominators
- never turn `no_lexical_matches` into `E` or `U`
- keep `U` (scientific ambiguity with evidence) separate from all operational failures
- do not include accuracy, agreement, benchmark, calibration, or human-vs-model statistics in the audit report; those belong to a separate evaluation workflow
- interpretation status remains `uncalibrated_research_output` until blinded human labels exist

## Non-Goals

- Do not treat operational failure as `U`
