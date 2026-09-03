"use client";

import { useEffect, type Dispatch, type SetStateAction } from "react";
import type {
  HumanAssessment,
  ReportInspectorRecordRow,
} from "palimpsest/contract";
import { mutationKindValues } from "palimpsest/contract";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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

/**
 * The verdicts in the reviewer's language. The letter is the code the
 * pipeline stores; the name and the one-line test are what a reviewer reads,
 * so nobody has to remember what F stands for mid-session.
 */
export const VERDICT_CHOICES: ReadonlyArray<{
  value: HumanAssessment["humanVerdict"];
  code: string;
  key: string;
  name: string;
  test: string;
  tone: "success" | "danger" | "error" | "muted";
}> = [
  {
    value: "F",
    code: "F",
    key: "1",
    name: "Faithful",
    test: "Says what the paper found. Shorter or reworded is fine.",
    tone: "success",
  },
  {
    value: "D",
    code: "D",
    key: "2",
    name: "Distorted",
    test: "Right finding, but the meaning moved: stronger, broader, narrower, a condition dropped.",
    tone: "danger",
  },
  {
    value: "E",
    code: "E",
    key: "3",
    name: "Wrong",
    test: "Attributes something the paper did not find or show.",
    tone: "error",
  },
  {
    value: "U",
    code: "U",
    key: "4",
    name: "Can't tell",
    test: "The passages exist but genuinely don't settle it either way.",
    tone: "muted",
  },
];

/** Plain names for the dimensions a distortion can move along. */
export const MUTATION_KIND_LABELS: Record<
  (typeof mutationKindValues)[number],
  { name: string; hint: string }
> = {
  scope_broadened: {
    name: "Broader scope",
    hint: "Claims more than was shown: more regions, ages, or cases.",
  },
  scope_narrowed: {
    name: "Narrower scope",
    hint: "Reports less than was shown, or a subset as the whole.",
  },
  population_shifted: {
    name: "Different population",
    hint: "Species, age, cell type, or sample changed.",
  },
  certainty_strengthened: {
    name: "More certain",
    hint: "A hedge, range, or approximation became a definite statement.",
  },
  certainty_weakened: {
    name: "Less certain",
    hint: "A firm finding was hedged or made tentative.",
  },
  correlation_to_causation: {
    name: "Correlation became causation",
    hint: "An association is cited as a cause.",
  },
  conditions_dropped: {
    name: "Condition dropped",
    hint: "A qualifier the finding depended on is missing.",
  },
  endpoint_substituted: {
    name: "Different measure",
    hint: "What was measured or reported was swapped for something else.",
  },
  generality_increased: {
    name: "Over-generalized",
    hint: "One case or setting is cited as a general rule.",
  },
  entity_substituted: {
    name: "Different thing",
    hint: "A gene, region, cell type, or structure was swapped.",
  },
};

const toneClasses: Record<
  (typeof VERDICT_CHOICES)[number]["tone"],
  { badge: string; ring: string }
