"use client";

import { useRef, type ReactNode } from "react";
import type { BlindEvaluationCase } from "palimpsest/evaluation";

import { cn } from "@/lib/utils";

import { GRADE_CHOICES, type Draft } from "./drafts";
import { MarkedPassage } from "./marked-passage";

type CaseOf<T extends BlindEvaluationCase["task"]> = Extract<
  BlindEvaluationCase,
  { task: T }
>;
type DraftOf<T extends Draft["task"]> = Extract<Draft, { task: T }>;

function Part({
  label,
  title,
  children,
}: {
  label: string;
  /** The paper or section the part comes from, when that helps. */
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section>
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
        {label}
      </h4>
      {title ? (
        <p className="mt-1 text-sm font-semibold text-[var(--text)]">{title}</p>
      ) : null}
      <div className="mt-2 text-[15px] leading-7 text-[var(--text)]">
        {children}
      </div>
    </section>
  );
}

function Claims({ claims }: { claims: readonly string[] }) {
  return (
    <ul className="space-y-1">
      {claims.map((claim) => (
        <li className="flex gap-2" key={claim}>
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            •
          </span>
          <span>{claim}</span>
        </li>
      ))}
    </ul>
  );
}

function AdjudicationBody({ item }: { item: CaseOf<"adjudication"> }) {
  const { packet } = item;
  return (
    <>
      <Part label="The citing paper" title={packet.citingPaperTitle}>
        <MarkedPassage
          claimSources={packet.occurrenceClaims.flatMap(
            (claim) => claim.supportSpanText ?? [],
          )}
          text={packet.markedCitingContext}
        />
      </Part>
      {packet.occurrenceClaims.length ? (
        <Part label="What it says the cited paper showed">
          <Claims
            claims={packet.occurrenceClaims.map((claim) => claim.claimText)}
          />
        </Part>
      ) : null}
      <Part label="The cited paper" title={packet.citedPaperTitle}>
        <ol className="space-y-3">
          {packet.selectedChunks.map((chunk, index) => (
            <li
              className="rounded-[14px] border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-3 text-sm leading-6"
              key={chunk.chunkId}
            >
              <span className="mr-2 font-semibold text-[var(--text-muted)]">
                {index + 1}
              </span>
              {chunk.text}
            </li>
          ))}
        </ol>
      </Part>
    </>
  );
}

function RoleBody({ item }: { item: CaseOf<"role"> }) {
  return (
    <>
      <Part label="The citing text" title={item.sectionTitle}>
        <p className="whitespace-pre-wrap">{item.context}</p>
      </Part>
      <Part
        label={
          item.seedRefLabel
            ? `What it attributes to ${item.seedRefLabel}`
            : "What it attributes to the cited paper"
        }
      >
        <Claims claims={item.claims} />
      </Part>
    </>
  );
}

function RerankBody({
  item,
  draft,
  onChange,
}: {
  item: CaseOf<"rerank">;
  draft: DraftOf<"rerank">;
  onChange: (draft: Draft) => void;
}) {
  const next = item.candidates.find(
    (candidate) => !draft.grades[candidate.chunkId],
  );
  return (
    <>
      <Part label="Claim">{item.query}</Part>
      <Part label="Passages from the cited paper">
        <ol className="space-y-3">
          {item.candidates.map((candidate, index) => (
            <li
              className={cn(
                "rounded-[14px] border px-4 py-3 text-sm leading-6",
                candidate === next
                  ? "border-[var(--accent)] bg-white"
                  : "border-[var(--border)] bg-[var(--panel-strong)]",
              )}
              key={candidate.chunkId}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-semibold text-[var(--text-muted)]">
                  {index + 1}
                </span>
                {GRADE_CHOICES.map((choice) => (
                  <button
                    aria-pressed={
                      draft.grades[candidate.chunkId] === choice.value
                    }
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-semibold transition",
                      draft.grades[candidate.chunkId] === choice.value
                        ? "border-[var(--text)] bg-[var(--text)] text-white"
                        : "border-[var(--border)] bg-white text-[var(--text-muted)] hover:border-[var(--border-strong)]",
                    )}
                    key={choice.value}
                    onClick={() =>
                      onChange({
                        ...draft,
                        grades: {
                          ...draft.grades,
                          [candidate.chunkId]: choice.value,
                        },
                      })
                    }
                    type="button"
                  >
                    {choice.name}
                  </button>
                ))}
              </div>
              {candidate.text}
            </li>
          ))}
        </ol>
      </Part>
    </>
  );
}

function SpanBody({
  item,
  draft,
  onChange,
}: {
  item: CaseOf<"span">;
  draft: DraftOf<"span">;
  onChange: (draft: Draft) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <Part label="Claim">{item.claim}</Part>
      <Part label="Citing text: select the words that carry the claim">
        <textarea
          className="h-64 w-full rounded-[14px] border border-[var(--border)] bg-white p-4 text-sm leading-6 outline-none"
          onMouseUp={() => {
            const { selectionStart: start, selectionEnd: end } =
              field.current ?? { selectionStart: 0, selectionEnd: 0 };
            if (end > start)
              onChange({
                ...draft,
                noValidSpan: false,
                spans: [...draft.spans, { start, end }],
              });
          }}
          readOnly
          ref={field}
          value={item.context}
        />
      </Part>
    </>
  );
}

/** Everything a reviewer reads to answer one case. */
export function CaseBody({
  item,
  draft,
  onChange,
}: {
  item: BlindEvaluationCase;
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  if (item.task === "adjudication") return <AdjudicationBody item={item} />;
  if (item.task === "role") return <RoleBody item={item} />;
  if (item.task === "rerank" && draft.task === "rerank")
    return <RerankBody draft={draft} item={item} onChange={onChange} />;
  if (item.task === "span" && draft.task === "span")
    return <SpanBody draft={draft} item={item} onChange={onChange} />;
  return null;
}
