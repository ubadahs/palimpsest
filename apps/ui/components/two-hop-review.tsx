"use client";

import { useEffect, useRef, useState } from "react";

import { chainAssessments } from "@/lib/two-hop-review-types";
import type {
  TwoHopAnswer,
  ChainAssessment,
  TwoHopCase,
  TwoHopEvidence,
  TwoHopReviewData,
  TwoHopSource,
} from "@/lib/two-hop-review-types";

import { originalCitationAtPassage } from "@/lib/two-hop-citation";

const answerLabels: Record<ChainAssessment, string> = {
  faithful: "Yes, with the same meaning",
  changed: "Yes, but the meaning changes",
  no_chain: "No, the later passage uses a different claim",
  uncertain: "I can’t tell from the evidence",
};

const buttonClass =
  "rounded-full border border-[var(--border-strong)] px-4 py-2 text-sm font-semibold enabled:cursor-pointer enabled:hover:bg-[var(--panel-muted)] disabled:opacity-40";
const secondaryText = "text-sm leading-relaxed text-[var(--text-muted)]";
const panelClass = "surface rounded-2xl p-5 md:p-6";
function MarkedText({ text, focus }: { text: string; focus?: string }) {
  const plain = text.replace(/[【】]/g, "");
  const start = focus ? plain.indexOf(focus) : -1;
  const end = start + (focus?.length ?? 0);
  let offset = 0;
  return text.split(/(【[^】]*】)/g).map((part, index) => {
    const marked = part.startsWith("【") && part.endsWith("】");
    const value = marked ? part.slice(1, -1) : part;
    const from = Math.max(0, start - offset);
    const to = Math.min(value.length, end - offset);
    offset += value.length;
    const content =
      start >= 0 && from < to ? (
        <>
          {value.slice(0, from)}
          <strong>{value.slice(from, to)}</strong>
          {value.slice(to)}
        </>
      ) : (
        value
      );
    return marked ? (
      <mark
        className="rounded bg-[var(--accent-soft)] px-0.5 font-bold text-[var(--accent)]"
        key={index}
      >
        {content}
      </mark>
    ) : (
      <span key={index}>{content}</span>
    );
  });
}

function markSupportSpan(item: TwoHopEvidence): string {
  const { supportSpan, paragraphWithTargetMarker, markerInsideSpan } = item;
  if (!markerInsideSpan) return supportSpan;

  const match = /【([^】]+)】/.exec(paragraphWithTargetMarker);
  if (!match || !match[1]) return supportSpan;

  const paragraph = paragraphWithTargetMarker.replace(match[0], match[1]);
  const spanStart = paragraph.indexOf(supportSpan);
  if (spanStart < 0 || paragraph.lastIndexOf(supportSpan) !== spanStart)
    return supportSpan;

  const markerStart = match.index - spanStart;
  const markerEnd = markerStart + match[1].length;
  if (markerStart < 0 || markerEnd > supportSpan.length) return supportSpan;

  return `${supportSpan.slice(0, markerStart)}${match[0]}${supportSpan.slice(markerEnd)}`;
}

function SourceText({
  source,
  inPacketFullText,
}: {
  source: TwoHopSource;
  inPacketFullText: boolean;
}) {
  const [query, setQuery] = useState("");
  const textRegion = useRef<HTMLDivElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const matches = search
    ? source.text
        .split(/\n\s*\n/)
        .filter((block) => block.toLocaleLowerCase().includes(search))
    : undefined;

  return (
    <details className="rounded-xl border border-[var(--border)] bg-white/40">
      <summary className="cursor-pointer p-4 text-sm font-semibold">
        {inPacketFullText ? "Read full text" : "Read source notes"}
      </summary>
      <div className="border-t border-[var(--border)] p-4">
        {inPacketFullText ? (
          <>
            <label className="block text-sm font-semibold">
              Find in paper
              <input
                className="mt-1 block w-full rounded-lg border border-[var(--border-strong)] bg-white/50 p-2 font-normal"
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  if (textRegion.current) textRegion.current.scrollTop = 0;
                }}
                placeholder="Search a phrase, section or block ID"
                type="search"
                value={query}
              />
            </label>
            {matches ? (
              <p className={`mt-2 ${secondaryText}`} role="status">
                {matches.length} matching{" "}
                {matches.length === 1 ? "block" : "blocks"}
              </p>
            ) : null}
          </>
        ) : null}
        <div
          aria-label={source.title}
          className="mt-3 max-h-[32rem] overflow-y-auto whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed"
          ref={textRegion}
          role="region"
          tabIndex={0}
        >
          {matches ? matches.join("\n\n") : <MarkedText text={source.text} />}
        </div>
      </div>
    </details>
  );
}

