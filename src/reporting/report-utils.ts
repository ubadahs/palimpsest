import type { Confidence } from "../domain/types.js";

export function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + "…" : s;
}

export const CONFIDENCE_SORT_ORDER: Record<Confidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
