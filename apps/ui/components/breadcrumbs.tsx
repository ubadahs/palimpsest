import Link from "next/link";

type Crumb = {
  label: string;
  href?: string;
};

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
    >
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span className="flex items-center gap-1.5" key={crumb.label}>
            {index > 0 ? (
              <span className="select-none opacity-40">/</span>
            ) : null}
            {crumb.href && !isLast ? (
              <Link
                className="hover:text-[var(--text)] transition"
                href={crumb.href}
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={
                  isLast ? "font-semibold text-[var(--text)]" : undefined
                }
              >
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
