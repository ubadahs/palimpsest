import Link from "next/link";

/** A set of cases to grade, with how far the reviewer has got. */
export function QueueCard({
  href,
  title,
  purpose,
  done,
  total,
}: {
  href: string;
  title: string;
  purpose: string;
  done: number;
  total: number;
}) {
  const action =
    total === 0
      ? "Nothing to grade"
      : done === 0
        ? "Start"
        : done < total
          ? "Continue"
          : "Review answers";
  return (
    <Link
      className="flex flex-wrap items-center justify-between gap-4 rounded-[24px] border border-[var(--border)] bg-white p-5 transition hover:border-[var(--border-strong)] hover:bg-[var(--panel-strong)]"
      href={href}
    >
      <div className="min-w-0 max-w-2xl">
        <p className="text-lg font-semibold text-[var(--text)]">{title}</p>
        <p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">
          {purpose}
        </p>
      </div>
      <div className="w-full max-w-[220px] space-y-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-[var(--text-muted)]">
            {done} of {total} graded
          </span>
          <span className="font-semibold text-[var(--accent)]">{action} →</span>
        </div>
        <div
          aria-hidden="true"
          className="h-2 overflow-hidden rounded-full bg-[var(--panel-muted)]"
        >
          <div
            className="h-full rounded-full bg-[var(--success)]"
            style={{ width: `${String(total ? (100 * done) / total : 0)}%` }}
          />
        </div>
      </div>
    </Link>
  );
}
