/** Convert code-point offsets returned by Python into exact JavaScript UTF-16 offsets. */
export function pythonSpanToJs(
  context: string,
  start: number,
  end: number,
): { start: number; end: number; text: string } {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  )
    throw new Error("Invalid span offsets");
  const points = Array.from(context);
  if (end > points.length) throw new Error("Span offset exceeds context");
  const jsStart = points.slice(0, start).join("").length;
  const jsEnd = points.slice(0, end).join("").length;
  return { start: jsStart, end: jsEnd, text: context.slice(jsStart, jsEnd) };
}

export function validateJsSpan(
  context: string,
  span: { start: number; end: number; text?: string },
): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end <= context.length &&
    (span.text == null || context.slice(span.start, span.end) === span.text)
  );
}

/** Resolve a verbatim model quote without guessing among repeated occurrences. */
export function resolveExactQuote(
  context: string,
  quote: string,
  before?: string,
  after?: string,
): { start: number; end: number; text: string } {
  if (!quote) throw new Error("Empty quote");
  const matches: number[] = [];
  for (
    let offset = context.indexOf(quote);
    offset >= 0;
    offset = context.indexOf(quote, offset + 1)
  ) {
    if (before != null && !context.slice(0, offset).endsWith(before)) continue;
    if (
      after != null &&
      !context.slice(offset + quote.length).startsWith(after)
    )
      continue;
    matches.push(offset);
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Quote is ambiguous in context"
        : "Quote does not occur verbatim in context",
    );
  return { start: matches[0]!, end: matches[0]! + quote.length, text: quote };
}
