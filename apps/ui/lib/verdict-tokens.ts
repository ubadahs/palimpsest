import type { BadgeVariant } from "@/components/ui/badge";

export const VERDICT_ORDER = ["F", "D", "E", "U"] as const;

export type VerdictKey = (typeof VERDICT_ORDER)[number];

export const VERDICT_LABELS: Record<VerdictKey, string> = {
  F: "Faithful",
  D: "Distortion",
  E: "Error",
  U: "Uncertain",
};

export const VERDICT_BG_COLORS: Record<VerdictKey, string> = {
  F: "bg-[var(--success)]",
  D: "bg-[var(--danger)]",
  E: "bg-[rgba(151,100,44,0.6)]",
  U: "bg-[var(--border-strong)]",
};

export const VERDICT_TEXT_COLORS: Record<VerdictKey, string> = {
  F: "text-[var(--success)]",
  D: "text-[var(--danger)]",
  E: "text-[rgba(151,100,44,0.9)]",
  U: "text-[var(--text-muted)]",
};

/** Badge styling for an adjudication verdict string. */
export function verdictBadgeVariant(verdict: string): BadgeVariant {
  if (verdict === "F") return "success";
  if (verdict === "D" || verdict === "E") {
    return "failed";
  }
  return "neutral";
}

/** Lowercase words for compact filter chips (matches prior `replaceAll("_", " ")`). */
export function formatVerdictSlug(key: VerdictKey): string {
  return key.replaceAll("_", " ");
}
