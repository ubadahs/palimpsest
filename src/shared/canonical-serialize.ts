/**
 * Canonical JSON serialization and the string order it depends on.
 *
 * This module has no Node dependencies on purpose: the UI imports contract
 * schemas into browser bundles, and those need deterministic ordering without
 * dragging `node:crypto` along. Hashing lives in `stable-identity.ts`.
 */
/**
 * Code-unit string comparison. `localeCompare` depends on the process locale
 * and ICU version, so every content-hashed artifact orders strings with this.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Serialize JSON-compatible data with recursively sorted object keys.
 *
 * Object properties whose value is `undefined` are omitted, matching JSON
 * serialization. `undefined` array entries and non-JSON values are rejected so
 * callers cannot accidentally assign identities to data that will serialize
 * differently on disk.
 */
export function canonicalSerialize(value: unknown): string {
  return serializeCanonicalValue(value, "$");
}

function serializeCanonicalValue(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number is not canonical JSON at ${path}`);
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value
      .map((entry, index) => {
        if (entry === undefined) {
          throw new TypeError(
            `Undefined array entry is not canonical JSON at ${path}[${String(index)}]`,
          );
        }
        return serializeCanonicalValue(entry, `${path}[${String(index)}]`);
      })
      .join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object is not canonical JSON at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Symbol keys are not canonical JSON at ${path}`);
    }

    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${serializeCanonicalValue(entry, `${path}.${key}`)}`,
      )
      .join(",")}}`;
  }

  throw new TypeError(`Unsupported canonical JSON value at ${path}`);
}
