import { canonicalSerialize } from "./stable-identity.js";

/**
 * Deterministic ordering and deduplication for artifact content.
 *
 * Every canonical artifact is content-hashed, so any list inside one must be
 * ordered the same way on every machine. `localeCompare` is not: it depends on
 * the process locale and on ICU version. Code-unit comparison is.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deduplicate by canonical serialization, then order by that serialization. */
export function uniqueSorted<T>(values: readonly T[]): T[] {
  const byCanonicalValue = new Map<string, T>();
  for (const value of values) {
    byCanonicalValue.set(canonicalSerialize(value), value);
  }
  return [...byCanonicalValue.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, value]) => value);
}

/**
 * Deduplicate by an explicit identity, keeping the last value seen for each.
 * Use when two values are the same record even though their content differs.
 */
export function uniqueSortedById<T>(
  values: readonly T[],
  getId: (value: T) => string,
): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    byId.set(getId(value), value);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, value]) => value);
}

/** Distinct strings in code-unit order. */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}
