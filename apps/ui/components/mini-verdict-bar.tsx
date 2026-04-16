import type { RunVerdictSummary } from "palimpsest/contract";

import { VERDICT_BG_COLORS, VERDICT_ORDER } from "@/lib/verdict-tokens";

export function MiniVerdictBar({ summary }: { summary: RunVerdictSummary }) {
  if (summary.total === 0) {
    return null;
  }

  return (
    <div
      className="flex h-1.5 w-full max-w-md gap-px overflow-hidden rounded-full"
      role="img"
      aria-label="Adjudication verdict distribution"
    >
      {VERDICT_ORDER.map((v) => {
        const count = summary[v];
        if (count === 0) return null;
        const pct = (count / summary.total) * 100;
        return (
          <div
            key={v}
            className={`h-full min-w-[2px] ${VERDICT_BG_COLORS[v]}`}
            style={{ width: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}