function PaperLink({ url, children }: { url: string; children: string }) {
  return (
    <a
      className="underline underline-offset-2"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

function VersionLinks({
  version,
  url,
  publicationUrl,
}: {
  version: string;
  url: string;
  publicationUrl?: string | undefined;
}) {
  return (
    <p className={secondaryText}>
      {version} · <PaperLink url={url}>Paper used</PaperLink>
      {publicationUrl && publicationUrl !== url ? (
        <>
          {" "}
          · <PaperLink url={publicationUrl}>Journal publication</PaperLink>
        </>
      ) : null}
    </p>
  );
}

function PaperTrail({
  reviewCase,
  data,
}: {
  reviewCase: TwoHopCase;
  data: TwoHopReviewData;
}) {
  const original = data.sources[reviewCase.originalSource];
  const intermediate = data.sources[reviewCase.immediateSource];
  const papers = [
    {
      role: "Original",
      label:
        original?.citationLabel || original?.title || reviewCase.originalSource,
      id: "original-evidence",
    },
    {
      role: "Middle paper",
      label:
        intermediate?.citationLabel ||
        intermediate?.title ||
        reviewCase.immediateSource,
      id: "intermediate-evidence",
    },
    {
      role: "Later paper",
      label: reviewCase.citingLabel || reviewCase.citingTitle,
      id: "descendant-evidence",
    },
  ];

  return (
    <nav aria-label="Paper trail" className="mt-2">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-[var(--text-muted)]">
        {papers.map(({ role, label, id }, index) => (
          <li className="flex min-w-0 items-baseline gap-2" key={id}>
            {index > 0 ? <span aria-hidden>→</span> : null}
            <a
              aria-label={`${role} evidence for ${label}`}
              onClick={() => {
                const section = document.getElementById(id);
                if (section instanceof HTMLDetailsElement) section.open = true;
              }}
              className="wrap-anywhere text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
              href={`#${id}`}
            >
              {label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function propositionExcerpt(proposition: string) {
  const limit = 68;
  if (proposition.length <= limit) return proposition;
  const lastSpace = proposition.lastIndexOf(" ", limit);
  return `${proposition.slice(0, lastSpace > 0 ? lastSpace : limit)}…`;
}

function SourceComparison({
  reviewCase,
  data,
}: {
  reviewCase: TwoHopCase;
  data: TwoHopReviewData;
}) {
  const original = data.sources[reviewCase.originalSource]!;
  const intermediate = data.sources[reviewCase.immediateSource]!;
  const originalLabel = original.citationLabel ?? original.title;
  const middleLabel = intermediate.citationLabel ?? intermediate.title;
  const laterLabel = reviewCase.citingLabel ?? reviewCase.citingTitle;
  const relays = data.relays.filter(
    (r) =>
      r.intermediate === reviewCase.immediateSource &&
      r.original === reviewCase.originalSource,
  );
  const excerpts = new Map<string, typeof relays>();
  for (const r of relays) {
    const locations = excerpts.get(r.excerpt);
    if (locations) locations.push(r);
    else excerpts.set(r.excerpt, [r]);
  }
  const quoteClass =
    "border-l-2 border-[var(--accent)] pl-3 text-sm leading-relaxed";

  return (
    <>
      <details className={panelClass} id="original-evidence">
        <summary className="cursor-pointer font-semibold">
          Original findings · {originalLabel}
        </summary>
        <Findings source={original} />
        <p className="mt-3 font-semibold">{original.title}</p>
        <VersionLinks
          version={original.version}
          url={original.url}
          publicationUrl={original.publicationUrl}
        />
        <SourceText
          source={original}
          inPacketFullText={original.textKind === "full_text"}
        />
      </details>

      <div className="grid items-start gap-4 md:grid-cols-2">
        <section className={panelClass} id="intermediate-evidence">
          <h2 className="text-lg font-bold">
            Where {middleLabel} cites {originalLabel}
          </h2>
          <p className={secondaryText}>
            {intermediate.textKind === "excerpts"
              ? "The source note gives context around the quoted words."
              : "A highlighted reference can share a citation group with other sources."}
          </p>
          {excerpts.size === 0 && (
            <p className={secondaryText}>
              No marked passage is available for this pair.
            </p>
          )}
          {Array.from(excerpts, ([excerpt, locations]) => (
            <div className="mt-4" key={excerpt}>
              <blockquote className={quoteClass}>
                <MarkedText text={excerpt} />
              </blockquote>
              <details className="mt-1 text-sm">
                <summary className="cursor-pointer text-[var(--text-muted)]">
                  Read in context
                  {locations.length > 1
                    ? ` (${locations.length} passages)`
                    : ""}
                </summary>
                {locations.map((r) => (
                  <div key={r.block} className="mt-3 space-y-2">
                    <p className={secondaryText}>{r.block}</p>
                    <p>
                      <MarkedText text={r.passage} />
                    </p>
                    <GroupReferences
                      references={r.citationGroupReferences ?? []}
                    />
                  </div>
                ))}
              </details>
            </div>
          ))}
          {Boolean(intermediate.findings?.length) && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-semibold">
                What {middleLabel} reports from its own work
              </summary>
              <Findings source={intermediate} />
            </details>
          )}
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-semibold">
              Middle paper and source links
            </summary>
            <p className="mt-2 font-semibold">{intermediate.title}</p>
            <VersionLinks
              version={intermediate.version}
              url={intermediate.url}
              publicationUrl={intermediate.publicationUrl}
            />
            <SourceText
              source={intermediate}
              inPacketFullText={intermediate.textKind === "full_text"}
            />
          </details>
        </section>

        <section className={panelClass} id="descendant-evidence">
          <h2 className="text-lg font-bold">
            Where {laterLabel} cites {middleLabel}
          </h2>
          {reviewCase.evidence.map((item) => (
            <div className="mt-4 space-y-2" key={item.locator}>
              <blockquote className={quoteClass}>
                <MarkedText text={markSupportSpan(item)} focus={item.focus} />
              </blockquote>
              {!item.markerInsideSpan && (
                <p className={secondaryText}>
                  The marker is outside the extracted span.
                </p>
              )}
              <details className="text-sm">
                <summary className="cursor-pointer text-[var(--text-muted)]">
                  Read full citing paragraph
                </summary>
                <p className={secondaryText}>{item.locator}</p>
                <p className="mt-2">
                  <MarkedText text={item.paragraphWithTargetMarker} />
                </p>
              </details>
              <GroupReferences
                references={item.citationGroupReferences}
                target={item.targetReference.refId}
              />
              <p
                className={`rounded-lg bg-[var(--panel-muted)] p-3 ${secondaryText}`}
              >
                {originalCitationAtPassage(item, reviewCase, originalLabel)}
              </p>
            </div>
          ))}
          {Boolean(reviewCase.originalCitationGroup?.length) && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer">
                Passages directly citing {originalLabel}
              </summary>
              {reviewCase.originalCitationGroup?.map((g) => (
                <div key={g.locator} className="mt-3 space-y-2">
                  <p className={secondaryText}>{g.locator}</p>
                  <p>
                    <MarkedText text={g.paragraphWithTargetMarker} />
                  </p>
                  <GroupReferences references={g.citationGroupReferences} />
                </div>
              ))}
            </details>
          )}
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-semibold">
              Later paper and source links
            </summary>
            <p className="mt-2 font-semibold">{reviewCase.citingTitle}</p>
            <VersionLinks
              version={reviewCase.citingVersion}
              url={reviewCase.citingUrl}
              publicationUrl={reviewCase.citingPublicationUrl}
            />
            {reviewCase.citingText && (
              <p className="mt-2">{reviewCase.citingText}</p>
            )}
          </details>
        </section>
      </div>
    </>
  );
}

function Findings({ source }: { source: TwoHopSource }) {
  return source.findings?.map((f) => (
    <figure key={f.quote} className="my-3">
      <blockquote className="border-l-2 border-[var(--accent)] pl-3 text-sm leading-relaxed">
        {f.quote}
      </blockquote>
      <figcaption className={secondaryText}>
        {source.textKind === "excerpts" && "Source note · "}
        {f.locator}
      </figcaption>
    </figure>
  ));
}

function GroupReferences({
  references,
  target,
}: {
  references: [string, string][];
  target?: string;
}) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-[var(--text-muted)]">
        References in this group ({references.length})
      </summary>
      <ul className="mt-2 space-y-1 text-xs">
        {references.map(([id, title]) => (
          <li key={id}>
            {id === target && <strong>Middle paper · </strong>}
            {id} · {title}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TwoHopReview() {
  const [data, setData] = useState<TwoHopReviewData>();
  const [caseIndex, setCaseIndex] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function loadReview() {
      try {
        const response = await fetch("/api/two-hop-review", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Could not load the study packet.");
        const review: TwoHopReviewData = await response.json();
        const next = review.cases.findIndex(
          (item) => !review.answers[item.caseId],
        );
        setData(review);
        const requested = new URLSearchParams(window.location.search).get(
          "case",
        );
        const selected = review.cases.findIndex(
          (c) =>
            c.caseId === requested ||
            (requested !== null && c.equivalentCaseIds?.includes(requested)),
        );
        setCaseIndex(selected >= 0 ? selected : Math.max(0, next));
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load the study.",
          );
        }
      }
    }
    void loadReview();
    return () => controller.abort();
  }, [loadAttempt]);

  const hasDrafts = Object.keys(notes).length > 0;
  useEffect(() => {
    if (!hasDrafts) return;
    function preventDraftLoss(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", preventDraftLoss);
    return () => window.removeEventListener("beforeunload", preventDraftLoss);
  }, [hasDrafts]);

  const reviewCase = data?.cases[caseIndex];
  if (!data || !reviewCase) {
    return (
      <section className={panelClass}>
        <h1 className="font-[var(--font-instrument)] text-4xl">
          Two-hop citation review
        </h1>
        <p
          className={`mt-3 ${secondaryText}`}
          role={error ? "alert" : "status"}
        >
          {error ||
            (data
              ? "There are no cases in this study packet."
              : "Loading the study packet…")}
        </p>
        {error ? (
          <button
            type="button"
            className={`mt-3 ${buttonClass}`}
            onClick={() => {
              setError("");
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Retry
          </button>
        ) : null}
      </section>
    );
  }

  const { caseId } = reviewCase;
  const savedAnswer = data.answers[caseId];
  const prior = data.priorReviews[caseId];
  const paperName = (label: string) => label.replace(" et al.", "");
  const middle = paperName(
    data.sources[reviewCase.immediateSource]!.citationLabel ??
      reviewCase.immediateSource,
  );
  const original = paperName(
    data.sources[reviewCase.originalSource]!.citationLabel ??
      reviewCase.originalSource,
  );
  const later = paperName(reviewCase.citingLabel ?? reviewCase.citingTitle);
  const note = notes[caseId] ?? savedAnswer?.notes ?? "";
  const savedCount = data.cases.filter(
    (item) => data.answers[item.caseId],
  ).length;
  const nextIndex = data.cases.findIndex((item) => !data.answers[item.caseId]);
  const carriedCount = data.cases.filter(
    ({ caseId: id }) =>
      data.priorReviews[id]?.scope === "previous_chain_question" &&
      !data.revisions[id],
  ).length;

  function goTo(index: number) {
    const url = new URL(window.location.href);
    if (url.searchParams.has("case") && data?.cases[index]) {
      url.searchParams.set("case", data.cases[index].caseId);
      window.history.replaceState(window.history.state, "", url);
    }
    setCaseIndex(index);
    setNotice("");
    setError("");
    heading.current?.focus();
    window.scrollTo({ top: 0 });
  }

  async function save(chainAssessment: ChainAssessment) {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/two-hop-review", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          studyRevision: data.studyRevision,
          answer: { chainAssessment, notes: note.trim() },
          expectedRevision: data.revisions[caseId] ?? null,
        }),
      });
      if (response.status === 409) {
        throw new Error(
          "This answer was updated elsewhere. Copy your notes before reloading.",
        );
      }
      if (!response.ok)
        throw new Error("Could not save. Choose your answer again to retry.");
      const { answer, revision }: { answer: TwoHopAnswer; revision: string } =
        await response.json();
      const answers = { ...data.answers, [caseId]: answer };
      setData({
        ...data,
        answers,
        revisions: { ...data.revisions, [caseId]: revision },
      });
      setNotes((current) => {
        const updated = { ...current };
        delete updated[caseId];
        return updated;
      });
      const next = data.cases.findIndex(
        (item, index) => index > caseIndex && !answers[item.caseId],
      );
      const nextUnreviewed =
        next >= 0
          ? next
          : data.cases.findIndex((item) => !answers[item.caseId]);
      if (nextUnreviewed >= 0) goTo(nextUnreviewed);
      setNotice(
        nextUnreviewed >= 0
          ? `Saved ${caseId}.`
          : "Review complete. All answers saved.",
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save your answer.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1360px] space-y-4">
      <section className={panelClass} aria-label="Review progress">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-[var(--font-instrument)] text-4xl">
              Two-hop citation review
            </h1>
            <PaperTrail data={data} reviewCase={reviewCase} />
          </div>
          <div className="min-w-40">
            <p className="text-sm font-semibold">
              {savedCount} of {data.cases.length} saved
            </p>
            {carriedCount > 0 && (
              <p className={secondaryText}>
                {carriedCount} from the earlier question
              </p>
            )}
            <div
              aria-label="Cases saved"
              aria-valuemax={data.cases.length}
              aria-valuenow={savedCount}
              className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--panel-muted)]"
              role="progressbar"
            >
              <div
                className="h-full bg-[var(--success)]"
                style={{ width: `${(savedCount / data.cases.length) * 100}%` }}
              />
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            className={buttonClass}
            disabled={caseIndex === 0 || busy}
            onClick={() => goTo(caseIndex - 1)}
            type="button"
          >
            Previous
          </button>
          <select
            aria-label="Choose case"
            className="w-full max-w-full truncate rounded-lg border border-[var(--border-strong)] px-3 py-2 text-sm sm:w-auto sm:max-w-[26rem]"
            disabled={busy}
            value={caseIndex}
            onChange={(event) => goTo(Number(event.currentTarget.value))}
          >
            {data.cases.map((item, index) => (
              <option key={item.caseId} value={index}>
                {index + 1}. {item.study} · {item.caseId}
                {notes[item.caseId] !== undefined
                  ? " · Unsaved note"
                  : data.answers[item.caseId]
                    ? " · Saved"
                    : ""}
                {" · "}
                {propositionExcerpt(item.evidence[0]!.focus)}
              </option>
            ))}
          </select>
          <button
            className={buttonClass}
            disabled={caseIndex >= data.cases.length - 1 || busy}
            onClick={() => goTo(caseIndex + 1)}
            type="button"
          >
            Next
          </button>
          {nextIndex >= 0 && nextIndex !== caseIndex ? (
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => goTo(nextIndex)}
              type="button"
            >
              First unsaved
            </button>
          ) : null}
          <span className={secondaryText} role="status">
            {notice}
          </span>
        </div>
      </section>
      <h2
        className="text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]"
        ref={heading}
        tabIndex={-1}
      >
        Case {caseIndex + 1} of {data.cases.length} · {reviewCase.study} ·{" "}
        {caseId}
        {reviewCase.equivalentCaseIds?.length
          ? ` · also covers ${reviewCase.equivalentCaseIds.join(", ")}`
          : ""}
      </h2>
      <SourceComparison data={data} key={caseId} reviewCase={reviewCase} />
      <section aria-labelledby="assessment-title" className={panelClass}>
        <h2 className="text-xl font-bold leading-snug" id="assessment-title">
          Does {later} carry forward a finding that {middle} cites {original}{" "}
          for?
        </h2>
        <p className={`mt-2 ${secondaryText}`}>
          Compare the two passages. If the later paper accurately describes a
          separate result from the middle paper, choose “different claim”.
        </p>
        {prior && !data.revisions[caseId] && (
          <p className={`mt-3 ${secondaryText}`}>{prior.reason}</p>
        )}
        <details
          key={caseId}
          className="mt-4 text-sm"
          open={Boolean(note) || undefined}
        >
          <summary className="cursor-pointer text-[var(--text-muted)]">
            Add a note (optional)
          </summary>
          <textarea
            aria-label="Optional note"
            className="mt-2 block min-h-16 w-full rounded-xl border border-[var(--border-strong)] p-2"
            disabled={busy}
            maxLength={20000}
            value={note}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setNotes((current) => ({ ...current, [caseId]: value }));
            }}
          />
        </details>
        <div
          className="mt-4 grid gap-2 sm:grid-cols-2"
          role="group"
          aria-labelledby="assessment-title"
        >
          {chainAssessments.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={busy}
              aria-pressed={savedAnswer?.chainAssessment === choice}
              className="rounded-xl border border-[var(--border-strong)] bg-white/50 px-4 py-3 text-left text-sm font-semibold enabled:cursor-pointer enabled:hover:bg-[var(--accent-soft)] aria-pressed:border-[var(--accent)] aria-pressed:bg-[var(--accent-soft)]"
              onClick={(event) => {
                if (event.detail <= 1) void save(choice);
              }}
            >
              {answerLabels[choice]}
            </button>
          ))}
        </div>
        <p className={`mt-3 ${secondaryText}`}>
          {busy
            ? "Saving…"
            : savedCount === data.cases.length
              ? "Choose an answer to update this case."
              : "Choose an answer to save and move to the next unreviewed case."}
        </p>
        {error ? (
          <p className="mt-2 text-sm text-[var(--danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
