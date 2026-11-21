/**
 * Finds an arXiv identifier in a reference string, URL, or DOI and returns it
 * without its version suffix: `arXiv:2101.12345v2`, `arxiv.org/pdf/2101.12345`
 * and `10.48550/arXiv.2101.12345` all give `2101.12345`. Old-style identifiers
 * keep their archive, e.g. `astro-ph/9904188`.
 */
export function parseArxivId(text: string): string | undefined {
  return parseArxivIdentifier(text)?.id;
}

function parseArxivIdentifier(
  text: string,
): { id: string; identifier: string } | undefined {
  const match =
    /(?:arxiv[:.]\s*|arxiv\.org\/(?:abs|pdf|html)\/)((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}))(v[1-9]\d*)?(?![a-z0-9])/i.exec(
      text,
    );
  const id = match?.[1]?.toLowerCase();
  return id
    ? { id, identifier: id + (match?.[2]?.toLowerCase() ?? "") }
    : undefined;
}

/** An arXiv identifier from a DOI, with any supplied revision intact. */
export function parseArxivDoi(doi: string | undefined) {
  const identifier = doi?.match(
    /^(?:https?:\/\/doi\.org\/)?10\.48550\/arxiv\.(.+)$/i,
  )?.[1];
  return identifier ? parseBareArxivIdentifier(identifier) : undefined;
}

export function parseBareArxivIdentifier(identifier: string) {
  const result = parseArxivIdentifier("arXiv:" + identifier);
  return result?.identifier === identifier.toLowerCase() ? result : undefined;
}
