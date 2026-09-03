"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AppendHumanReviewRequest,
  HumanReviewState,
  ReportInspectorRecordRow,
} from "palimpsest/contract";
import { buildClaimUnitKey } from "palimpsest/contract";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recordOutcomeLabel } from "@/lib/report-format";
import { cn } from "@/lib/utils";
import { VERDICT_ORDER } from "@/lib/verdict-tokens";

import { EvidencePassages, outcomeBadgeVariant } from "./record-details";
import {
  buildHumanAssessment,
  emptyReviewForm,
  HumanReviewForm,
  MUTATION_KIND_LABELS,
  reviewFormFromAssessment,
  VERDICT_CHOICES,
  type ReviewFormState,
} from "./review-form";

type ReviewQueueFilter =
  | "calibration"
  | "all"
  | "unreviewed"
  | "draft"
  | "final"
  | "F"
  | "D"
  | "E"
  | "U"
  | "not_adjudicated";

const QUEUE_FILTER_LABELS: Record<ReviewQueueFilter, string> = {
  calibration: "Calibration set",
  unreviewed: "To review",
  draft: "Drafts",
  final: "Done",
  all: "All",
  F: "Model: F",
  D: "Model: D",
  E: "Model: E",
  U: "Model: U",
  not_adjudicated: "Model: gated",
};

const REVIEWER_STORAGE_KEY = "palimpsest.reviewer";

/** How many machine-F records the calibration set samples across families. */
const CALIBRATION_F_SAMPLE = 20;

/** FNV-1a: a stable, dependency-free order that is not the record order. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The Report's unit rule: one seed finding, one citing paper, one claim set. */
function unitKeyOf(record: ReportInspectorRecordRow): string {
  return buildClaimUnitKey({
    familyId: record.familyId,
    citingPaperId: record.citingPaperId,
    claimTexts: record.occurrenceClaims.map(
      (claim) => claim.extractedClaimText,
    ),
  });
}

type CalibrationSet = {
  /** One record to show per unit in the set. */
  representatives: Map<string, ReportInspectorRecordRow>;
  /** Units with at least one saved review. */
  reviewedUnits: Set<string>;
};

/**
 * The enriched labelling sample, counted in claim units rather than records:
 * a citer that mentions the seed twice in one paragraph yields two records for
 * one restatement, and a reviewer should judge it once. A unit is in the set
 * when the model called any of its records something other than F, when it
 * belongs to a fixed sample of F units spread across families (drawn from
 * all F units, so it does not refill as work is saved), or when it already
 * carries a review. Membership uses the machine verdict, which this
 * component already holds; the order is by hash so nothing gives itself away.
 * About four in ten units are non-F, against two in ten overall, and that
 * enrichment is recorded in the evaluation notes.
 */
function buildCalibrationSet(
  records: ReportInspectorRecordRow[],
  reviewedRecordIds: ReadonlySet<string>,
): CalibrationSet {
  const units = new Map<string, ReportInspectorRecordRow[]>();
  for (const record of records) {
    const key = unitKeyOf(record);
    units.set(key, [...(units.get(key) ?? []), record]);
  }
  const byHash = (left: { recordId: string }, right: { recordId: string }) =>
    hashString(left.recordId) - hashString(right.recordId);
  const representatives = new Map<string, ReportInspectorRecordRow>();
  const reviewedUnits = new Set<string>();
  const fUnitsByFamily = new Map<string, string[]>();

  // Classify every unit first. The F sample below is drawn from all F units,
  // reviewed or not, so the set is fixed for the run and shrinks as work is
  // saved instead of refilling itself with fresh F records.
  for (const [key, members] of units) {
    const reviewed = members.find((record) =>
      reviewedRecordIds.has(record.recordId),
    );
    if (reviewed) reviewedUnits.add(key);
    const representative = reviewed ?? [...members].sort(byHash)[0]!;
    const adjudicated = members.filter(
      (record) => record.adjudicationStatus === "adjudicated",
    );
    if (adjudicated.some((record) => record.verdict !== "F")) {
      representatives.set(key, representative);
    } else if (adjudicated.length > 0) {
      const familyId = representative.familyId;
      fUnitsByFamily.set(familyId, [
        ...(fUnitsByFamily.get(familyId) ?? []),
        key,
      ]);
    } else if (reviewed) {
      representatives.set(key, representative);
    }
  }
  // Round-robin over families in hash order, one F unit per family per pass.
  const families = [...fUnitsByFamily.entries()]
    .map(([familyId, keys]) => ({
      familyId,
      keys: keys.sort((left, right) => hashString(left) - hashString(right)),
    }))
    .sort(
      (left, right) => hashString(left.familyId) - hashString(right.familyId),
    );
  let sampled = 0;
  for (let pass = 0; sampled < CALIBRATION_F_SAMPLE; pass++) {
    let added = false;
    for (const family of families) {
      const key = family.keys[pass];
      if (!key || sampled >= CALIBRATION_F_SAMPLE) continue;
      const members = units.get(key)!;
      representatives.set(
        key,
        members.find((record) => reviewedRecordIds.has(record.recordId)) ??
          [...members].sort(byHash)[0]!,
      );
      sampled += 1;
      added = true;
    }
    if (!added) break;
  }
  // Work done outside the sample still counts and stays visible under Done.
  for (const [key, members] of units) {
    if (reviewedUnits.has(key) && !representatives.has(key)) {
      representatives.set(
        key,
        members.find((record) => reviewedRecordIds.has(record.recordId))!,
      );
    }
  }
  return { representatives, reviewedUnits };
}

