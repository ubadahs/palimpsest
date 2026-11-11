type Run = { text: string; judged: boolean };

/**
 * Splits citing text into the runs a reviewer is asked to judge and the
 * context around them. Judged text is what the adjudicator is pointed at: the
 * sentences the pipeline wrapped in ▶ … ◀, and each claim's source text, which
 * can sit in a neighbouring sentence that does not name the cited paper.
 */
function passageRuns(marked: string, claimSources: readonly string[]): Run[] {
  let plain = "";
  const ranges: [start: number, end: number][] = [];
  marked.split(/▶\s?|\s?◀/).forEach((part, index) => {
    if (index % 2 === 1)
      ranges.push([plain.length, plain.length + part.length]);
    plain += part;
  });
  for (const source of claimSources) {
    const start = plain.indexOf(source);
    if (start >= 0) ranges.push([start, start + source.length]);
  }

  const judged: [start: number, end: number][] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = judged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else judged.push([start, end]);
  }

  const runs: Run[] = [];
  let cursor = 0;
  for (const [start, end] of judged) {
    if (start > cursor)
      runs.push({ text: plain.slice(cursor, start), judged: false });
    runs.push({ text: plain.slice(start, end), judged: true });
    cursor = end;
  }
  if (cursor < plain.length)
    runs.push({ text: plain.slice(cursor), judged: false });
  return runs;
}

/** Citing text with everything the reviewer is asked to judge highlighted. */
export function MarkedPassage({
  text,
  claimSources,
}: {
  text: string;
  claimSources: readonly string[];
}) {
  return (
    <p className="whitespace-pre-wrap">
      {passageRuns(text, claimSources).map((run, index) =>
        run.judged ? (
          <mark
            className="rounded-[4px] bg-[rgba(224,176,72,0.35)] px-0.5 text-[var(--text)]"
            key={index}
          >
            {run.text}
          </mark>
        ) : (
          <span className="text-[var(--text-muted)]" key={index}>
            {run.text}
          </span>
        ),
      )}
    </p>
  );
}
