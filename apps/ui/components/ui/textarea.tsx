import type { TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-28 w-full rounded-[18px] border border-[var(--border)] bg-white/70 px-4 py-3 text-sm leading-6 text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--border-strong)] focus:bg-white",
        className,
      )}
      {...props}
    />
  );
}
