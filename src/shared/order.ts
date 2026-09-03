import { canonicalSerialize, compareCodeUnits } from "./canonical-serialize.js";

/**
 * Deterministic ordering and deduplication for artifact content.
 *
 * Every canonical artifact is content-hashed, so any list inside one must be
 * ordered the same way on every machine. `compareCodeUnits` lives next to the
 * canonical serializer, which has no Node dependencies, so browser bundles
 * can import this module without pulling in hashing.
 */
export { compareCodeUnits };

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
