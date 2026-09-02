import { compareCodeUnits } from "./order.js";

import { createHash } from "node:crypto";

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

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** SHA-256 over {@link canonicalSerialize}; stable across object key order. */
export function canonicalSha256(value: unknown): string {
  return sha256Text(canonicalSerialize(value));
}

/**
 * Build a namespaced stable ID from explicitly selected semantic identity
 * inputs. Callers must keep timestamps and other observational metadata out of
 * `identityInputs`.
 */
export function buildStableId(
  namespace: string,
  identityInputs: unknown,
): string {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) {
    throw new TypeError(
      `Stable ID namespace must match ^[a-z][a-z0-9-]*$: ${namespace}`,
    );
  }
  return `${namespace}_${canonicalSha256({
    identityVersion: 1,
    identityInputs,
  })}`;
}