function isMachineOutcomeFilter(filter: ReviewQueueFilter): boolean {
  return (
    filter === "F" ||
    filter === "D" ||
    filter === "E" ||
    filter === "U" ||
    filter === "not_adjudicated"
  );
}

/**
 * The citing passage with the sentences attributed to the cited paper marked.
 * Spans come from the verified support spans; when none exist the evaluated
 * claim text is located by search so the reviewer still sees what to judge.
 */
function highlightedContext(record: ReportInspectorRecordRow): ReactNode {
  const context = record.citationContext;
  const spans = record.occurrenceClaims
    .flatMap((claim) => (claim.supportSpan ? [claim.supportSpan] : []))
    .filter(
      (span) =>
        span.charOffsetStart >= 0 &&
        span.charOffsetEnd <= context.length &&
        span.charOffsetStart < span.charOffsetEnd,
    )
    .sort((left, right) => left.charOffsetStart - right.charOffsetStart);
  if (spans.length === 0) {
    const index = context.indexOf(record.evaluatedClaimText);
    if (index >= 0) {
      spans.push({
        text: record.evaluatedClaimText,
        charOffsetStart: index,
        charOffsetEnd: index + record.evaluatedClaimText.length,
      });
    }
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.charOffsetStart < cursor) continue;
    if (span.charOffsetStart > cursor) {
      parts.push(context.slice(cursor, span.charOffsetStart));
    }
    parts.push(
      <mark
        className="rounded-[4px] bg-[rgba(224,176,72,0.35)] px-0.5 text-[var(--text)]"
        key={span.charOffsetStart}
      >
        {context.slice(span.charOffsetStart, span.charOffsetEnd)}
      </mark>,
    );
    cursor = span.charOffsetEnd;
  }
  if (cursor < context.length) parts.push(context.slice(cursor));
  return parts;
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
    useState<ReviewQueueFilter>("calibration");
  const [form, setForm] = useState<ReviewFormState>(emptyReviewForm());
  const [baseline, setBaseline] = useState<ReviewFormState>(emptyReviewForm());
  // Blinded by default: the 2026-07-21 review was done outside this tool
  // because the machine verdict was on screen before the human formed one.
  const [showMachineJudgment, setShowMachineJudgment] = useState(false);
  // Records whose verdict has been revealed in this session. Re-hiding does
  // not un-see it, so blinding is sticky per record once broken.
  const [revealedRecordIds, setRevealedRecordIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const reviewerRef = useRef("");

  // The reviewer's name is asked once and remembered on this machine.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(REVIEWER_STORAGE_KEY);
      if (stored && reviewerRef.current === "") {
        reviewerRef.current = stored;
        setForm((current) => ({ ...current, reviewer: stored }));
        setBaseline((current) => ({ ...current, reviewer: stored }));
      }
    } catch {
      // Storage may be unavailable; the field still works for the session.
    }
  }, []);

  function setReviewer(reviewer: string) {
    reviewerRef.current = reviewer;
    setForm((current) => ({ ...current, reviewer }));
    setBaseline((current) => ({ ...current, reviewer }));
    try {
      window.localStorage.setItem(REVIEWER_STORAGE_KEY, reviewer);
    } catch {
      // Ignore storage failures.
    }
  }

  const reviewByRecord = useMemo(() => {
    return new Map(
      (state?.records ?? []).map((record) => [record.recordId, record]),
    );
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

  const calibrationSet = useMemo(
    () => buildCalibrationSet(records, new Set(reviewByRecord.keys())),
    [records, reviewByRecord],
  );

  const queue = useMemo(() => {
    if (queueFilter === "calibration") {
      return [...calibrationSet.representatives.entries()]
        .filter(([key]) => !calibrationSet.reviewedUnits.has(key))
        .map(([, record]) => record)
        .sort(
          (left, right) =>
            hashString(left.recordId) - hashString(right.recordId),
        );
    }
    if (queueFilter === "unreviewed") {
      // One entry per claim unit: a paragraph that cites the paper twice for
      // the same claim is judged once, and a unit with any label is done.
      const seen = new Set<string>();
      return records.filter((record) => {
        const key = unitKeyOf(record);
        if (seen.has(key)) return false;
        seen.add(key);
        return !records.some(
          (sibling) =>
            unitKeyOf(sibling) === key && reviewByRecord.has(sibling.recordId),
        );
      });
    }
    return records.filter((record) => {
      const review = reviewByRecord.get(record.recordId);
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
  }, [calibrationSet, queueFilter, records, reviewByRecord]);

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
    !showMachineJudgment &&
    !revealedRecordIds.has(activeRecordKey);

  // Any record shown while the machine judgment is visible counts as revealed,
  // not only the one active when the checkbox was toggled.
  useEffect(() => {
    if (showMachineJudgment && activeRecordKey) {
      setRevealedRecordIds((current) =>
        current.has(activeRecordKey)
          ? current
          : new Set([...current, activeRecordKey]),
      );
    }
  }, [showMachineJudgment, activeRecordKey]);

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

  const save = useCallback(
    async (status: "draft" | "final") => {
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
          const next = reviewFormFromAssessment(
            saved.assessment,
            saved.reviewer,
          );
          reviewerRef.current = next.reviewer;
          setForm(next);
          setBaseline(next);
        }
        // A final save moves on. In the working queues the record drops out
        // on its own; elsewhere step to the next one explicitly.
        if (
          status === "final" &&
          queueFilter !== "unreviewed" &&
          queueFilter !== "calibration"
        ) {
          const next = queue[activeIndex + 1];
          if (next) onSelectRecord(next.recordId);
        }
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
        void loadState();
      } finally {
        setSaving(false);
      }
    },
    [
      activeIndex,
      activeRecord,
      activeReview,
      blinded,
      form,
      loadState,
      onSelectRecord,
      queue,
      queueFilter,
      reportArtifactId,
      reportContentHash,
      runId,
      state,
    ],
  );

  const onSave = useCallback(
    (status: "draft" | "final") => {
      void save(status);
    },
    [save],
  );

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("Discard unsaved review changes?");
  }

  function goRelative(delta: number) {
    if (activeIndex < 0) return;
    const next = queue[activeIndex + delta];
    if (next && confirmDiscard()) onSelectRecord(next.recordId);
  }

  const reviewed = state ? state.progress.final + state.progress.draft : 0;
  const total = state?.progress.totalRecords ?? records.length;
  const calibrationTotal = calibrationSet.representatives.size;
  const calibrationReviewed = calibrationSet.reviewedUnits.size;
  const activeUnitSize = activeRecord
    ? records.filter((record) => unitKeyOf(record) === unitKeyOf(activeRecord))
        .length
    : 1;
  const machineChoice = activeRecord?.verdict
    ? VERDICT_CHOICES.find((choice) => choice.value === activeRecord.verdict)
    : undefined;

  return (
    <div className="space-y-5">
      {staleReport ? (
        <Card className="border-[rgba(154,64,54,0.35)]">
          <CardContent className="py-4 text-sm text-[var(--danger)]">
            This page is showing a different Report than the one these reviews
            are bound to. Reload before reviewing; earlier reviews stay with
            their original Report.
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

      <header className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--accent)]">
            Review
          </p>
          <h2 className="font-[var(--font-instrument)] text-3xl tracking-[-0.03em] text-[var(--text)]">
            Does the citing paper say what the cited paper found?
          </h2>
          <p className="max-w-[65ch] text-sm leading-6 text-[var(--text-muted)]">
            One record is one sentence that cites the paper. Read the
            highlighted sentence, read what the cited paper says, and pick the
            closest verdict. The model's own verdict stays hidden so your label
            is independent of it.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <div className="flex items-center gap-2">
            <Label className="text-xs" htmlFor="reviewer">
              Reviewer
            </Label>
            <Input
              className="h-8 w-40 text-sm"
              id="reviewer"
              onChange={(event) => setReviewer(event.target.value)}
              placeholder="Your name"
              value={form.reviewer}
            />
          </div>
          <div className="flex gap-3 text-xs">
            <a
              aria-disabled={staleReport}
              className={cn(
                "text-[var(--accent)] underline-offset-4 hover:underline",
                staleReport && "pointer-events-none opacity-50",
              )}
              href={`/api/runs/${runId}/review/export?format=csv`}
            >
              Export CSV
            </a>
            <a
              aria-disabled={staleReport}
              className={cn(
                "text-[var(--accent)] underline-offset-4 hover:underline",
                staleReport && "pointer-events-none opacity-50",
              )}
              href={`/api/runs/${runId}/review/export?format=json`}
            >
              Export JSON
            </a>
          </div>
        </div>
      </header>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-semibold text-[var(--text)]">
            {state
              ? `${String(reviewed)} of ${String(total)} reviewed`
              : "Loading…"}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            {state
              ? `${String(calibrationReviewed)} of ${String(calibrationTotal)} claims in the calibration set`
              : ""}
            {state && state.progress.draft > 0
              ? ` · ${String(state.progress.draft)} draft`
              : ""}
          </span>
        </div>
        <div
          aria-hidden="true"
          className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
        >
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width]"
            style={{
              width:
                calibrationTotal > 0
                  ? `${String((calibrationReviewed / calibrationTotal) * 100)}%`
                  : "0%",
            }}
          />
        </div>
      </div>

      <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
        {(
          [
            "calibration",
            "unreviewed",
            "draft",
            "final",
            "all",
            ...(showMachineJudgment
              ? [...VERDICT_ORDER, "not_adjudicated"]
              : []),
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
            {QUEUE_FILTER_LABELS[id]}
          </button>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
        <aside className="space-y-1.5 xl:max-h-[80vh] xl:overflow-y-auto">
          {queue.map((record, index) => {
            const review = reviewByRecord.get(record.recordId);
            const selected = record.recordId === activeRecordId;
            return (
              <button
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "w-full rounded-[16px] border px-3 py-2.5 text-left transition",
                  selected
                    ? "border-[var(--border-strong)] bg-white"
                    : "border-transparent bg-white/40 hover:bg-white/80",
                )}
                key={record.recordId}
                onClick={() => {
                  if (confirmDiscard()) onSelectRecord(record.recordId);
                }}
                type="button"
              >
                <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  <span className="font-mono tabular-nums">
                    {String(index + 1)}
                  </span>
                  {review ? (
                    <Badge
                      variant={
                        review.status === "final" ? "success" : "running"
                      }
                    >
                      {review.status === "final" ? "done" : "draft"}
                    </Badge>
                  ) : null}
                  {showMachineJudgment ? (
                    <Badge variant={outcomeBadgeVariant(record)}>
                      {recordOutcomeLabel(record)}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 line-clamp-2 text-sm leading-5 text-[var(--text)]">
                  {record.evaluatedClaimText}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                  {record.citingPaperTitle}
                </p>
              </button>
            );
          })}
          {queue.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-sm text-[var(--text-muted)]">
                {queueFilter === "calibration"
                  ? "The calibration set is done. Thank you."
                  : queueFilter === "unreviewed"
                    ? "Nothing left to review here."
                    : "No records in this list."}
              </CardContent>
            </Card>
          ) : null}
        </aside>

        {activeRecord ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-[var(--text-muted)]">
                Record{" "}
                <span className="font-semibold text-[var(--text)] tabular-nums">
                  {String(activeIndex + 1)}
                </span>{" "}
                of {String(queue.length)}
                {activeReview
                  ? ` · ${activeReview.status === "final" ? "reviewed" : "draft"}`
                  : ""}
              </p>
              <div className="flex gap-2">
                <Button
                  disabled={activeIndex <= 0}
                  onClick={() => goRelative(-1)}
                  type="button"
                  variant="secondary"
                >
                  ← Previous
                </Button>
                <Button
                  disabled={activeIndex < 0 || activeIndex >= queue.length - 1}
                  onClick={() => goRelative(1)}
                  type="button"
                  variant="secondary"
                >
                  Skip →
                </Button>
              </div>
            </div>

            <section className="rounded-[24px] border border-[var(--border)] bg-white/70 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                What the citing paper says
              </p>
              <p className="mt-1 text-sm text-[var(--text)]">
                <span className="font-semibold">
                  {activeRecord.citingPaperTitle}
                </span>
                {activeRecord.citingPaperYear != null
                  ? ` (${String(activeRecord.citingPaperYear)})`
                  : ""}
                {activeRecord.sectionTitle ? (
                  <span className="text-[var(--text-muted)]">
                    {" "}
                    · {activeRecord.sectionTitle}
                  </span>
                ) : null}
              </p>
              <p className="mt-3 rounded-[14px] bg-[var(--panel-muted)] px-4 py-2 text-sm leading-6 text-[var(--text)]">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Claim being judged
                </span>
                <br />
                {activeRecord.evaluatedClaimText}
              </p>
              <blockquote className="mt-3 max-w-[72ch] text-[15px] leading-8 text-[var(--text)]">
                {highlightedContext(activeRecord)}
              </blockquote>
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                Highlighted: the part attributed to the cited paper. Judge the
                claim above against it; the rest of the passage is context.
                {activeUnitSize > 1
                  ? ` This paragraph cites the paper ${String(activeUnitSize)} times for the same claim; one label covers all of them.`
                  : ""}
              </p>
            </section>

            <section className="rounded-[24px] border border-[var(--border)] bg-white/70 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                What the cited paper says
              </p>
              <p className="mt-1 text-sm font-semibold text-[var(--text)]">
                {activeRecord.seedTitle}
              </p>
              {activeRecord.evidencePassages.length > 0 ? (
                <div className="mt-3">
                  <EvidencePassages
                    heading="Passages the model was shown"
                    hideMachineJudgment={!showMachineJudgment}
                    record={activeRecord}
                  />
                </div>
              ) : (
                <p className="mt-3 text-sm text-[var(--text-muted)]">
                  No passages were retrieved for this record. Judge from your
                  knowledge of the paper and flag "weren't enough to judge"
                  below.
                </p>
              )}
            </section>

            <HumanReviewForm
              activeRecord={activeRecord}
              dirty={dirty}
              form={form}
              onSave={onSave}
              saveError={saveError}
              savedStatus={activeReview?.status ?? null}
              saving={saving || state == null}
              setForm={setForm}
              staleReport={staleReport}
            />

            <div className="rounded-[18px] border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--text-muted)]">
              <label className="inline-flex cursor-pointer items-center gap-2">
                <input
                  checked={showMachineJudgment}
                  className="size-4 accent-[var(--accent)]"
                  onChange={(event) => {
                    const shown = event.target.checked;
                    setShowMachineJudgment(shown);
                    if (shown && activeRecordKey) {
                      setRevealedRecordIds(
                        (current) => new Set([...current, activeRecordKey]),
                      );
                    }
                    if (!shown && isMachineOutcomeFilter(queueFilter)) {
                      setQueueFilter("all");
                    }
                  }}
                  type="checkbox"
                />
                Show the model's verdict
                <span className="text-xs">
                  (marks this record as not blinded)
                </span>
                <Badge variant={blinded ? "running" : "neutral"}>
                  {blinded ? "blinded" : "not blinded"}
                </Badge>
              </label>
              {showMachineJudgment ? (
                <div className="mt-3 space-y-2 leading-6">
                  <p className="text-[var(--text)]">
                    <span className="font-semibold">
                      {machineChoice
                        ? `${machineChoice.code} · ${machineChoice.name}`
                        : recordOutcomeLabel(activeRecord)}
                    </span>
                    {activeRecord.mutationKinds &&
                    activeRecord.mutationKinds.length > 0
                      ? ` · ${activeRecord.mutationKinds
                          .map(
                            (kind) =>
                              MUTATION_KIND_LABELS[
                                kind as keyof typeof MUTATION_KIND_LABELS
                              ]?.name ?? kind,
                          )
                          .join(", ")}`
                      : ""}
                  </p>
                  {activeRecord.citingAssertion ? (
                    <p>
                      <span className="font-semibold text-[var(--text)]">
                        Citing paper says:
                      </span>{" "}
                      {activeRecord.citingAssertion}
                    </p>
                  ) : null}
                  {activeRecord.sourceStatement ? (
                    <p>
                      <span className="font-semibold text-[var(--text)]">
                        Cited paper says:
                      </span>{" "}
                      {activeRecord.sourceStatement}
                    </p>
                  ) : null}
                  {activeRecord.rationale ? (
                    <p>{activeRecord.rationale}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
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
