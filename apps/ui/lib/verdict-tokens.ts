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
