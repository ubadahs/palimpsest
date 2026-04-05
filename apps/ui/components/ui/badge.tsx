import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type BadgeVariant =
  | "neutral"
  | "running"
  | "success"
  | "failed"
  | "stale"
  | "warning";

const variants: Record<BadgeVariant, string> = {
  neutral: "bg-[var(--panel-muted)] text-[var(--text-muted)]",
  running: "bg-[rgba(155,92,65,0.12)] text-[var(--accent)]",
  success: "bg-[rgba(47,111,79,0.12)] text-[var(--success)]",
  failed: "bg-[rgba(154,64,54,0.12)] text-[var(--danger)]",
  stale: "bg-[rgba(151,100,44,0.12)] text-[var(--warning)]",
  warning: "bg-[rgba(151,100,44,0.12)] text-[var(--warning)]",
};

export function Badge({
  className,
  variant = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
