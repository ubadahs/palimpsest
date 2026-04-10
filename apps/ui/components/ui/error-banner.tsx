import type { ReactNode } from "react";

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-[rgba(154,64,54,0.2)] bg-[rgba(154,64,54,0.06)] px-5 py-4 text-sm text-[var(--danger)]">
      {children}
    </div>
  );
}
