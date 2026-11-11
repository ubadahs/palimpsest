"use client";

import type { BlindEvaluationCase } from "palimpsest/evaluation";

import { VERDICT_CHOICES } from "@/components/report/review-form";
import { ChoiceGrid } from "@/components/ui/choice-grid";
import { cn } from "@/lib/utils";

import { ROLE_CHOICES, type Draft } from "./drafts";

type DraftOf<T extends Draft["task"]> = Extract<Draft, { task: T }>;

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-[14px] border px-3 py-2 text-sm transition",
        checked
          ? "border-[var(--border-strong)] bg-[var(--panel-muted)] text-[var(--text)]"
          : "border-transparent text-[var(--text-muted)] hover:border-[var(--border)]",
      )}
    >
      <input
        checked={checked}
        className="size-4 accent-[var(--text)]"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {children}
    </label>
  );
}

function AdjudicationAnswer({
  draft,
  onChange,
}: {
  draft: DraftOf<"adjudication">;
  onChange: (draft: Draft) => void;
}) {
  return (
    <>
      <ChoiceGrid
        choices={VERDICT_CHOICES}
        legend="Your verdict"
        name="verdict"
        stacked
        onChange={(verdict) => onChange({ ...draft, verdict })}
        value={draft.verdict === "not_adjudicable" ? "" : draft.verdict}
      />
      <div className="mt-2 space-y-1">
        <Toggle
          checked={draft.verdict === "not_adjudicable"}
          onChange={(checked) =>
            onChange({ ...draft, verdict: checked ? "not_adjudicable" : "" })
          }
        >
          This can't be judged: it is not a claim about the cited paper
        </Toggle>
        <Toggle
          checked={draft.evidenceSufficiency === "limited"}
          onChange={(checked) =>
            onChange({
              ...draft,
              evidenceSufficiency: checked ? "limited" : "sufficient",
            })
          }
        >
          The passages shown are not enough to judge it
        </Toggle>
        <Toggle
          checked={draft.packetQuality !== "valid"}
          onChange={(checked) =>
            onChange({ ...draft, packetQuality: checked ? "invalid" : "valid" })
          }
        >
          The wrong sentence is highlighted
        </Toggle>
      </div>
    </>
  );
}

function SpanAnswer({
  item,
  draft,
  onChange,
}: {
  item: Extract<BlindEvaluationCase, { task: "span" }>;
  draft: DraftOf<"span">;
  onChange: (draft: Draft) => void;
}) {
  return (
    <div className="space-y-2">
      {draft.spans.map((span, index) => (
        <div
          className="flex items-start justify-between gap-3 rounded-[14px] border border-[var(--border)] bg-white px-3 py-2 text-sm"
          key={`${String(span.start)}-${String(span.end)}`}
        >
          <span>{item.context.slice(span.start, span.end)}</span>
          <button
            className="shrink-0 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--danger)]"
            onClick={() =>
              onChange({
                ...draft,
                spans: draft.spans.filter((_, at) => at !== index),
              })
            }
            type="button"
          >
            Remove
          </button>
        </div>
      ))}
      {draft.spans.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          Select the supporting words in the citing text. Select again to add
          another acceptable span.
        </p>
      ) : null}
      <Toggle
        checked={draft.noValidSpan}
        onChange={(noValidSpan) =>
          onChange({
            ...draft,
            noValidSpan,
            spans: noValidSpan ? [] : draft.spans,
          })
        }
      >
        No words in the text carry this claim
      </Toggle>
    </div>
  );
}

/** The reviewer's answer to one case, in the form its task takes. */
export function CaseAnswer({
  item,
  draft,
  onChange,
}: {
  item: BlindEvaluationCase;
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  if (draft.task === "adjudication")
    return <AdjudicationAnswer draft={draft} onChange={onChange} />;
  if (draft.task === "role")
    return (
      <ChoiceGrid
        choices={ROLE_CHOICES}
        legend="What the citation is used for"
        name="role"
        stacked
        onChange={(role) => onChange({ ...draft, role })}
        value={draft.role}
      />
    );
  if (draft.task === "rerank" && item.task === "rerank") {
    const graded = item.candidates.filter(
      (candidate) => draft.grades[candidate.chunkId],
    ).length;
    return (
      <p className="text-sm leading-6 text-[var(--text-muted)]">
        <strong className="text-[var(--text)]">
          {graded} of {item.candidates.length}
        </strong>{" "}
        passages graded. Keys 1–4 grade the outlined passage: bears on it,
        context, irrelevant, can't judge. A passage that contradicts or
        qualifies the claim bears on it.
      </p>
    );
  }
  if (draft.task === "span" && item.task === "span")
    return <SpanAnswer draft={draft} item={item} onChange={onChange} />;
  return null;
}
