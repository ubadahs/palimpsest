import type { BadgeVariant } from "@/components/ui/badge";

export const VERDICT_ORDER = [
  "supported",
  "partially_supported",
  "overstated_or_generalized",
  "not_supported",
  "cannot_determine",
] as const;

export type VerdictKey = (typeof VERDICT_ORDER)[number];

/** Alias for adjudicate filter UI (same ordering as distribution bars). */
export const VERDICT_OPTIONS = VERDICT_ORDER;

export const VERDICT_LABELS: Record<VerdictKey, string> = {
  supported: "Supported",
  partially_supported: "Partially supported",
  overstated_or_generalized: "Overstated",
  not_supported: "Not supported",
  cannot_determine: "Unclear",
};

export const VERDICT_BG_COLORS: Record<VerdictKey, string> = {
  supported: "bg-[var(--success)]",
  partially_supported: "bg-[var(--warning)]",
  overstated_or_generalized: "bg-[rgba(151,100,44,0.6)]",
  not_supported: "bg-[var(--danger)]",
  cannot_determine: "bg-[var(--border-strong)]",
};

export const VERDICT_TEXT_COLORS: Record<VerdictKey, string> = {
  supported: "text-[var(--success)]",
  partially_supported: "text-[var(--warning)]",
  overstated_or_generalized: "text-[rgba(151,100,44,0.9)]",
  not_supported: "text-[var(--danger)]",
  cannot_determine: "text-[var(--text-muted)]",
};

/** Badge styling for an adjudication verdict string. */
export function verdictBadgeVariant(verdict: string): BadgeVariant {
  if (verdict === "supported") return "success";
  if (verdict === "partially_supported") return "warning";
  if (verdict === "not_supported" || verdict === "overstated_or_generalized") {
    return "failed";
  }
  return "neutral";
}

/** Lowercase words for compact filter chips (matches prior `replaceAll("_", " ")`). */
export function formatVerdictSlug(key: VerdictKey): string {
  return key.replaceAll("_", " ");
}
