"use client";

import type { Dispatch, SetStateAction } from "react";
import type {
  HumanAssessment,
  ReportInspectorRecordRow,
} from "palimpsest/contract";
import { mutationKindValues } from "palimpsest/contract";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { VERDICT_ORDER } from "@/lib/verdict-tokens";

export type ReviewFormState = {
  reviewer: string;
  eligibleForAdjudication: HumanAssessment["eligibleForAdjudication"];
  inScope: HumanAssessment["inScope"];
  citingSpanValid: HumanAssessment["citingSpanValid"];
  correctedCitingSpanText: string;
  correctedCitingSpanStart: string;
  correctedCitingSpanEnd: string;
  citedEvidenceValid: HumanAssessment["citedEvidenceValid"];
  correctedCitedChunkIds: string[];
  evidenceSufficiency: HumanAssessment["evidenceSufficiency"];
  humanVerdict: HumanAssessment["humanVerdict"] | "";
  mutationKinds: HumanAssessment["mutationKinds"];
  notes: string;
};

export function emptyReviewForm(reviewer = ""): ReviewFormState {
  return {
    reviewer,
    eligibleForAdjudication: "yes",
    inScope: "yes",
    citingSpanValid: "yes",
    correctedCitingSpanText: "",
    correctedCitingSpanStart: "",
    correctedCitingSpanEnd: "",
    citedEvidenceValid: "yes",
    correctedCitedChunkIds: [],
    evidenceSufficiency: "sufficient",
    humanVerdict: "",
    mutationKinds: [],
    notes: "",
  };
}

export function reviewFormFromAssessment(
  assessment: HumanAssessment,
  reviewer: string,
): ReviewFormState {
  return {
    reviewer,
    eligibleForAdjudication: assessment.eligibleForAdjudication,
    inScope: assessment.inScope,
    citingSpanValid: assessment.citingSpanValid,
    correctedCitingSpanText: assessment.correctedCitingSpan?.text ?? "",
    correctedCitingSpanStart:
      assessment.correctedCitingSpan != null
        ? String(assessment.correctedCitingSpan.charOffsetStart)
        : "",
    correctedCitingSpanEnd:
      assessment.correctedCitingSpan != null
        ? String(assessment.correctedCitingSpan.charOffsetEnd)
        : "",
    citedEvidenceValid: assessment.citedEvidenceValid,
    correctedCitedChunkIds: assessment.correctedCitedChunkIds ?? [],
    evidenceSufficiency: assessment.evidenceSufficiency,
    humanVerdict: assessment.humanVerdict,
    mutationKinds: assessment.mutationKinds,
    notes: assessment.notes,
  };
}

export function buildHumanAssessment(
  form: ReviewFormState,
  blinded: boolean,
): HumanAssessment {
  if (form.humanVerdict === "") {
    // The save buttons stay disabled until a verdict is chosen.
    throw new Error("A human verdict is required before saving a review.");
  }
  const assessment: HumanAssessment = {
    eligibleForAdjudication: form.eligibleForAdjudication,
    inScope: form.inScope,
    citingSpanValid: form.citingSpanValid,
    citedEvidenceValid: form.citedEvidenceValid,
    evidenceSufficiency: form.evidenceSufficiency,
    humanVerdict: form.humanVerdict,
    blinded,
    mutationKinds: form.humanVerdict === "D" ? form.mutationKinds : [],
    notes: form.notes,
  };
  if (form.citingSpanValid === "no") {
    assessment.correctedCitingSpan = {
      text: form.correctedCitingSpanText,
      charOffsetStart: Number(form.correctedCitingSpanStart),
      charOffsetEnd: Number(form.correctedCitingSpanEnd),
    };
  }
  if (form.citedEvidenceValid === "no") {
    assessment.correctedCitedChunkIds = form.correctedCitedChunkIds;
  }
  return assessment;
}

