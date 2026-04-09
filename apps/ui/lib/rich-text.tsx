import type { JSX } from "react";

const SAFE_TAG_RE = /^(i|em|b|strong|sub|sup|br|span)$/i;

/**
 * Strip all HTML except a whitelist of safe inline formatting tags.
 * Attributes are removed entirely to prevent injection.
 */
function sanitizeInlineHtml(html: string): string {
  return html.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g,
    (_match, slash: string, tag: string) => {
      if (!SAFE_TAG_RE.test(tag)) return "";
      const lower = tag.toLowerCase();
      return slash ? `</${lower}>` : `<${lower}>`;
    },
  );
}

/**
 * Render text that may contain safe inline HTML (e.g. `<i>`, `<em>`,
 * `<sub>`, `<sup>`) such as scientific species names in paper titles.
 * Falls back to plain text when no markup is detected.
 */
export function RichText({
  html,
  className,
  as: Tag = "span",
}: {
  html: string;
  className?: string;
  as?: "span" | "p" | "div";
}): JSX.Element {
  const clean = sanitizeInlineHtml(html);
  if (!/<[a-z]/i.test(clean)) {
    return <Tag className={className}>{html}</Tag>;
  }
  return (
    <Tag className={className} dangerouslySetInnerHTML={{ __html: clean }} />
  );
}

/** Build a resolvable DOI URL. */
export function doiUrl(doi: string): string {
  return `https://doi.org/${encodeURIComponent(doi)}`;
}

/** Render a DOI as an external hyperlink. */
export function DoiLink({
  doi,
  className,
  children,
}: {
  doi: string;
  className?: string;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <a
      href={doiUrl(doi)}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "text-[var(--accent)] hover:underline"}
    >
      {children ?? doi}
    </a>
  );
}