> = {
  success: {
    badge: "bg-[var(--success)] text-white",
    ring: "border-[var(--success)]",
  },
  danger: {
    badge: "bg-[var(--danger)] text-white",
    ring: "border-[var(--danger)]",
  },
  error: {
    badge: "bg-[rgba(151,100,44,0.9)] text-white",
    ring: "border-[rgba(151,100,44,0.9)]",
  },
  muted: {
    badge: "bg-[var(--border-strong)] text-white",
    ring: "border-[var(--border-strong)]",
  },
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function ProblemToggle({
  checked,
  label,
  detail,
  onChange,
}: {
  checked: boolean;
  label: string;
  detail: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1.5 text-sm">
      <input
        checked={checked}
        className="mt-1 size-4 accent-[var(--accent)]"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>
        <span className="text-[var(--text)]">{label}</span>
        <span className="block text-xs text-[var(--text-muted)]">{detail}</span>
      </span>
    </label>
  );
}

export function HumanReviewForm({
  activeRecord,
  form,
  setForm,
  onSave,
  saving,
  staleReport,
  dirty,
  saveError,
  savedStatus,
}: {
  activeRecord: ReportInspectorRecordRow;
  form: ReviewFormState;
  setForm: Dispatch<SetStateAction<ReviewFormState>>;
  onSave: (status: "draft" | "final") => void;
  saving: boolean;
  staleReport: boolean;
  dirty: boolean;
  saveError: string | null;
  /** Status of the saved review this form was loaded from, if any. */
  savedStatus: "draft" | "final" | null;
}) {
  const canSave =
    !saving &&
    !staleReport &&
    form.reviewer.trim().length > 0 &&
    form.humanVerdict !== "";

  function chooseVerdict(value: HumanAssessment["humanVerdict"]) {
    setForm((current) => ({
      ...current,
      humanVerdict: value,
      mutationKinds: value === "D" ? current.mutationKinds : [],
    }));
  }

  // Keys 1–4 (or F/D/E/U) pick a verdict; Enter saves and moves on. Typing
  // in the notes box is left alone, except Cmd/Ctrl+Enter to save.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey) {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          if (canSave) onSave("final");
        }
        return;
      }
      const choice = VERDICT_CHOICES.find(
        (entry) =>
          entry.key === event.key || entry.code === event.key.toUpperCase(),
      );
      if (choice) {
        event.preventDefault();
        setForm((current) => ({
          ...current,
          humanVerdict: choice.value,
          mutationKinds: choice.value === "D" ? current.mutationKinds : [],
        }));
        return;
      }
      if (event.key === "Enter" && canSave) {
        event.preventDefault();
        onSave("final");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSave, onSave, setForm]);

  const problemCount =
    Number(form.eligibleForAdjudication === "no") +
    Number(form.inScope === "no") +
    Number(form.citingSpanValid === "no") +
    Number(form.citedEvidenceValid === "no") +
    Number(form.evidenceSufficiency === "limited");
  const notJudgeable = form.humanVerdict === "not_adjudicable";

  return (
    <section
      aria-labelledby="your-call"
      className="rounded-[24px] border border-[var(--border-strong)] bg-white p-5 shadow-[0_12px_40px_rgba(30,30,40,0.06)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          className="font-[var(--font-instrument)] text-2xl tracking-[-0.03em] text-[var(--text)]"
          id="your-call"
        >
          Your call
        </h3>
        <p className="text-xs text-[var(--text-muted)]">
          Press 1–4 to choose, Enter to save and move on.
        </p>
      </div>

      <fieldset className="mt-4">
        <legend className="sr-only">Your verdict</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {VERDICT_CHOICES.map((choice) => {
            const selected = form.humanVerdict === choice.value;
            const tone = toneClasses[choice.tone];
            return (
              <label
                className={cn(
                  "flex cursor-pointer gap-3 rounded-[18px] border-2 px-4 py-3 transition",
                  selected
                    ? cn(tone.ring, "bg-[var(--panel-muted)]")
                    : "border-[var(--border)] bg-white hover:border-[var(--border-strong)]",
                )}
                key={choice.value}
              >
                <input
                  checked={selected}
                  className="sr-only"
                  name="humanVerdict"
                  onChange={() => chooseVerdict(choice.value)}
                  type="radio"
                  value={choice.value}
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold",
                    tone.badge,
                  )}
                >
                  {choice.code}
                </span>
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="text-base font-semibold text-[var(--text)]">
                      {choice.name}
                    </span>
                    <kbd className="rounded border border-[var(--border)] px-1 font-mono text-[10px] text-[var(--text-muted)]">
                      {choice.key}
                    </kbd>
                  </span>
                  <span className="block text-sm leading-6 text-[var(--text-muted)]">
                    {choice.test}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <label
          className={cn(
            "mt-2 flex cursor-pointer items-center gap-3 rounded-[14px] border px-4 py-2 text-sm transition",
            notJudgeable
              ? "border-[var(--border-strong)] bg-[var(--panel-muted)] text-[var(--text)]"
              : "border-transparent text-[var(--text-muted)] hover:border-[var(--border)]",
          )}
        >
          <input
            checked={notJudgeable}
            className="sr-only"
            name="humanVerdict"
            onChange={() => chooseVerdict("not_adjudicable")}
            type="radio"
            value="not_adjudicable"
          />
          <span className="font-semibold">Can't be judged</span>
          <span className="text-xs">
            Not an empirical attribution, or the record itself is broken. Say
            why below.
          </span>
        </label>
      </fieldset>

      {form.humanVerdict === "D" ? (
        <fieldset className="mt-5">
          <legend className="text-sm font-semibold text-[var(--text)]">
            What moved?{" "}
            <span className="font-normal text-[var(--text-muted)]">
              Pick up to three.
            </span>
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {mutationKindValues.map((kind) => {
              const checked = form.mutationKinds.includes(kind);
              const atLimit = form.mutationKinds.length >= 3;
              const label = MUTATION_KIND_LABELS[kind];
              return (
                <label
                  className={cn(
                    "inline-flex cursor-pointer items-center rounded-full border px-3 py-1.5 text-sm transition",
                    checked
                      ? "border-[var(--danger)] bg-[var(--danger)] text-white"
                      : "border-[var(--border)] bg-white text-[var(--text)] hover:border-[var(--border-strong)]",
                    !checked && atLimit && "cursor-not-allowed opacity-40",
                  )}
                  key={kind}
                  title={label.hint}
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
                  {label.name}
                </label>
              );
            })}
          </div>
          {form.mutationKinds.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-xs text-[var(--text-muted)]">
              {form.mutationKinds.map((kind) => (
                <li key={kind}>
                  <span className="font-semibold text-[var(--text)]">
                    {MUTATION_KIND_LABELS[kind].name}:
                  </span>{" "}
                  {MUTATION_KIND_LABELS[kind].hint}
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>
      ) : null}

      <div className="mt-5 space-y-2">
        <Label htmlFor="notes">
          Why?{" "}
          <span className="font-normal text-[var(--text-muted)]">
            Optional. One line is plenty.
          </span>
        </Label>
        <Textarea
          id="notes"
          onChange={(event) =>
            setForm((current) => ({ ...current, notes: event.target.value }))
          }
          rows={2}
          value={form.notes}
        />
      </div>

      <details className="mt-4 rounded-[16px] border border-dashed border-[var(--border)] px-4 py-2">
        <summary className="cursor-pointer text-sm text-[var(--text-muted)]">
          Something's off with this record
          {problemCount > 0 ? (
            <span className="ml-2 rounded-full bg-[var(--warning)] px-2 py-0.5 text-[11px] font-semibold text-white">
              {String(problemCount)} flagged
            </span>
          ) : null}
        </summary>
        <div className="mt-2 divide-y divide-[var(--border)]">
          <ProblemToggle
            checked={form.eligibleForAdjudication === "no"}
            detail="For example a methods citation or a passing mention, not a claim about a finding."
            label="This isn't the kind of citation to judge"
            onChange={(checked) =>
              setForm((current) => ({
                ...current,
                eligibleForAdjudication: checked ? "no" : "yes",
              }))
            }
          />
          <ProblemToggle
            checked={form.inScope === "no"}
            detail="The sentence cites the paper for something outside what it studied."
            label="This claim isn't about the cited paper's findings"
            onChange={(checked) =>
              setForm((current) => ({
                ...current,
                inScope: checked ? "no" : "yes",
              }))
            }
          />
          <ProblemToggle
            checked={form.citingSpanValid === "no"}
            detail="The wrong sentence is highlighted as the attribution."
            label="The highlighted sentence is the wrong one"
            onChange={(checked) =>
              setForm((current) => ({
                ...current,
                citingSpanValid: checked ? "no" : "yes",
              }))
            }
          />
          {form.citingSpanValid === "no" ? (
            <div className="space-y-3 py-3 pl-7">
              {activeRecord.occurrenceClaims.some(
                (claim) => claim.supportSpan,
              ) ? (
                <div className="space-y-1">
                  <p className="text-xs text-[var(--text-muted)]">
                    Start from the machine's span and edit it. The text must
                    match the citing passage exactly at these offsets.
                  </p>
                  {activeRecord.occurrenceClaims.map((claim) =>
                    claim.supportSpan ? (
                      <button
                        className="block rounded-[12px] border border-[var(--border)] px-3 py-1.5 text-left text-xs hover:bg-[var(--panel-muted)]"
                        key={claim.claimRecordId}
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            correctedCitingSpanText: claim.supportSpan!.text,
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
                        <span className="font-mono text-[var(--text-muted)]">
                          [{String(claim.supportSpan.charOffsetStart)}–
                          {String(claim.supportSpan.charOffsetEnd)}]
                        </span>{" "}
                        {claim.supportSpan.text}
                      </button>
                    ) : null,
                  )}
                </div>
              ) : null}
              <div className="grid gap-2 md:grid-cols-[1fr_96px_96px]">
                <div className="space-y-1">
                  <Label htmlFor="corrected-span-text">Correct sentence</Label>
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
                <div className="space-y-1">
                  <Label htmlFor="corrected-span-start">Start</Label>
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
                <div className="space-y-1">
                  <Label htmlFor="corrected-span-end">End</Label>
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
            </div>
          ) : null}
          <ProblemToggle
            checked={form.citedEvidenceValid === "no"}
            detail="The relevant part of the cited paper is elsewhere; tick the passages that should have been shown."
            label="The passages shown are the wrong ones"
            onChange={(checked) =>
              setForm((current) => ({
                ...current,
                citedEvidenceValid: checked ? "no" : "yes",
              }))
            }
          />
          {form.citedEvidenceValid === "no" ? (
            <div className="space-y-1 py-3 pl-7">
              {activeRecord.evidencePassages.map((passage, index) => {
                const checked = form.correctedCitedChunkIds.includes(
                  passage.chunkId,
                );
                return (
                  <label
                    className="flex items-start gap-3 rounded-[12px] border border-[var(--border)] px-3 py-2 text-xs leading-5"
                    key={passage.chunkId}
                  >
                    <input
                      checked={checked}
                      className="mt-0.5"
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
                    <span>
                      <span className="font-semibold text-[var(--text-muted)]">
                        Passage {String(index + 1)}.
                      </span>{" "}
                      {passage.text}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : null}
          <ProblemToggle
            checked={form.evidenceSufficiency === "limited"}
            detail="You could only judge from a figure, a caption, or general knowledge of the paper."
            label="The passages shown weren't enough to judge"
            onChange={(checked) =>
              setForm((current) => ({
                ...current,
                evidenceSufficiency: checked ? "limited" : "sufficient",
              }))
            }
          />
        </div>
      </details>

      {saveError ? (
        <p className="mt-4 text-sm text-[var(--danger)]">{saveError}</p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          disabled={!canSave}
          onClick={() => onSave("final")}
          type="button"
        >
          {saving ? "Saving…" : "Save and next"}
        </Button>
        <button
          className="text-sm text-[var(--text-muted)] underline-offset-4 hover:underline disabled:opacity-40"
          disabled={!canSave}
          onClick={() => onSave("draft")}
          type="button"
        >
          Save as draft
        </button>
        <span className="ml-auto text-xs text-[var(--text-muted)]">
          {form.reviewer.trim().length === 0
            ? "Add your name at the top to enable saving."
            : dirty
              ? "Unsaved changes"
              : savedStatus === "final"
                ? "Saved"
                : savedStatus === "draft"
                  ? "Saved as draft"
                  : ""}
        </span>
      </div>
    </section>
  );
}
