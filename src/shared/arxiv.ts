/**
 * Finds an arXiv identifier in a reference string, URL, or DOI and returns it
 * without its version suffix: `arXiv:1806.10165v2`, `arxiv.org/pdf/1806.10165`
 * and `10.48550/arXiv.1806.10165` all give `1806.10165`. Old-style identifiers
 * keep their archive, e.g. `astro-ph/9904188`.
 */
export function parseArxivId(text: string): string | undefined {
  const match =
    /(?:arxiv[:.]\s*|arxiv\.org\/(?:abs|pdf)\/)((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}))(?:v\d+)?/i.exec(
      text,
    );
  return match?.[1]?.toLowerCase();
}
