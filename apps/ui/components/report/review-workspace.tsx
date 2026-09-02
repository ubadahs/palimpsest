"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppendHumanReviewRequest,
  HumanReviewState,
  ReportInspectorRecordRow,
} from "palimpsest/contract";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { recordOutcomeLabel } from "@/lib/report-format";
import { cn } from "@/lib/utils";
import { VERDICT_ORDER } from "@/lib/verdict-tokens";

import { EvidencePassages, outcomeBadgeVariant } from "./record-details";
import {
  buildHumanAssessment,
  emptyReviewForm,
  HumanReviewForm,
  reviewFormFromAssessment,
  type ReviewFormState,
} from "./review-form";

type ReviewQueueFilter =
  | "all"
  | "unreviewed"
  | "draft"
  | "final"
  | "F"
  | "D"
  | "E"
  | "U"
  | "not_adjudicated";

function isMachineOutcomeFilter(filter: ReviewQueueFilter): boolean {
  return (
    filter === "F" ||
    filter === "D" ||
    filter === "E" ||
    filter === "U" ||
    filter === "not_adjudicated"
  );
}

export function ReviewWorkspace({
  runId,
  reportArtifactId,
  reportContentHash,
  records,
  selectedRecordId,
  onSelectRecord,
  onDirtyChange,
}: {
  runId: string;
  reportArtifactId: string;
  reportContentHash: string;
  records: ReportInspectorRecordRow[];
  selectedRecordId?: string;
  onSelectRecord: (recordId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [state, setState] = useState<HumanReviewState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [queueFilter, setQueueFilter] =
    useState<ReviewQueueFilter>("unreviewed");
  const [form, setForm] = useState<ReviewFormState>(emptyReviewForm());
  const [baseline, setBaseline] = useState<ReviewFormState>(emptyReviewForm());
  // Blinded by default: the 2026-07-21 review was done outside this tool
  // because the machine verdict was on screen before the human formed one.
  const [hideMachineJudgment, setHideMachineJudgment] = useState(true);
  // Records whose verdict has been revealed in this session. Re-hiding does
  // not un-see it, so blinding is sticky per record once broken.
  const [revealedRecordIds, setRevealedRecordIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const reviewerRef = useRef("");

  const reviewByRecord = useMemo(() => {
    const map = new Map(
      (state?.records ?? []).map((record) => [record.recordId, record]),
    );
    return map;
  }, [state]);

  const loadState = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/review`);
      const payload = (await response.json()) as HumanReviewState & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load review state");
      }
      setState(payload);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [runId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const queue = useMemo(() => {
    return records.filter((record) => {
      const review = reviewByRecord.get(record.recordId);
      if (queueFilter === "unreviewed") return review == null;
      if (queueFilter === "draft") return review?.status === "draft";
      if (queueFilter === "final") return review?.status === "final";
      if (queueFilter === "not_adjudicated") {
        return record.adjudicationStatus === "not_adjudicated";
      }
      if (
        queueFilter === "F" ||
        queueFilter === "D" ||
        queueFilter === "E" ||
        queueFilter === "U"
      ) {
        return record.verdict === queueFilter;
      }
      return true;
    });
  }, [queueFilter, records, reviewByRecord]);

  const activeRecordId =
    selectedRecordId &&
    queue.some((record) => record.recordId === selectedRecordId)
      ? selectedRecordId
      : (queue[0]?.recordId ?? selectedRecordId ?? records[0]?.recordId);

  const activeRecord =
    records.find((record) => record.recordId === activeRecordId) ?? null;
  const activeReview = activeRecord
    ? (reviewByRecord.get(activeRecord.recordId) ?? null)
    : null;

  const activeRecordKey = activeRecord?.recordId ?? "";
  const activeReviewEventId = activeReview?.eventId ?? "";
  // A saved review carries its own blinding; a fresh one is blinded while the
  // verdict is hidden and has never been revealed for this record.
  const blinded =
    (activeReview?.assessment.blinded ?? true) &&
    hideMachineJudgment &&
    !revealedRecordIds.has(activeRecordKey);

  useEffect(() => {
    if (activeRecordId && activeRecordId !== selectedRecordId) {
      onSelectRecord(activeRecordId);
    }
  }, [activeRecordId, onSelectRecord, selectedRecordId]);

  useEffect(() => {
    if (!activeRecordKey) return;
    const review = reviewByRecord.get(activeRecordKey) ?? null;
    const next = review
      ? reviewFormFromAssessment(review.assessment, review.reviewer)
      : emptyReviewForm(reviewerRef.current);
    reviewerRef.current = next.reviewer;
    setForm(next);
    setBaseline(next);
    setSaveError(null);
  }, [activeRecordKey, activeReviewEventId, reviewByRecord]);

  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const staleReport =
    state != null &&
    (state.staleReport ||
      state.lineage.reportArtifactId !== reportArtifactId ||
      state.lineage.reportContentHash !== reportContentHash);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const activeIndex = queue.findIndex(
    (record) => record.recordId === activeRecordId,
  );

  async function save(status: "draft" | "final") {
    if (!activeRecord || !state) return;
    setSaving(true);
    setSaveError(null);
    try {
      const assessment = buildHumanAssessment(form, blinded);
      const body: AppendHumanReviewRequest = {
        reportArtifactId,
        reportContentHash,
        expectedHeadEventId: state.headEventId,
        recordId: activeRecord.recordId,
        familyId: activeRecord.familyId,
        reviewer: form.reviewer.trim(),
        status,
        assessment,
        ...(activeReview ? { supersedesEventId: activeReview.eventId } : {}),
      };
      const response = await fetch(`/api/runs/${runId}/review/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        state?: HumanReviewState;
        error?: string;
        code?: string;
      };
      if (!response.ok || !payload.state) {
        throw new Error(payload.error ?? "Failed to save review");
      }
      setState(payload.state);
      const saved = payload.state.records.find(
        (record) => record.recordId === activeRecord.recordId,
      );
      if (saved) {
        const next = reviewFormFromAssessment(saved.assessment, saved.reviewer);
        reviewerRef.current = next.reviewer;
        setForm(next);
        setBaseline(next);
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      void loadState();
    } finally {
      setSaving(false);
    }
  }

  function goRelative(delta: number) {
    if (activeIndex < 0) return;
    const next = queue[activeIndex + delta];
    if (next && confirmDiscard()) onSelectRecord(next.recordId);
  }

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("Discard unsaved review changes?");
  }

  return (
    <div className="space-y-4">
      {staleReport ? (
        <Card className="border-[rgba(154,64,54,0.35)]">
          <CardContent className="py-4 text-sm text-[var(--danger)]">
            This page is showing a different Report artifact/hash than the
            current review lineage. Reload before reviewing; prior reviews
            remain bound to their original Report.
          </CardContent>
        </Card>
      ) : null}

      {loadError ? (
        <Card>
          <CardContent className="py-4 text-sm text-[var(--danger)]">
            {loadError}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--accent)]">
            Human review workspace
          </p>
          <p className="text-sm text-[var(--text-muted)]">
            {state
              ? `${String(state.progress.final)} final · ${String(state.progress.draft)} draft · ${String(state.progress.unreviewed)} unreviewed of ${String(state.progress.totalRecords)}`
              : "Loading review progress…"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            aria-disabled={staleReport}
            className={cn(
              "rounded-full border border-[var(--border)] bg-white/70 px-4 py-2 text-xs font-semibold text-[var(--accent)] hover:bg-white",
              staleReport && "pointer-events-none opacity-50",
            )}
            href={`/api/runs/${runId}/review/export?format=json`}
          >
            Export JSON
          </a>
          <a
            aria-disabled={staleReport}
            className={cn(
              "rounded-full border border-[var(--border)] bg-white/70 px-4 py-2 text-xs font-semibold text-[var(--accent)] hover:bg-white",
              staleReport && "pointer-events-none opacity-50",
            )}
            href={`/api/runs/${runId}/review/export?format=csv`}
          >
            Export CSV
          </a>
        </div>
      </div>

      <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
        {(
          [
            "unreviewed",
            "draft",
            "final",
            "all",
            ...(hideMachineJudgment
              ? []
              : [...VERDICT_ORDER, "not_adjudicated"]),
          ] as ReviewQueueFilter[]
        ).map((id) => (
          <button
            aria-pressed={queueFilter === id}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition",
              queueFilter === id
                ? "border-[var(--border-strong)] bg-[var(--text)] text-white"
                : "border-[var(--border)] bg-white/60 text-[var(--text-muted)] hover:bg-white/80",
            )}
            key={id}
            onClick={() => {
              if (confirmDiscard()) setQueueFilter(id);
            }}
            type="button"
          >
            {id === "not_adjudicated" ? "Gated" : id}
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
        <div className="space-y-2 xl:max-h-[75vh] xl:overflow-y-auto">
          {queue.map((record) => {
            const review = reviewByRecord.get(record.recordId);
            const selected = record.recordId === activeRecordId;
            return (
              <button
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "w-full rounded-[20px] border px-4 py-3 text-left transition",
                  selected
                    ? "border-[var(--border-strong)] bg-white"
                    : "border-[var(--border)] bg-white/50 hover:bg-white/80",
                )}
                key={record.recordId}
                onClick={() => {
                  if (confirmDiscard()) onSelectRecord(record.recordId);
                }}
                type="button"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {!hideMachineJudgment ? (
                    <Badge variant={outcomeBadgeVariant(record)}>
                      {recordOutcomeLabel(record)}
                    </Badge>
                  ) : null}
                  <Badge variant={review ? "running" : "neutral"}>
                    {review?.status ?? "unreviewed"}
                  </Badge>
                </div>
                <p className="mt-2 text-sm font-semibold leading-6 text-[var(--text)]">
                  {record.evaluatedClaimText}
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {record.citingPaperTitle}
                </p>
              </button>
            );
          })}
          {queue.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-sm text-[var(--text-muted)]">
                No records in this queue filter.
              </CardContent>
            </Card>
          ) : null}
        </div>

        {activeRecord ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                <Button
                  disabled={activeIndex <= 0}
                  onClick={() => goRelative(-1)}
                  type="button"
                  variant="secondary"
                >
                  Previous
                </Button>
                <Button
                  disabled={activeIndex < 0 || activeIndex >= queue.length - 1}
                  onClick={() => goRelative(1)}
                  type="button"
                  variant="secondary"
                >
                  Next
                </Button>
              </div>
              {activeReview ? (
                <p className="text-xs text-[var(--text-muted)]">
                  Revision {String(activeReview.revisionCount)} ·{" "}
                  {activeReview.status}
                </p>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">Unreviewed</p>
              )}
            </div>

            <Card>
              <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {!hideMachineJudgment ? (
                    <Badge variant={outcomeBadgeVariant(activeRecord)}>
                      {recordOutcomeLabel(activeRecord)}
                    </Badge>
                  ) : null}
                  <label className="inline-flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <input
                      checked={hideMachineJudgment}
                      onChange={(event) => {
                        const hidden = event.target.checked;
                        setHideMachineJudgment(hidden);
                        if (!hidden && activeRecordKey) {
                          setRevealedRecordIds(
                            (current) => new Set([...current, activeRecordKey]),
                          );
                        }
                        if (hidden && isMachineOutcomeFilter(queueFilter)) {
                          setQueueFilter("all");
                        }
                      }}
                      type="checkbox"
                    />
                    Hide machine judgment
                  </label>
                  <Badge variant={blinded ? "running" : "neutral"}>
                    {blinded ? "blinded" : "not blinded"}
                  </Badge>
                </div>
                <h3 className="font-[var(--font-instrument)] text-2xl tracking-[-0.03em]">
                  {activeRecord.evaluatedClaimText}
                </h3>
                <p className="text-sm text-[var(--text-muted)]">
                  {activeRecord.citingPaperTitle}
                  {activeRecord.citingPaperYear != null
                    ? ` (${String(activeRecord.citingPaperYear)})`
                    : ""}
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <blockquote className="rounded-[18px] border border-[var(--border)] bg-[var(--panel-muted)] px-4 py-3 text-sm leading-7">
                  {activeRecord.citationContext}
                </blockquote>
                <EvidencePassages record={activeRecord} />
                {!hideMachineJudgment ? (
                  <div className="rounded-[18px] border border-dashed border-[var(--border)] px-4 py-3 text-sm leading-7 text-[var(--text-muted)]">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em]">
                      Machine judgment (read-only)
                    </p>
                    <p className="mt-2">
                      {activeRecord.verdict
                        ? `Verdict ${activeRecord.verdict}`
                        : recordOutcomeLabel(activeRecord)}
                      {activeRecord.evidenceSufficiency
                        ? ` · evidence ${activeRecord.evidenceSufficiency}`
                        : ""}
                    </p>
                    {activeRecord.rationale ? (
                      <p className="mt-2">{activeRecord.rationale}</p>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <HumanReviewForm
              activeRecord={activeRecord}
              dirty={dirty}
              form={form}
              onReviewerChange={(reviewer) => {
                reviewerRef.current = reviewer;
                setForm((current) => ({ ...current, reviewer }));
              }}
              onSave={(status) => void save(status)}
              saveError={saveError}
              saving={saving || state == null}
              setForm={setForm}
              staleReport={staleReport}
            />
          </div>
        ) : (
          <Card>
            <CardContent className="p-6 text-sm text-[var(--text-muted)]">
              Select a record to review.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
