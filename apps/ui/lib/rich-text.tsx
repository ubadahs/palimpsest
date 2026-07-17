import type { JSX } from "react";

function doiUrl(doi: string): string {
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
