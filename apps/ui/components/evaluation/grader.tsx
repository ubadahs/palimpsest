"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnnotationEvent } from "palimpsest/evaluation";

import { Button } from "@/components/ui/button";
import { isTypingTarget } from "@/components/ui/choice-grid";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  gradedCaseIds,
  ownAnnotation,
  type DatasetView,
  type GradingQueue,
} from "@/lib/evaluation-client";
import { fetchJson, jsonPost } from "@/lib/utils";

import { CaseAnswer } from "./case-answer";
import { CaseBody } from "./case-body";
import { draftAfterKey, draftValue, initialDraft, type Draft } from "./drafts";
import { ModelAnswers, type Revealed } from "./model-answers";

/**
 * One case at a time, answered from the keyboard. A final answer moves to the
 * next case the reviewer has not graded, so a queue is worked top to bottom
 * and can be left and resumed.
 */
export function Grader({
  view,
  queue,
  reviewer,
  onReviewerChange,
  onSaved,
}: {
  view: DatasetView;
  queue: GradingQueue;
  reviewer: string;
  onReviewerChange: (name: string) => void;
  onSaved: () => Promise<void>;
}) {
  const cases = useMemo(() => {
    const byId = new Map(view.cases.map((item) => [item.caseId, item]));
    return queue.caseIds.flatMap((caseId) => byId.get(caseId) ?? []);
  }, [view.cases, queue.caseIds]);
  const graded = useMemo(
    () => gradedCaseIds(view.annotations, reviewer),
    [view.annotations, reviewer],
  );
  const firstUngraded = cases.findIndex((item) => !graded.has(item.caseId));

  // Until the reviewer moves, the session sits on the first ungraded case.
  const [chosen, setChosen] = useState<number | null>(null);
  const position = chosen ?? Math.max(firstUngraded, 0);
  const item = cases[position];
  const own = item
    ? ownAnnotation(view.annotations, item.caseId, reviewer)
    : undefined;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [notes, setNotes] = useState("");
  const [settlesDisagreement, setSettlesDisagreement] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setDraft(initialDraft(item.task, own?.value));
    setNotes(own?.notes ?? "");
    setSettlesDisagreement(false);
    setRevealed(null);
    setError(null);
    // Keyed on the case and its saved answer, so editing does not reset it.
  }, [item?.caseId, own?.eventId]);

  const value = item && draft ? draftValue(item, draft) : null;
  const canSave = value != null && reviewer.trim() !== "" && !saving;
  const finalAnswers = item
    ? view.annotations.filter(
        (event) => event.caseId === item.caseId && event.status === "final",
      )
    : [];
  const disputed =
    new Set(finalAnswers.map((event) => JSON.stringify(event.value))).size > 1;

  const go = useCallback(
    (step: number) =>
      setChosen(Math.min(Math.max(position + step, 0), cases.length - 1)),
    [position, cases.length],
  );

  const save = useCallback(
    async (status: AnnotationEvent["status"]) => {
      if (!item || !canSave) return;
      setSaving(true);
      setError(null);
      try {
        await fetchJson(
          `/api/evaluations/${view.datasetId}/annotations`,
          jsonPost({
            caseId: item.caseId,
            reviewer,
            status,
            expectedHeadEventId: own?.eventId ?? null,
            ...(own ? { supersedesEventId: own.eventId } : {}),
            notes,
            value,
            ...(settlesDisagreement ? { resolvesConflict: true } : {}),
          }),
        );
        await onSaved();
        if (status === "final") {
          const next = cases.findIndex(
            (candidate, index) =>
              index > position && !graded.has(candidate.caseId),
          );
          setChosen(next === -1 ? null : next);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [
      item,
      canSave,
      view.datasetId,
      reviewer,
      own,
      notes,
      value,
      settlesDisagreement,
      onSaved,
      cases,
      position,
      graded,
    ],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Cmd/Ctrl+Enter saves from anywhere, including the note field.
      if (event.metaKey || event.ctrlKey) {
        if (event.key === "Enter") void save("final");
        return;
      }
      if (event.altKey || isTypingTarget(event.target) || !item || !draft)
        return;
      if (event.key === "Enter") void save("final");
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      else {
        const next = draftAfterKey(item, draft, event.key);
        if (!next) return;
        setDraft(next);
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [item, draft, go, save]);

  async function reveal() {
    if (!item) return;
    try {
      setRevealed(
        await fetchJson<Revealed>(
          `/api/evaluations/${view.datasetId}/reveal`,
          jsonPost({ caseId: item.caseId, reviewer }),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const gradedHere = cases.filter((entry) => graded.has(entry.caseId)).length;
  const finished = cases.length > 0 && gradedHere === cases.length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl space-y-1">
          <Link
            className="text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)]"
            href={`/evaluations/${view.datasetId}`}
          >
            ← {view.name}
          </Link>
          <h2 className="font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
            {queue.title}
          </h2>
          <p className="text-sm leading-6 text-[var(--text-muted)]">
            {queue.purpose}
          </p>
        </div>
        <div className="w-full max-w-xs space-y-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold">
              {gradedHere} of {cases.length} graded
            </span>
            <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              Reviewer
              <Input
                aria-label="Reviewer"
                className="h-8 w-32 rounded-full px-3 text-xs"
                onChange={(event) => onReviewerChange(event.target.value)}
                placeholder="Your name"
                value={reviewer}
              />
            </label>
          </div>
          <div
            aria-hidden="true"
            className="h-2 overflow-hidden rounded-full bg-[var(--panel-muted)]"
          >
            <div
              className="h-full rounded-full bg-[var(--success)] transition-[width]"
              style={{
                width: `${String(cases.length ? (100 * gradedHere) / cases.length : 0)}%`,
              }}
            />
          </div>
        </div>
      </header>

      {finished ? (
        <p
          className="rounded-[18px] border border-[rgba(47,111,79,0.3)] bg-[rgba(47,111,79,0.08)] px-5 py-3 text-sm text-[var(--success)]"
          role="status"
        >
          <strong>All {cases.length} graded.</strong> Your answers are saved;
          you can still go back and change any of them.
        </p>
      ) : null}

      {item && draft ? (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
          <article className="space-y-6 rounded-[24px] border border-[var(--border)] bg-white p-6">
            <CaseBody draft={draft} item={item} onChange={setDraft} />
          </article>

          <aside className="space-y-4 rounded-[24px] border border-[var(--border-strong)] bg-white p-5 shadow-[0_12px_40px_rgba(30,30,40,0.06)] lg:sticky lg:top-4">
            <div className="flex items-center justify-between gap-2">
              <Button
                disabled={position === 0}
                onClick={() => go(-1)}
                size="sm"
                variant="ghost"
              >
                ← Back
              </Button>
              <span className="text-xs text-[var(--text-muted)]">
                Case {position + 1} of {cases.length}
                {own ? ` · ${own.status === "final" ? "graded" : "draft"}` : ""}
              </span>
              <Button
                disabled={position === cases.length - 1}
                onClick={() => go(1)}
                size="sm"
                variant="ghost"
              >
                Skip →
              </Button>
            </div>

            <CaseAnswer draft={draft} item={item} onChange={setDraft} />
            <p className="text-xs text-[var(--text-muted)]">
              Enter saves and moves on. The arrow keys step between cases.
            </p>

            <Textarea
              aria-label="Note"
              className="min-h-16"
              onChange={(event) => setNotes(event.target.value)}
              placeholder="A note on why, if it was close (optional)"
              value={notes}
            />
            {disputed ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  checked={settlesDisagreement}
                  className="size-4 accent-[var(--text)]"
                  onChange={(event) =>
                    setSettlesDisagreement(event.target.checked)
                  }
                  type="checkbox"
                />
                Reviewers disagree here. My answer settles it.
              </label>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={!canSave} onClick={() => void save("final")}>
                Save and next
                <kbd className="rounded border border-white/40 px-1 font-mono text-[10px]">
                  ⏎
                </kbd>
              </Button>
              <Button
                disabled={!canSave}
                onClick={() => void save("draft")}
                variant="ghost"
              >
                Save as draft
              </Button>
            </div>
            {reviewer.trim() === "" ? (
              <p className="text-xs text-[var(--warning)]">
                Enter your name above to save.
              </p>
            ) : null}
            {error ? (
              <p className="text-sm text-[var(--danger)]" role="alert">
                {error}
              </p>
            ) : null}

            <div className="border-t border-[var(--border)] pt-3">
              {revealed ? (
                <ModelAnswers revealed={revealed} />
              ) : (
                <button
                  className="text-left text-xs text-[var(--text-muted)] underline-offset-2 hover:underline"
                  disabled={reviewer.trim() === ""}
                  onClick={() => void reveal()}
                  type="button"
                >
                  Show what the models answered. Anything you save on this case
                  afterwards is marked as not blind.
                </button>
              )}
            </div>
          </aside>
        </div>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">
          There are no cases to grade here.
        </p>
      )}
    </div>
  );
}