function RadioRow<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
        {label}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            className={cn(
              "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition",
              value === option.value
                ? "border-[var(--border-strong)] bg-[var(--text)] text-white"
                : "border-[var(--border)] bg-white/70 text-[var(--text-muted)] hover:bg-white",
            )}
            key={option.value}
          >
            <input
              checked={value === option.value}
              className="sr-only"
              name={name}
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function HumanReviewForm({
  activeRecord,
  form,
  setForm,
  onReviewerChange,
  onSave,
  saving,
  staleReport,
  dirty,
  saveError,
}: {
  activeRecord: ReportInspectorRecordRow;
  form: ReviewFormState;
  setForm: Dispatch<SetStateAction<ReviewFormState>>;
  onReviewerChange: (reviewer: string) => void;
  onSave: (status: "draft" | "final") => void;
  saving: boolean;
  staleReport: boolean;
  dirty: boolean;
  saveError: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <h3 className="font-semibold text-[var(--text)]">Human assessment</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Append-only sidecar. Canonical machine artifacts stay immutable.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="reviewer">Reviewer</Label>
          <Input
            id="reviewer"
            onChange={(event) => onReviewerChange(event.target.value)}
            placeholder="Your name"
            value={form.reviewer}
          />
        </div>

        <RadioRow
          label="Eligible for adjudication"
          name="eligible"
          onChange={(value) =>
            setForm((current) => ({
              ...current,
              eligibleForAdjudication: value,
            }))
          }
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
          value={form.eligibleForAdjudication}
        />
        <RadioRow
          label="In scope"
          name="inscope"
          onChange={(value) =>
            setForm((current) => ({ ...current, inScope: value }))
          }
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
          value={form.inScope}
        />
        <RadioRow
          label="Citing span valid"
          name="citingspan"
          onChange={(value) =>
            setForm((current) => ({ ...current, citingSpanValid: value }))
          }
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
          value={form.citingSpanValid}
        />
        {form.citingSpanValid === "no" ? (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2 md:col-span-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                Machine span, for reference
              </p>
              {activeRecord.occurrenceClaims.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No verified support span was recorded for this record.
                </p>
              ) : (
                <ul className="space-y-1">
                  {activeRecord.occurrenceClaims.map((claim) => (
                    <li
                      className="rounded-[14px] border border-[var(--border)] bg-white/60 px-3 py-2 text-xs leading-6"
                      key={claim.claimRecordId}
                    >
                      {claim.supportSpan ? (
                        <>
                          <button
                            className="mr-2 rounded-full border border-[var(--border)] px-2 py-0.5 font-semibold text-[var(--accent)]"
                            onClick={() =>
                              setForm((current) => ({
                                ...current,
                                correctedCitingSpanText:
                                  claim.supportSpan!.text,
                                correctedCitingSpanStart: String(
                                  claim.supportSpan!.charOffsetStart,
                                ),
                                correctedCitingSpanEnd: String(
                                  claim.supportSpan!.charOffsetEnd,
                                ),
                              }))
                            }
                            type="button"
                          >
                            copy
                          </button>
                          <span className="font-mono">
                            [{String(claim.supportSpan.charOffsetStart)}–
                            {String(claim.supportSpan.charOffsetEnd)}]
                          </span>{" "}
                          {claim.supportSpan.text}
                        </>
                      ) : (
                        <>
                          <span className="font-mono">[no verified span]</span>{" "}
                          {claim.extractedClaimText}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-[var(--text-muted)]">
                The correction is rejected unless the text matches the citation
                context exactly at these offsets.
              </p>
            </div>
            <div className="space-y-2 md:col-span-3">
              <Label htmlFor="corrected-span-text">
                Corrected citing span text
              </Label>
              <Input
                id="corrected-span-text"
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    correctedCitingSpanText: event.target.value,
                  }))
                }
                value={form.correctedCitingSpanText}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="corrected-span-start">Start offset</Label>
              <Input
                id="corrected-span-start"
                inputMode="numeric"
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    correctedCitingSpanStart: event.target.value,
                  }))
                }
                value={form.correctedCitingSpanStart}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="corrected-span-end">End offset</Label>
              <Input
                id="corrected-span-end"
                inputMode="numeric"
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    correctedCitingSpanEnd: event.target.value,
                  }))
                }
                value={form.correctedCitingSpanEnd}
              />
            </div>
          </div>
        ) : null}

        <RadioRow
          label="Cited evidence valid"
          name="citedevidence"
          onChange={(value) =>
            setForm((current) => ({ ...current, citedEvidenceValid: value }))
          }
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
          value={form.citedEvidenceValid}
        />
        {form.citedEvidenceValid === "no" ? (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              Corrected cited chunks
            </legend>
            <div className="space-y-2">
              {activeRecord.evidencePassages.map((passage) => {
                const checked = form.correctedCitedChunkIds.includes(
                  passage.chunkId,
                );
                return (
                  <label
                    className="flex items-start gap-3 rounded-[16px] border border-[var(--border)] bg-white/60 px-3 py-2 text-sm"
                    key={passage.chunkId}
                  >
                    <input
                      checked={checked}
                      onChange={() =>
                        setForm((current) => ({
                          ...current,
                          correctedCitedChunkIds: checked
                            ? current.correctedCitedChunkIds.filter(
                                (id) => id !== passage.chunkId,
                              )
                            : [
                                ...current.correctedCitedChunkIds,
                                passage.chunkId,
                              ],
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{passage.text}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        <RadioRow
          label="Evidence sufficiency"
          name="sufficiency"
          onChange={(value) =>
            setForm((current) => ({
              ...current,
              evidenceSufficiency: value,
            }))
          }
          options={[
            { value: "sufficient", label: "Sufficient" },
            { value: "limited", label: "Limited" },
          ]}
          value={form.evidenceSufficiency}
        />
        <RadioRow
          label="Your verdict"
          name="humanVerdict"
          onChange={(value) =>
            setForm((current) => ({
              ...current,
              humanVerdict: value,
              mutationKinds: value === "D" ? current.mutationKinds : [],
            }))
          }
          options={[
            ...VERDICT_ORDER.map((verdict) => ({
              value: verdict as HumanAssessment["humanVerdict"],
              label: verdict,
            })),
            {
              value: "not_adjudicable" as HumanAssessment["humanVerdict"],
              label: "Not adjudicable",
            },
          ]}
          value={form.humanVerdict as HumanAssessment["humanVerdict"]}
        />
        {form.humanVerdict === "D" ? (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              Which dimensions moved
            </legend>
            <div className="flex flex-wrap gap-2">
              {mutationKindValues.map((kind) => {
                const checked = form.mutationKinds.includes(kind);
                const atLimit = form.mutationKinds.length >= 3;
                return (
                  <label
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                      checked
                        ? "border-[var(--border-strong)] bg-[var(--text)] text-white"
                        : "border-[var(--border)] bg-white/70 text-[var(--text-muted)] hover:bg-white",
                      !checked && atLimit && "cursor-not-allowed opacity-50",
                    )}
                    key={kind}
                  >
                    <input
                      checked={checked}
                      className="sr-only"
                      disabled={!checked && atLimit}
                      onChange={() =>
                        setForm((current) => ({
                          ...current,
                          mutationKinds: checked
                            ? current.mutationKinds.filter((k) => k !== kind)
                            : [...current.mutationKinds, kind],
                        }))
                      }
                      type="checkbox"
                    />
                    {kind}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="notes">Notes</Label>
          <Textarea
            id="notes"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                notes: event.target.value,
              }))
            }
            value={form.notes}
          />
        </div>

        {saveError ? (
          <p className="text-sm text-[var(--danger)]">{saveError}</p>
        ) : null}
        {dirty ? (
          <p className="text-xs text-[var(--warning)]">Unsaved changes</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              saving ||
              form.reviewer.trim().length === 0 ||
              form.humanVerdict === "" ||
              staleReport
            }
            onClick={() => onSave("draft")}
            type="button"
            variant="secondary"
          >
            Save draft
          </Button>
          <Button
            disabled={
              saving ||
              form.reviewer.trim().length === 0 ||
              form.humanVerdict === "" ||
              staleReport
            }
            onClick={() => onSave("final")}
            type="button"
          >
            Mark final
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
